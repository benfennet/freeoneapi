// freeoneapi 对话模块：POST /v1/chat/completions，路由、自动切、流式。
// 只走免费源，绝不切付费；重试有界（每家一次）；流式中途断明示截断。
'use strict';

const config = require('./config');
const providers = require('./providers');
const u = require('./util');

async function handleChat(req, res, rawBody, ctx) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return u.sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
  }
  const model = body.model;
  const stream = body.stream === true;
  ctx.model = typeof model === 'string' ? model : '';
  if (!model || typeof model !== 'string') {
    return u.sendJson(res, 400, { error: { message: '缺 model 字段', type: 'invalid_request', code: 'missing_model' } });
  }
  if (!Array.isArray(body.messages)) {
    return u.sendJson(res, 400, { error: { message: '缺 messages 数组', type: 'invalid_request', code: 'missing_messages' } });
  }

  const routed = providers.routeCandidates(model);
  if (routed.error) return u.sendJson(res, 404, { error: { message: routed.error, type: 'invalid_request', code: 'model_not_in_library' } });

  const withKey = routed.candidates.filter((id) => config.KEYS[id]);
  if (withKey.length === 0) {
    return u.sendJson(res, 401, { error: {
      message: `模型 ${model} 对应的源（${routed.candidates.join('、')}）都没配 key。请在管理页（/ui）或 .env 的 FREEONEAPI_KEYS 里加上对应源的 key（管理页保存即生效，不用重启）。`,
      type: 'auth_error', code: 'no_key_for_provider',
    } });
  }

  const failures = [];
  let tried = 0;
  for (const pid of withKey) {
    tried++;
    const provider = providers.getProvider(pid);
    const url = provider.base_url.replace(/\/$/, '') + '/chat/completions';
    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${config.KEYS[pid]}`,
    };
    // OpenRouter 建议带 Referer 与标题（用于识别，不影响计费）
    if (pid === 'openrouter') {
      headers['http-referer'] = 'https://github.com/benfennet/freeoneapi';
      headers['x-title'] = 'freeoneapi';
    }
    let upstream;
    try {
      upstream = await u.fetchWithTimeout(url, { method: 'POST', headers, body: rawBody }, config.TIMEOUT_MS);
    } catch (e) {
      failures.push({ provider: pid, reason: e.message === 'timeout' ? `超时（${config.TIMEOUT_MS}ms 未响应）` : `网络错误：${e.message}` });
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
      u.log(`POST /v1/chat/completions model=${model} provider=${pid} failover=${failover} status=200`);
      return;
    }

    // 流式：等到第一个 chunk 才算成功，之前失败还能换家；之后失败只能明示截断。
    const reader = upstream.body.getReader();
    let first;
    try {
      first = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), config.TIMEOUT_MS)),
      ]);
    } catch (e) {
      try { reader.cancel(); } catch (_) { /* 忽略 */ }
      failures.push({ provider: pid, reason: e.message === 'timeout' ? `流式首包超时（${config.TIMEOUT_MS}ms）` : `流式读取失败：${e.message}` });
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
    u.log(`POST /v1/chat/completions stream model=${model} provider=${pid} failover=${failover} status=200`);
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
  u.log(`POST /v1/chat/completions model=${model} status=502 tried=${tried} last=${last ? last.reason : '无'}`);
  return u.sendJson(res, 502, u.errObj(
    `免费源全失败（试了 ${tried} 家）：` + failures.map((f) => `${f.provider}（${f.reason}）`).join('；') + '。请检查 key 或等额度重置。',
    failures
  ));
}

module.exports = { handleChat };
