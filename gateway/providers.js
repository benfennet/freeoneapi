// freeoneapi 库模块：拉取 providers.json，建模型路由表。
// 状态只存在本模块内，对外只给读取函数，不直接暴露可写变量。
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

let PROVIDERS = [];
let PROVIDER_BY_ID = new Map();
let MODEL_MAP = new Map();

// 启动时拉一次，拉不到就抛错（入口捕获后报错退出），不带过期数据硬跑
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
  PROVIDERS = data.providers;
  PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
  MODEL_MAP = buildModelMap(PROVIDERS);
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

function getProviders() { return PROVIDERS; }
function getProvider(id) { return PROVIDER_BY_ID.get(id); }
function hasProvider(id) { return PROVIDER_BY_ID.has(id); }
function getModelMap() { return MODEL_MAP; }

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

module.exports = { load, getProviders, getProvider, hasProvider, getModelMap, modelsList, routeCandidates };
