// freeoneapi 路由：把 HTTP 路径分到各模块。只做分发，不含业务逻辑。
'use strict';

const http = require('http');
const config = require('./config');
const providers = require('./providers');
const u = require('./util');
const chat = require('./chat');
const admin = require('./admin');
const ui = require('./ui');

let STARTED_AT = '';
function setStartedAt(v) { STARTED_AT = v; }

function createServer() {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        return u.sendJson(res, 200, {
          service: 'freeoneapi-local',
          version: config.VERSION,
          providers: providers.getProviders().length,
          models: providers.getModelMap().size,
          host: config.HOST,
          port: config.PORT,
          ui: '/ui',
        });
      }
      if (url.pathname === '/ui' && req.method === 'GET') {
        const html = ui.adminPageHtml(config.IS_LOCAL, config.ADMIN_TOKEN);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return u.sendJson(res, 200, providers.modelsList());
      }
      if (url.pathname.startsWith('/admin/')) {
        if (!u.checkOrigin(req)) {
          return u.sendJson(res, 403, { error: { message: '跨站请求被拒绝', type: 'auth_error', code: 'bad_origin' } });
        }
        if (!u.checkAdmin(req)) {
          return u.sendJson(res, 401, { error: { message: '管理 token 不对或缺失', type: 'auth_error', code: 'bad_admin_token' } });
        }
        if (url.pathname === '/admin/status' && req.method === 'GET') {
          return u.sendJson(res, 200, admin.adminStatus(STARTED_AT));
        }
        if (url.pathname === '/admin/logs' && req.method === 'GET') {
          return u.sendJson(res, 200, { logs: u.getLogs().slice().reverse() });
        }
        if (url.pathname === '/admin/keys' && req.method === 'POST') {
          const raw = await u.readBody(req);
          let body;
          try { body = JSON.parse(raw); } catch (e) {
            return u.sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
          }
          const keys = body.keys;
          if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
            return u.sendJson(res, 400, { error: { message: '缺 keys 对象', type: 'invalid_request', code: 'missing_keys' } });
          }
          const updated = [];
          for (const pid of Object.keys(keys)) {
            if (!providers.hasProvider(pid)) {
              return u.sendJson(res, 400, { error: { message: `未知源 ${pid}`, type: 'invalid_request', code: 'unknown_provider' } });
            }
            if (typeof keys[pid] !== 'string') {
              return u.sendJson(res, 400, { error: { message: `源 ${pid} 的 key 必须是字符串`, type: 'invalid_request', code: 'bad_key' } });
            }
            if (keys[pid] === '') delete config.KEYS[pid];
            else config.KEYS[pid] = keys[pid];
            updated.push(pid);
          }
          try {
            admin.saveEnvKeys();
          } catch (e) {
            return u.sendJson(res, 500, { error: { message: `写 .env 失败：${e.message}`, type: 'server_error', code: 'env_write_failed' } });
          }
          u.pushLog({ kind: 'admin', method: 'POST', path: '/admin/keys', model: '', provider: updated.join(','), failover: '', status: 200, ms: Date.now() - started });
          return u.sendJson(res, 200, { ok: true, updated });
        }
        if (url.pathname === '/admin/test' && req.method === 'POST') {
          const raw = await u.readBody(req);
          let body;
          try { body = JSON.parse(raw); } catch (e) {
            return u.sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request', code: 'bad_json' } });
          }
          const r = await admin.handleAdminTest(body);
          u.pushLog({ kind: 'test', method: 'POST', path: '/admin/test', model: body.model || '', provider: body.provider || '', failover: '', status: r.body.ok ? 200 : (r.body.status || r.status), ms: r.body.ms || 0 });
          return u.sendJson(res, r.status, r.body);
        }
        return u.sendJson(res, 404, { error: { message: `未知管理路径 ${url.pathname}`, type: 'invalid_request', code: 'not_found' } });
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        if (!u.checkAuth(req)) {
          return u.sendJson(res, 401, { error: { message: '网关密钥不对或缺失（Authorization: Bearer <GATEWAY_KEY>）', type: 'auth_error', code: 'bad_gateway_key' } });
        }
        const rawBody = await u.readBody(req);
        const ctx = { model: '', provider: '', failover: '' };
        await chat.handleChat(req, res, rawBody, ctx);
        u.pushLog({ kind: 'chat', method: 'POST', path: '/v1/chat/completions', model: ctx.model, provider: ctx.provider, failover: ctx.failover, status: res.statusCode, ms: Date.now() - started });
        return;
      }
      if (url.pathname === '/v1/chat/completions') {
        return u.sendJson(res, 405, { error: { message: '只支持 POST', type: 'invalid_request', code: 'method_not_allowed' } });
      }
      return u.sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: 'invalid_request', code: 'not_found' } });
    } catch (e) {
      const status = e.status || 500;
      u.log(`${req.method} ${url.pathname} status=${status} error=${e.message} ${Date.now() - started}ms`);
      if (!res.headersSent) {
        u.sendJson(res, status, { error: { message: e.message || '网关内部错误', type: 'server_error', code: 'internal' } });
      } else {
        try { res.end(); } catch (_) { /* 忽略 */ }
      }
    }
  });
}

module.exports = { createServer, setStartedAt };
