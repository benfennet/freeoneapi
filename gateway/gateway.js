#!/usr/bin/env node
// freeoneapi 本地网关：单文件，零依赖，Node 18+。
// 用法：同目录建 .env（填 FREEONEAPI_KEYS），然后 node gateway.js。
// 默认只绑 127.0.0.1:8080，只给本机用。key 只进 .env，绝不进代码和仓库。
// 设计见 ../DESIGN.md。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = 'v1';
const DEFAULT_PROVIDERS_URL = 'https://benfennet.github.io/freeoneapi/providers.json';
const BODY_LIMIT = 20 * 1024 * 1024; // 请求体上限 20MB，写代码的长提示也够

// ---------- .env：只读，不覆盖真实环境变量；不展开变量；不记 key ----------
function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) process.env[key] = val;
      }
      return file;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return null;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    console.error(`[freeoneapi] ${name} 不是合法 JSON，已忽略：${e.message}`);
    return fallback;
  }
}

// ---------- 配置 ----------
loadDotEnv();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8080', 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10);
const PROVIDERS_URL = process.env.PROVIDERS_URL || DEFAULT_PROVIDERS_URL;
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const KEYS = parseJsonEnv('FREEONEAPI_KEYS', {});
const MODEL_ROUTES = parseJsonEnv('MODEL_ROUTES', {});

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOCAL_HOSTS.has(HOST) && !GATEWAY_KEY) {
  console.error('[freeoneapi] 拒绝启动：监听非本机地址必须设 GATEWAY_KEY，否则 baseUrl 泄露即成敞开代理。');
  console.error('[freeoneapi] 要么把 HOST 改回 127.0.0.1，要么在 .env 里设 GATEWAY_KEY。');
  process.exit(1);
}

// ---------- 库：启动时拉一次，拉不到就报错退出，不带过期数据硬跑 ----------
async function loadProviders() {
  let data;
  if (/^https?:\/\//.test(PROVIDERS_URL)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(PROVIDERS_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } else {
    const tries = [PROVIDERS_URL, path.join(__dirname, PROVIDERS_URL), path.join(process.cwd(), PROVIDERS_URL)];
    let lastErr = null;
    for (const f of tries) {
      try {
        data = JSON.parse(fs.readFileSync(f, 'utf8'));
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!data) throw lastErr;
  }
  if (!data || !Array.isArray(data.providers)) throw new Error('providers.json 格式不对：缺 providers 数组');
  return data.providers;
}

// 模型 id -> 源 id 列表（按库里顺序）。动态源（free_models 不是数组）不在表里。
function buildModelMap(providers) {
  const map = new Map();
  for (const p of providers) {
    if (!Array.isArray(p.free_models)) continue;
    for (const m of p.free_models) {
      if (!map.has(m)) map.set(m, []);
      if (!map.get(m).includes(p.id)) map.get(m).push(p.id);
    }
  }
  return map;
}

let PROVIDERS = [];
let PROVIDER_BY_ID = new Map();
let MODEL_MAP = new Map();

function modelsList() {
  const data = [];
  for (const [model, ids] of MODEL_MAP) {
    data.push({ id: model, object: 'model', owned_by: ids[0] });
  }
  return { object: 'list', data };
}

// ---------- 工具 ----------
function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  }, extraHeaders || {}));
  res.end(body);
}

function errObj(message, failures) {
  const e = { message, type: 'freeoneapi_error', code: 'all_sources_failed' };
  if (failures) e.failures = failures;
  return { error: e };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(Object.assign(new Error('请求体超过 20MB'), { status: 413 }));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!GATEWAY_KEY) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${GATEWAY_KEY}`;
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 路由：返回候选源 id 列表（已按顺序），或 { error }。
function routeCandidates(model) {
  if (MODEL_MAP.has(model)) return { candidates: MODEL_MAP.get(model) };
  if (model.endsWith(':free')) {
    // OpenRouter 免费模型：id 本身带 :free 后缀，原样发过去
    if (PROVIDER_BY_ID.has('openrouter')) return { candidates: ['openrouter'] };
    return { error: '模型带 :free 后缀，应走 OpenRouter，但你没在库里找到 openrouter（库可能已更新，重启网关重拉）。' };
  }
  if (MODEL_ROUTES[model] && PROVIDER_BY_ID.has(MODEL_ROUTES[model])) {
    return { candidates: [MODEL_ROUTES[model]] };
  }
  return { error: `模型 ${model} 不在免费库里。请 GET /v1/models 看静态免费模型，动态源的模型在 .env 里用 MODEL_ROUTES 指定。` };
}

// ---------- POST /v1/chat/completions ----------
async function handleChat(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
  }
  const model = body.model;
  const stream = body.stream === true;
  if (!model || typeof model !== 'string') {
    return sendJson(res, 400, { error: { message: '缺 model 字段', type: 'invalid_request', code: 'missing_model' } });
  }
  if (!Array.isArray(body.messages)) {
    return sendJson(res, 400, { error: { message: '缺 messages 数组', type: 'invalid_request', code: 'missing_messages' } });
  }

  const routed = routeCandidates(model);
  if (routed.error) return sendJson(res, 404, { error: { message: routed.error, type: 'invalid_request', code: 'model_not_in_library' } });

  const withKey = routed.candidates.filter((id) => KEYS[id]);
  if (withKey.length === 0) {
    return sendJson(res, 401, { error: {
      message: `模型 ${model} 对应的源（${routed.candidates.join('、')}）都没配 key。请在 .env 的 FREEONEAPI_KEYS 里加上对应源的 key，重启网关。`,
      type: 'auth_error', code: 'no_key_for_provider',
    } });
  }

  const failures = [];
  let tried = 0;
  for (const pid of withKey) {
    tried++;
    const provider = PROVIDER_BY_ID.get(pid);
    const url = provider.base_url.replace(/\/$/, '') + '/chat/completions';
    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${KEYS[pid]}`,
    };
    // OpenRouter 建议带 Referer 与标题（用于识别，不影响计费）
    if (pid === 'openrouter') {
      headers['http-referer'] = 'https://github.com/benfennet/freeoneapi';
      headers['x-title'] = 'freeoneapi';
    }
    let upstream;
    try {
      upstream = await fetchWithTimeout(url, { method: 'POST', headers, body: rawBody }, TIMEOUT_MS);
    } catch (e) {
      failures.push({ provider: pid, reason: e.message === 'timeout' ? `超时（${TIMEOUT_MS}ms 未响应）` : `网络错误：${e.message}` });
      continue;
    }
    if (!upstream.ok) {
      let detail = '';
      try { detail = (await upstream.text()).slice(0, 300); } catch (e) { /* 忽略 */ }
      failures.push({ provider: pid, reason: `HTTP ${upstream.status}${detail ? `：${detail}` : ''}` });
      continue;
    }

    const failover = tried > 1 ? 'true' : 'false';
    const meta = {
      'x-freeoneapi-provider': pid,
      'x-freeoneapi-model': model,
      'x-freeoneapi-failover': failover,
    };
    if (!stream) {
      const text = await upstream.text();
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, meta));
      res.end(text);
      log(`POST /v1/chat/completions model=${model} provider=${pid} failover=${failover} status=200`);
      return;
    }

    // 流式：等到第一个 chunk 才算成功，之前失败还能换家；之后失败只能明示截断。
    const reader = upstream.body.getReader();
    let first;
    try {
      first = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
      ]);
    } catch (e) {
      try { reader.cancel(); } catch (_) { /* 忽略 */ }
      failures.push({ provider: pid, reason: e.message === 'timeout' ? `流式首包超时（${TIMEOUT_MS}ms）` : `流式读取失败：${e.message}` });
      continue;
    }
    if (first.done) {
      // 源直接结束了，没内容：当失败，换家
      failures.push({ provider: pid, reason: '流式空响应' });
      continue;
    }
    res.writeHead(200, Object.assign({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    }, meta));
    res.write(Buffer.from(first.value));
    log(`POST /v1/chat/completions stream model=${model} provider=${pid} failover=${failover} status=200`);
    let aborted = false;
    req.on('close', () => { aborted = true; try { reader.cancel(); } catch (_) { /* 忽略 */ } });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      // 中途断了：明示错误，不静默截断成完整回答
      try {
        res.write(`data: ${JSON.stringify({ error: { message: `流式中途断开（源 ${pid}）：${e.message}，回答不完整，请重发`, type: 'stream_error', code: 'mid_stream_failure' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (_) { /* 客户端已断开，忽略 */ }
    }
    return;
  }

  // 候选源全失败
  const last = failures[failures.length - 1];
  log(`POST /v1/chat/completions model=${model} status=502 tried=${tried} last=${last ? last.reason : '无'}`);
  return sendJson(res, 502, errObj(
    `免费源全失败（试了 ${tried} 家）：` + failures.map((f) => `${f.provider}（${f.reason}）`).join('；') + '。请检查 key 或等额度重置。',
    failures
  ));
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname === '/' && req.method === 'GET') {
      return sendJson(res, 200, {
        service: 'freeoneapi-local',
        version: VERSION,
        providers: PROVIDERS.length,
        models: MODEL_MAP.size,
        host: HOST,
        port: PORT,
      });
    }
    if (u.pathname === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, modelsList());
    }
    if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!checkAuth(req)) {
        return sendJson(res, 401, { error: { message: '网关密钥不对或缺失（Authorization: Bearer <GATEWAY_KEY>）', type: 'auth_error', code: 'bad_gateway_key' } });
      }
      const rawBody = await readBody(req);
      await handleChat(req, res, rawBody);
      return;
    }
    if (u.pathname === '/v1/chat/completions') {
      return sendJson(res, 405, { error: { message: '只支持 POST', type: 'invalid_request', code: 'method_not_allowed' } });
    }
    return sendJson(res, 404, { error: { message: `未知路径 ${u.pathname}`, type: 'invalid_request', code: 'not_found' } });
  } catch (e) {
    const status = e.status || 500;
    log(`${req.method} ${u.pathname} status=${status} error=${e.message} ${Date.now() - started}ms`);
    if (!res.headersSent) {
      sendJson(res, status, { error: { message: e.message || '网关内部错误', type: 'server_error', code: 'internal' } });
    } else {
      try { res.end(); } catch (_) { /* 忽略 */ }
    }
  }
});

// ---------- 启动 ----------
(async () => {
  try {
    PROVIDERS = await loadProviders();
  } catch (e) {
    console.error(`[freeoneapi] 启动失败：拉不到库（${PROVIDERS_URL}）：${e.message}`);
    console.error('[freeoneapi] 检查网络，或用 PROVIDERS_URL 指向本地 providers.json 文件路径，重启。');
    process.exit(1);
  }
  PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
  MODEL_MAP = buildModelMap(PROVIDERS);
  const keyed = PROVIDERS.filter((p) => KEYS[p.id]).map((p) => p.id);
  server.listen(PORT, HOST, () => {
    console.log(`[freeoneapi] 本地网关已启动：http://${HOST}:${PORT}/v1`);
    console.log(`[freeoneapi] 库：${PROVIDERS.length} 家源，${MODEL_MAP.size} 个静态免费模型`);
    if (keyed.length > 0) {
      console.log(`[freeoneapi] 已配 key 的源：${keyed.join('、')}（只显示源名，不显示 key）`);
    } else {
      console.log('[freeoneapi] 未配任何 key：先用 GET /v1/models 看模型，配好 key（.env 的 FREEONEAPI_KEYS）后重启。');
    }
    if (GATEWAY_KEY) console.log('[freeoneapi] 已启用网关密钥鉴权。');
    else if (LOCAL_HOSTS.has(HOST)) console.log('[freeoneapi] 本机监听，未设网关密钥（本机隔离就是保护）。');
  });
})();
