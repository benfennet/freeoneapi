// freeoneapi 库模块：拉取 providers.json，建模型路由表；加自定义源。
// 库是共享的（只读），自定义源是用户自己的（custom-providers.json，可增删）。
// 路由时库里的源先试，自定义源作补充池；只在自定义源有的模型，自定义源就是唯一候选。
// 状态只存在本模块内，对外只给读取与增删函数，不直接暴露可写变量。
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CUSTOM_FILE = path.join(__dirname, 'custom-providers.json');

let LIBRARY = [];
let CUSTOM_RAW = []; // 文件原样（含不合格条目，不静默丢弃）
let CUSTOM_LOAD_ERROR = null;
let PROVIDER_BY_ID = new Map();
let MODEL_MAP = new Map();

// 模型 id -> 源 id 列表（按传入顺序）。动态源（free_models 不是数组）不在表里。
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

// 校验一条自定义源，返回错误原因，无错返回 null
function validateCustom(p, libraryIds, existingIds) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '自定义源必须是对象';
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) return 'id 须是小写字母、数字、短横线组成（小写开头）';
  if (libraryIds.has(p.id)) return `id ${p.id} 已在库里，不能重复`;
  if (existingIds.has(p.id)) return `id ${p.id} 已在自定义源里，不能重复`;
  if (typeof p.name !== 'string' || p.name.trim() === '') return '名字不能为空';
  if (typeof p.base_url !== 'string' || p.base_url.trim() === '') return '接口地址不能为空';
  let u;
  try {
    u = new URL(p.base_url);
  } catch (e) {
    return '接口地址不是合法 URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '接口地址须是 http 或 https';
  // 自定义源须是 https，本机 http 例外（本地调试）
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return '接口地址须是 https（本机 http 例外）';
  if (!Array.isArray(p.free_models) || p.free_models.length === 0) return '模型清单不能为空';
  for (const m of p.free_models) {
    if (typeof m !== 'string' || m.trim() === '') return '模型清单里有空模型 id';
  }
  if (p.key_url !== undefined && p.key_url !== null && p.key_url !== '' && typeof p.key_url !== 'string') return 'key_url 须是字符串';
  return null;
}

// 从 RAW 里算出有效条目与不合格条目（带下标，状态里按下标对应）
function computeCustom() {
  const libraryIds = new Set(LIBRARY.map((p) => p.id));
  const seen = new Set();
  const valid = [];
  const errors = [];
  CUSTOM_RAW.forEach((p, i) => {
    const err = validateCustom(p, libraryIds, seen);
    if (err) {
      errors.push({ index: i, id: typeof p.id === 'string' ? p.id : '', error: err });
    } else {
      valid.push(p);
      seen.add(p.id);
    }
    // 不合格条目的 id 也占位，避免后一条用同 id 绕过重复检查
    if (typeof p.id === 'string') seen.add(p.id);
  });
  return { valid, errors };
}

function rebuild() {
  const { valid } = computeCustom();
  const all = [...LIBRARY, ...valid]; // 库在前，自定义在后（同模型先试库）
  PROVIDER_BY_ID = new Map(all.map((p) => [p.id, p]));
  MODEL_MAP = buildModelMap(all);
}

function loadCustomFile() {
  let text;
  try {
    text = fs.readFileSync(CUSTOM_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      CUSTOM_RAW = [];
      CUSTOM_LOAD_ERROR = null;
      return;
    }
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    CUSTOM_RAW = [];
    CUSTOM_LOAD_ERROR = `自定义源文件不是合法 JSON：${e.message}`;
    return;
  }
  if (!Array.isArray(data)) {
    CUSTOM_RAW = [];
    CUSTOM_LOAD_ERROR = '自定义源文件顶层必须是数组';
    return;
  }
  CUSTOM_RAW = data;
  CUSTOM_LOAD_ERROR = null;
}

// 启动时拉一次库，拉不到就抛错（入口捕获后报错退出），不带过期数据硬跑
async function load() {
  let data;
  if (/^https?:\/\//.test(config.PROVIDERS_URL)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(config.PROVIDERS_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } else {
    const tries = [config.PROVIDERS_URL, path.join(__dirname, config.PROVIDERS_URL), path.join(process.cwd(), config.PROVIDERS_URL)];
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
  LIBRARY = data.providers;
  loadCustomFile();
  rebuild();
}

function getProviders() { return LIBRARY; }
function getProvider(id) { return PROVIDER_BY_ID.get(id); }
function hasProvider(id) { return PROVIDER_BY_ID.has(id); }
function getModelMap() { return MODEL_MAP; }
function getCustomRaw() { return CUSTOM_RAW; }
function getCustomErrors() { return computeCustom().errors; }
function getCustomLoadError() { return CUSTOM_LOAD_ERROR; }
function getCustomFilePath() { return CUSTOM_FILE; }

function getCustomErrorById(id) {
  const found = computeCustom().errors.find((e) => e.id === id);
  return found ? found.error : null;
}

// 内存增删（持久化由 admin 模块做，失败时调用方回滚）。只存已知字段，丢弃多余字段。
function addCustom(p) {
  const libraryIds = new Set(LIBRARY.map((x) => x.id));
  const existingIds = new Set(CUSTOM_RAW.filter((x) => typeof x.id === 'string').map((x) => x.id));
  const err = validateCustom(p, libraryIds, existingIds);
  if (err) return { ok: false, error: err };
  const entry = {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    free_models: p.free_models,
  };
  if (p.key_url) entry.key_url = p.key_url;
  CUSTOM_RAW.push(entry);
  rebuild();
  return { ok: true, entry };
}

function deleteCustom(id) {
  if (LIBRARY.some((p) => p.id === id)) return { ok: false, error: '库里的源不能删' };
  const i = CUSTOM_RAW.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, error: `未知自定义源 ${id}` };
  const removed = CUSTOM_RAW.splice(i, 1)[0];
  rebuild();
  return { ok: true, removed };
}

function modelsList() {
  const data = [];
  for (const [model, ids] of MODEL_MAP) {
    data.push({ id: model, object: 'model', owned_by: ids[0] });
  }
  return { object: 'list', data };
}

// 路由：返回候选源 id 列表（已按顺序），或 { error }。
function routeCandidates(model) {
  if (MODEL_MAP.has(model)) return { candidates: MODEL_MAP.get(model) };
  if (model.endsWith(':free')) {
    // OpenRouter 免费模型：id 本身带 :free 后缀，原样发过去
    if (PROVIDER_BY_ID.has('openrouter')) return { candidates: ['openrouter'] };
    return { error: '模型带 :free 后缀，应走 OpenRouter，但你没在库里找到 openrouter（库可能已更新，重启网关重拉）。' };
  }
  if (config.MODEL_ROUTES[model] && PROVIDER_BY_ID.has(config.MODEL_ROUTES[model])) {
    return { candidates: [config.MODEL_ROUTES[model]] };
  }
  return { error: `模型 ${model} 不在免费库里。请 GET /v1/models 看静态免费模型，动态源的模型在 .env 里用 MODEL_ROUTES 指定。` };
}

module.exports = {
  load, getProviders, getProvider, hasProvider, getModelMap, modelsList, routeCandidates,
  getCustomRaw, getCustomErrors, getCustomLoadError, getCustomFilePath, getCustomErrorById,
  addCustom, deleteCustom,
};
