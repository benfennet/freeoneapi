// freeoneapi 管理模块：源状态、填 key（持久化）、单源测试。
// key 只写不读，任何接口不返回 key 明文。
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const providers = require('./providers');
const u = require('./util');

// 只改 .env 的 FREEONEAPI_KEYS 一行（原子写），其余行原样保留；内存即时生效
function saveEnvKeys() {
  const file = config.loadedEnvFile || path.join(__dirname, '.env');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const newLine = 'FREEONEAPI_KEYS=' + JSON.stringify(config.KEYS);
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
  config.loadedEnvFile = file;
}

function adminStatus(startedAt) {
  return {
    service: 'freeoneapi-local',
    version: config.VERSION,
    host: config.HOST,
    port: config.PORT,
    startedAt,
    gatewayAuth: !!config.GATEWAY_KEY,
    models: providers.getModelMap().size,
    providers: providers.getProviders().map((p) => ({
      id: p.id,
      name: p.name || p.id,
      hasKey: !!config.KEYS[p.id],
      models: Array.isArray(p.free_models) ? p.free_models : 'dynamic',
      key_url: p.key_url || '',
    })),
  };
}

// 对单个源发最小请求验 key 通不通（消耗少量额度），不自动切
async function handleAdminTest(bodyJson) {
  const providerId = bodyJson.provider;
  const model = bodyJson.model;
  const provider = providers.getProvider(providerId);
  if (!provider) return { status: 400, body: { error: { message: `未知源 ${providerId}`, type: 'invalid_request', code: 'unknown_provider' } } };
  if (!config.KEYS[providerId]) return { status: 401, body: { error: { message: `源 ${providerId} 没配 key`, type: 'auth_error', code: 'no_key_for_provider' } } };
  if (!model || typeof model !== 'string') return { status: 400, body: { error: { message: '缺 model 字段', type: 'invalid_request', code: 'missing_model' } } };
  if (Array.isArray(provider.free_models) && !provider.free_models.includes(model)) {
    return { status: 400, body: { error: { message: `模型 ${model} 不在源 ${providerId} 的免费清单里`, type: 'invalid_request', code: 'model_not_in_provider' } } };
  }
  const url = provider.base_url.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${config.KEYS[providerId]}`,
  };
  if (providerId === 'openrouter') {
    headers['http-referer'] = 'https://github.com/benfennet/freeoneapi';
    headers['x-title'] = 'freeoneapi';
  }
  const started = Date.now();
  try {
    const upstream = await u.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    }, config.TIMEOUT_MS);
    const text = await upstream.text();
    const ms = Date.now() - started;
    if (upstream.ok) return { status: 200, body: { ok: true, provider: providerId, model, ms, status: upstream.status } };
    return { status: 200, body: { ok: false, provider: providerId, model, ms, status: upstream.status, detail: text.slice(0, 300) } };
  } catch (e) {
    const ms = Date.now() - started;
    return { status: 200, body: { ok: false, provider: providerId, model, ms, reason: e.message === 'timeout' ? `超时（${config.TIMEOUT_MS}ms）` : `网络错误：${e.message}` } };
  }
}

module.exports = { saveEnvKeys, adminStatus, handleAdminTest };
