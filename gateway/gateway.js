#!/usr/bin/env node
// freeoneapi 本地网关入口：只做启动接线，具体逻辑在各模块。
// 模块：config（配置）/ providers（库与路由）/ util（共享工具与日志）/
//       chat（对话）/ admin（管理接口）/ ui（管理页）/ server（路由）。
// 依赖方向：config 不依赖谁；util、providers 只依赖 config；
//           chat、admin 依赖 config、providers、util；server 依赖全部；入口依赖全部。
// 无循环依赖，单文件改动不牵连其他模块。零依赖，Node 18+。
// 用法：在 gateway/ 目录里建 .env（填 FREEONEAPI_KEYS），然后 node gateway.js。
// 管理页：http://127.0.0.1:8080/ui。设计见 ../DESIGN.md。
'use strict';

const config = require('./config');
const providers = require('./providers');
const server = require('./server');

(async () => {
  try {
    await providers.load();
  } catch (e) {
    console.error(`[freeoneapi] 启动失败：拉不到库（${config.PROVIDERS_URL}）：${e.message}`);
    console.error('[freeoneapi] 检查网络，或用 PROVIDERS_URL 指向本地 providers.json 文件路径，重启。');
    process.exit(1);
  }
  const keyed = providers.getProviders().filter((p) => config.KEYS[p.id]).map((p) => p.id);
  const srv = server.createServer();
  srv.listen(config.PORT, config.HOST, () => {
    server.setStartedAt(new Date().toISOString());
    console.log(`[freeoneapi] 本地网关已启动：http://${config.HOST}:${config.PORT}/v1`);
    console.log(`[freeoneapi] 管理页：http://${config.HOST}:${config.PORT}/ui`);
    console.log(`[freeoneapi] 库：${providers.getProviders().length} 家源，${providers.getModelMap().size} 个静态免费模型`);
    if (keyed.length > 0) {
      console.log(`[freeoneapi] 已配 key 的源：${keyed.join('、')}（只显示源名，不显示 key）`);
    } else {
      console.log('[freeoneapi] 未配任何 key：打开管理页填 key，或配好 key（.env 的 FREEONEAPI_KEYS）后重启。');
    }
    if (config.GATEWAY_KEY) console.log('[freeoneapi] 已启用网关密钥鉴权。');
    else if (config.LOCAL_HOSTS.has(config.HOST)) {
      console.log('[freeoneapi] 本机监听，未设网关密钥（本机隔离就是保护）。');
      console.log(`[freeoneapi] 管理页 token（仅本机，curl 管理接口时用）：${config.ADMIN_TOKEN}`);
    }
  });
})();
