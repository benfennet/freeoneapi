// freeoneapi 共享工具：HTTP 回包、请求体、上游调用、鉴权、日志。
// 只依赖 config，不依赖其他业务模块。
'use strict';

const config = require('./config');

const BODY_LIMIT = 20 * 1024 * 1024; // 请求体上限 20MB，写代码的长提示也够
const LOG_MAX = 100;

// 请求日志：只记元数据（时间、模型、源、状态、耗时），不记 key、不记请求体
const LOGS = [];
function pushLog(entry) {
  entry.t = new Date().toISOString();
  LOGS.push(entry);
  while (LOGS.length > LOG_MAX) LOGS.shift();
}
function getLogs() { return LOGS; }

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
  if (!config.GATEWAY_KEY) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${config.GATEWAY_KEY}`;
}

function checkAdmin(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${config.ADMIN_TOKEN}`;
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl 等非浏览器请求无 Origin，靠 token 鉴权
  return config.ALLOWED_ORIGINS.has(origin);
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

module.exports = {
  BODY_LIMIT, LOG_MAX, pushLog, getLogs, log,
  sendJson, errObj, readBody, checkAuth, checkAdmin, checkOrigin, fetchWithTimeout,
};
