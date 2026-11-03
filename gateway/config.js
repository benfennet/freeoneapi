// freeoneapi 本地网关配置：.env 加载与全部配置常量。
// 被所有模块引用，不引用其他模块（无循环依赖）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// .env：只读，不覆盖真实环境变量；不展开变量；不记 key
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

loadDotEnv();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8080', 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10);
const PROVIDERS_URL = process.env.PROVIDERS_URL || 'https://benfennet.github.io/freeoneapi/providers.json';
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
// KEYS 是共享可变对象：管理页改它，对话直接读它，不用重启。只改内容，不重新赋值。
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

const config = {
  VERSION: 'v1',
  HOST,
  PORT,
  TIMEOUT_MS,
  PROVIDERS_URL,
  GATEWAY_KEY,
  KEYS,
  MODEL_ROUTES,
  LOCAL_HOSTS,
  IS_LOCAL,
  ADMIN_TOKEN,
  ALLOWED_ORIGINS,
  get loadedEnvFile() { return loadedEnvFile; },
  set loadedEnvFile(v) { loadedEnvFile = v; },
};

module.exports = config;
