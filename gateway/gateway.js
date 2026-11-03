#!/usr/bin/env node
// freeoneapi 本地网关：单文件，零依赖，Node 18+。
// 用法：同目录建 .env（填 FREEONEAPI_KEYS），然后 node gateway.js。
// 默认只绑 127.0.0.1:8080，只给本机用。key 只进 .env，绝不进代码和仓库。
// 管理页：http://127.0.0.1:8080/ui（填 key、看状态、测试、看日志、复制 opencode 配置）。
// 设计见 ../DESIGN.md。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'v1';
const DEFAULT_PROVIDERS_URL = 'https://benfennet.github.io/freeoneapi/providers.json';
const BODY_LIMIT = 20 * 1024 * 1024; // 请求体上限 20MB，写代码的长提示也够
const LOG_MAX = 100;

// ---------- .env：只读，不覆盖真实环境变量；不展开变量；不记 key ----------
let loadedEnvFile = null;
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
      loadedEnvFile = file;
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

// 管理 token：设了网关密钥就用它；没设（本机）就每启动随机一个，只印在控制台。
const ADMIN_TOKEN = GATEWAY_KEY || crypto.randomBytes(16).toString('hex');
const IS_LOCAL = LOCAL_HOSTS.has(HOST);
const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);
let STARTED_AT = '';

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

// ---------- 请求日志：只记元数据（时间、模型、源、状态、耗时），不记 key、不记请求体 ----------
const LOGS = [];
function pushLog(entry) {
  entry.t = new Date().toISOString();
  LOGS.push(entry);
  while (LOGS.length > LOG_MAX) LOGS.shift();
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

function checkAdmin(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${ADMIN_TOKEN}`;
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl 等非浏览器请求无 Origin，靠 token 鉴权
  return ALLOWED_ORIGINS.has(origin);
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
async function handleChat(req, res, rawBody, ctx) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
  }
  const model = body.model;
  const stream = body.stream === true;
  ctx.model = typeof model === 'string' ? model : '';
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
      message: `模型 ${model} 对应的源（${routed.candidates.join('、')}）都没配 key。请在管理页（/ui）或 .env 的 FREEONEAPI_KEYS 里加上对应源的 key（管理页保存即生效，不用重启）。`,
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
    ctx.provider = pid;
    ctx.failover = failover;
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

// ---------- 管理页：key 持久化（只改 FREEONEAPI_KEYS 一行，其余行原样保留） ----------
function saveEnvKeys() {
  const file = loadedEnvFile || path.join(__dirname, '.env');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const newLine = 'FREEONEAPI_KEYS=' + JSON.stringify(KEYS);
  const lines = text ? text.split(/\r?\n/) : [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('FREEONEAPI_KEYS=')) {
      lines[i] = newLine;
      found = true;
      break;
    }
  }
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(newLine);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  loadedEnvFile = file;
}

function adminStatus() {
  return {
    service: 'freeoneapi-local',
    version: VERSION,
    host: HOST,
    port: PORT,
    startedAt: STARTED_AT,
    gatewayAuth: !!GATEWAY_KEY,
    models: MODEL_MAP.size,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      hasKey: !!KEYS[p.id],
      models: Array.isArray(p.free_models) ? p.free_models : 'dynamic',
      key_url: p.key_url || '',
    })),
  };
}

async function handleAdminTest(bodyJson) {
  const providerId = bodyJson.provider;
  const model = bodyJson.model;
  const provider = PROVIDER_BY_ID.get(providerId);
  if (!provider) return { status: 400, body: { error: { message: `未知源 ${providerId}`, type: 'invalid_request', code: 'unknown_provider' } } };
  if (!KEYS[providerId]) return { status: 401, body: { error: { message: `源 ${providerId} 没配 key`, type: 'auth_error', code: 'no_key_for_provider' } } };
  if (!model || typeof model !== 'string') return { status: 400, body: { error: { message: '缺 model 字段', type: 'invalid_request', code: 'missing_model' } } };
  if (Array.isArray(provider.free_models) && !provider.free_models.includes(model)) {
    return { status: 400, body: { error: { message: `模型 ${model} 不在源 ${providerId} 的免费清单里`, type: 'invalid_request', code: 'model_not_in_provider' } } };
  }
  const url = provider.base_url.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${KEYS[providerId]}`,
  };
  if (providerId === 'openrouter') {
    headers['http-referer'] = 'https://github.com/benfennet/freeoneapi';
    headers['x-title'] = 'freeoneapi';
  }
  const started = Date.now();
  try {
    const upstream = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    }, TIMEOUT_MS);
    const text = await upstream.text();
    const ms = Date.now() - started;
    if (upstream.ok) return { status: 200, body: { ok: true, provider: providerId, model, ms, status: upstream.status } };
    return { status: 200, body: { ok: false, provider: providerId, model, ms, status: upstream.status, detail: text.slice(0, 300) } };
  } catch (e) {
    const ms = Date.now() - started;
    return { status: 200, body: { ok: false, provider: providerId, model, ms, reason: e.message === 'timeout' ? `超时（${TIMEOUT_MS}ms）` : `网络错误：${e.message}` } };
  }
}

// ---------- 管理页 HTML：单文件内联，无外部资源；JS 只用字符串拼接，不用模板字面量 ----------
function adminPageHtml() {
  const embedded = IS_LOCAL ? JSON.stringify(ADMIN_TOKEN) : '""';
  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>freeoneapi 本地网关</title>'
    + '<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222;line-height:1.6}'
    + 'h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-top:1px solid #ddd;padding-top:12px}'
    + '.card{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0}'
    + '.small{font-size:13px;color:#666}.mono{font-family:monospace;word-break:break-all}'
    + 'input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:7px 9px;margin:6px 0;border:1px solid #ccc;border-radius:6px}'
    + 'button{padding:6px 14px;margin:4px 6px 4px 0;border:1px solid #bbb;border-radius:6px;background:#f5f5f5;cursor:pointer}'
    + 'button:active{transform:translateY(1px)}pre{background:#f6f6f6;border:1px solid #ddd;border-radius:8px;padding:12px;overflow:auto;font-size:13px}'
    + 'table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eee;padding:5px 6px;text-align:left}'
    + '.ok{color:#1a7f37}.fail{color:#b3261e}</style></head><body>'
    + '<h1>freeoneapi 本地网关</h1>'
    + '<div id="status" class="small">加载中…</div>'
    + '<div id="tokenRow" style="display:none" class="card"><div>输入网关密钥后才能操作管理接口。</div>'
    + '<input type="password" id="tokenInput" placeholder="网关密钥">'
    + '<button onclick="saveToken()">确认</button><span id="tokenMsg" class="small"></span></div>'
    + '<h2>源与 key</h2><div id="providers"></div>'
    + '<h2>请求记录</h2><button onclick="loadLogs()">刷新</button><span class="small">每 10 秒自动刷新，只记元数据，不记 key 与请求体。</span>'
    + '<div id="logs"></div>'
    + '<h2>opencode 配置片段</h2><div class="small">复制后粘贴进 opencode.json 的 provider 一节。动态源的模型需手动加。</div>'
    + '<pre id="snippet"></pre><button onclick="copySnippet()">复制片段</button><span id="copyMsg" class="small"></span>'
    + '<h2>说明</h2><div class="small">'
    + 'key 只写不读，接口不返回 key 明文；保存即生效，不用重启。<br>'
    + '端口与监听地址改 .env 后重启；MODEL_ROUTES 改 .env。<br>'
    + '测试会消耗少量额度。</div>'
    + '<script>'
    + 'var TOKEN = ___ADMIN_TOKEN_JSON___;'
    + 'var GATEWAY_AUTH = false;'
    + 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\x27/g,"&#39;");}'
    + 'function headers(){return {"Content-Type":"application/json","Authorization":"Bearer "+TOKEN};}'
    + 'function showTokenRow(msg){document.getElementById("tokenRow").style.display="block";'
    + 'if(msg)document.getElementById("tokenMsg").textContent=msg;}'
    + 'function saveToken(){var v=document.getElementById("tokenInput").value;if(!v)return;'
    + 'TOKEN=v;try{sessionStorage.setItem("freeoneapi-admin-token",v);}catch(e){}loadStatus();}'
    + 'function api(path,method,body){return fetch(path,{method:method||"GET",headers:headers(),'
    + 'body:body?JSON.stringify(body):undefined}).then(function(r){if(r.status===401){showTokenRow("token 失效：本机请刷新页面，非本机请重新输入网关密钥。");'
    + 'throw new Error("401");}return r.json();});}'
    + 'function loadStatus(){if(!TOKEN){try{TOKEN=sessionStorage.getItem("freeoneapi-admin-token")||"";}catch(e){}}'
    + 'if(!TOKEN){showTokenRow("");return;}'
    + 'api("/admin/status").then(function(st){GATEWAY_AUTH=st.gatewayAuth;'
    + 'var started=st.startedAt?new Date(st.startedAt).toLocaleString():"";'
    + 'document.getElementById("status").textContent="地址 http://"+st.host+":"+st.port+"/v1 ｜ 源 "+st.providers.length+" 家 ｜ 静态模型 "+st.models+" 个 ｜ 启动于 "+started;'
    + 'var html="";'
    + 'st.providers.forEach(function(p){'
    + 'var models=p.models==="dynamic"?"动态（测试时填模型 id）":p.models.join("、");'
    + 'var keyLink=p.key_url?" <a href=\\""+esc(p.key_url)+"\\" target=\\"_blank\\" rel=\\"noopener\\">申请 key</a>":"";'
    + 'var firstModel=p.models==="dynamic"?"":p.models[0]||"";'
    + 'html+="<div class=\\"card\\"><b>"+esc(p.name)+"</b> <span class=\\"small\\">"+esc(p.id)+"</span> ｜ "+(p.hasKey?"已配 key":"未配 key")+keyLink'
    + '+"<div class=\\"small\\">模型："+esc(models)+"</div>"'
    + '+"<input type=\\"password\\" id=\\"key-"+esc(p.id)+"\\" placeholder=\\""+(p.hasKey?"已配，填入新 key 覆盖":"填入 key")+"\\">"'
    + '+"<button onclick=\\"saveKey(\x27"+esc(p.id)+"\x27)\\">保存</button>"'
    + '+(p.hasKey?"<button onclick=\\"clearKey(\x27"+esc(p.id)+"\x27)\\">清除</button>":"")'
    + '+"<input type=\\"text\\" id=\\"test-"+esc(p.id)+"\\" value=\\""+esc(firstModel)+"\\" placeholder=\\"测试用模型 id\\">"'
    + '+"<button onclick=\\"testProvider(\x27"+esc(p.id)+"\x27)\\">测试</button><span class=\\"small\\" id=\\"testmsg-"+esc(p.id)+"\\"></span></div>";});'
    + 'document.getElementById("providers").innerHTML=html;'
    + 'var snippetModels={};'
    + 'st.providers.forEach(function(p){if(p.models!=="dynamic"){p.models.forEach(function(m){snippetModels[m]={name:m+"（"+p.id+"）"};});}});'
    + 'var snippet={ $schema:"https://opencode.ai/config.json", provider:{ freeoneapi:{ npm:"@ai-sdk/openai-compatible",'
    + 'options:{ baseURL:"http://"+st.host+":"+st.port+"/v1", apiKey:GATEWAY_AUTH?TOKEN:"任意占位（本机监听不鉴权）" },'
    + 'models:snippetModels } } };'
    + 'document.getElementById("snippet").textContent=JSON.stringify(snippet,null,2);'
    + '}).catch(function(e){if(e.message!=="401")document.getElementById("status").textContent="状态加载失败："+e.message;});}'
    + 'function saveKey(pid){var v=document.getElementById("key-"+pid).value;if(!v)return;'
    + 'var keys={};keys[pid]=v;'
    + 'api("/admin/keys","POST",{keys:keys}).then(function(){loadStatus();});}'
    + 'function clearKey(pid){var keys={};keys[pid]="";'
    + 'api("/admin/keys","POST",{keys:keys}).then(function(){loadStatus();});}'
    + 'function testProvider(pid){var m=document.getElementById("test-"+pid).value;if(!m)return;'
    + 'var el=document.getElementById("testmsg-"+pid);el.textContent="测试中…";'
    + 'api("/admin/test","POST",{provider:pid,model:m}).then(function(r){'
    + 'if(r.ok){el.textContent="通过（"+r.ms+"ms）";}'
    + 'else if(r.error){el.textContent="失败："+r.error.message;}'
    + 'else{el.textContent="失败："+(r.detail||r.reason||("HTTP "+r.status));}'
    + 'el.className=r.ok?"small ok":"small fail";loadLogs();});}'
    + 'function loadLogs(){api("/admin/logs").then(function(d){var html="<table><tr><th>时间</th><th>类型</th><th>模型</th><th>源</th><th>切换</th><th>状态</th><th>耗时</th></tr>";'
    + 'd.logs.forEach(function(l){var t=l.t?new Date(l.t).toLocaleTimeString():"";'
    + 'html+="<tr><td>"+esc(t)+"</td><td>"+esc(l.kind==="test"?"测试":l.kind==="admin"?"管理":"对话")+"</td><td class=\\"mono\\">"+esc(l.model||"")+"</td><td>"+esc(l.provider||"")+"</td><td>"+(l.failover==="true"?"是":"")+"</td><td>"+esc(l.status)+" </td><td>"+esc(l.ms)+"ms</td></tr>";});'
    + 'html+="</table>";document.getElementById("logs").innerHTML=html;}).catch(function(){});}'
    + 'function copySnippet(){var t=document.getElementById("snippet").textContent;'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){document.getElementById("copyMsg").textContent="已复制";}).catch(function(){document.getElementById("copyMsg").textContent="复制失败，请手动复制";});}'
    + 'else{var ta=document.createElement("textarea");ta.value=t;document.body.appendChild(ta);ta.select();'
    + 'try{document.execCommand("copy");document.getElementById("copyMsg").textContent="已复制";}catch(e){document.getElementById("copyMsg").textContent="复制失败，请手动复制";}'
    + 'document.body.removeChild(ta);}}'
    + 'loadStatus();loadLogs();setInterval(loadLogs,10000);'
    + '</script></body></html>';
  // 用 replacer 函数，避免 token 里的 $ 被 replace 当成特殊序列
  return html.replace('___ADMIN_TOKEN_JSON___', function () { return JSON.stringify(IS_LOCAL ? ADMIN_TOKEN : ''); });
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
        ui: '/ui',
      });
    }
    if (u.pathname === '/ui' && req.method === 'GET') {
      const html = adminPageHtml();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
    if (u.pathname === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, modelsList());
    }
    if (u.pathname.startsWith('/admin/')) {
      if (!checkOrigin(req)) {
        return sendJson(res, 403, { error: { message: '跨站请求被拒绝', type: 'auth_error', code: 'bad_origin' } });
      }
      if (!checkAdmin(req)) {
        return sendJson(res, 401, { error: { message: '管理 token 不对或缺失', type: 'auth_error', code: 'bad_admin_token' } });
      }
      if (u.pathname === '/admin/status' && req.method === 'GET') {
        return sendJson(res, 200, adminStatus());
      }
      if (u.pathname === '/admin/logs' && req.method === 'GET') {
        return sendJson(res, 200, { logs: LOGS.slice().reverse() });
      }
      if (u.pathname === '/admin/keys' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
        }
        const keys = body.keys;
        if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
          return sendJson(res, 400, { error: { message: '缺 keys 对象', type: 'invalid_request', code: 'missing_keys' } });
        }
        const updated = [];
        for (const pid of Object.keys(keys)) {
          if (!PROVIDER_BY_ID.has(pid)) {
            return sendJson(res, 400, { error: { message: `未知源 ${pid}`, type: 'invalid_request', code: 'unknown_provider' } });
          }
          if (typeof keys[pid] !== 'string') {
            return sendJson(res, 400, { error: { message: `源 ${pid} 的 key 必须是字符串`, type: 'invalid_request', code: 'bad_key' } });
          }
          if (keys[pid] === '') delete KEYS[pid];
          else KEYS[pid] = keys[pid];
          updated.push(pid);
        }
        try {
          saveEnvKeys();
        } catch (e) {
          return sendJson(res, 500, { error: { message: `写 .env 失败：${e.message}`, type: 'server_error', code: 'env_write_failed' } });
        }
        pushLog({ kind: 'admin', method: 'POST', path: '/admin/keys', model: '', provider: updated.join(','), failover: '', status: 200, ms: Date.now() - started });
        return sendJson(res, 200, { ok: true, updated });
      }
      if (u.pathname === '/admin/test' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
        }
        const r = await handleAdminTest(body);
        pushLog({ kind: 'test', method: 'POST', path: '/admin/test', model: body.model || '', provider: body.provider || '', failover: '', status: r.body.ok ? 200 : (r.body.status || r.status), ms: r.body.ms || 0 });
        return sendJson(res, r.status, r.body);
      }
      return sendJson(res, 404, { error: { message: `未知管理路径 ${u.pathname}`, type: 'invalid_request', code: 'not_found' } });
    }
    if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!checkAuth(req)) {
        return sendJson(res, 401, { error: { message: '网关密钥不对或缺失（Authorization: Bearer <GATEWAY_KEY>）', type: 'auth_error', code: 'bad_gateway_key' } });
      }
      const rawBody = await readBody(req);
      const ctx = { model: '', provider: '', failover: '' };
      await handleChat(req, res, rawBody, ctx);
      pushLog({ kind: 'chat', method: 'POST', path: '/v1/chat/completions', model: ctx.model, provider: ctx.provider, failover: ctx.failover, status: res.statusCode, ms: Date.now() - started });
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
    STARTED_AT = new Date().toISOString();
    console.log(`[freeoneapi] 本地网关已启动：http://${HOST}:${PORT}/v1`);
    console.log(`[freeoneapi] 管理页：http://${HOST}:${PORT}/ui`);
    console.log(`[freeoneapi] 库：${PROVIDERS.length} 家源，${MODEL_MAP.size} 个静态免费模型`);
    if (keyed.length > 0) {
      console.log(`[freeoneapi] 已配 key 的源：${keyed.join('、')}（只显示源名，不显示 key）`);
    } else {
      console.log('[freeoneapi] 未配任何 key：打开管理页填 key，或配好 key（.env 的 FREEONEAPI_KEYS）后重启。');
    }
    if (GATEWAY_KEY) console.log('[freeoneapi] 已启用网关密钥鉴权。');
    else if (LOCAL_HOSTS.has(HOST)) {
      console.log('[freeoneapi] 本机监听，未设网关密钥（本机隔离就是保护）。');
      console.log(`[freeoneapi] 管理页 token（仅本机，curl 管理接口时用）：${ADMIN_TOKEN}`);
    }
  });
})();
