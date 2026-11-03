# freeoneapi 本地网关

多模块，零依赖，Node 18+。在自己电脑上跑，得到本机 baseUrl，配进 opencode、Cherry Studio 就能用。

与 One API 无关、独立实现。只走免费源，绝不切付费。

## 部署（四步）

1. 装 Node 18+（`node --version` 能看到版本号就行）。
2. 下载本目录（`gateway/` 整个目录），同目录建 `.env`（照着 `.env.example` 抄，填自己的 key）。
3. 在 `gateway/` 目录里 `node gateway.js`，看到“本地网关已启动”就是跑起来了。
4. 客户端配 baseUrl：`http://127.0.0.1:8080/v1`。

用之前先把网关跑起来；电脑关了，网关就停。

## 管理页

打开 `http://127.0.0.1:8080/ui`，不用写 .env：

- 填各家 key（表单），保存即生效，不用重启；key 只写不读，接口不返回 key 明文。
- 看各源状态（已配 key、模型清单、申请 key 链接）。
- 点测试验 key 通不通（会消耗少量额度）。
- 看最近请求记录（只记元数据，不记 key 与请求体）。
- 复制 opencode 配置片段。

本机打开自动带 token；非本机打开需输入网关密钥。端口与监听地址、MODEL_ROUTES 仍改 .env。

## 配进 opencode

`opencode.json` 里加自定义 provider：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freeoneapi": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "任意占位（本机监听不鉴权）"
      },
      "models": {
        "openai/gpt-oss-120b": { "name": "gpt-oss-120b（Groq 免费）" },
        "glm-4.7-flash": { "name": "GLM 4.7 Flash（智谱免费）" }
      }
    }
  }
}
```

模型 id 从库里看：静态免费模型 `GET http://127.0.0.1:8080/v1/models`；动态源的模型（如硅基流动）在 `.env` 里用 `MODEL_ROUTES` 指定。

## key 从哪来

照着库里的 5 家免费源去申请（见 `../providers.json` 的 `key_url` 和 `key_steps`）。国内先拿硅基流动和智谱（国内直连），国外拿 Gemini、Groq、OpenRouter。多拿几家，自动切的池子就越大。

## 日常行为

- 某家额度用完（429）或不可用（5xx、超时），自动切下一家免费源。
- 响应头标明实际是谁答的：`x-freeoneapi-provider`、`x-freeoneapi-model`、`x-freeoneapi-failover`。
- 流式：还没输出就失败，换家重发整条；已经输出才失败，明示截断加错误，不会静默截断成完整回答。
- 免费额度全用完：返回明确错误，列出每家失败的原因，等第二天重置，或再加新的免费源（改 .env，重启）。

## 安全

- key 只进本地 `.env`，绝不进代码和仓库；日志不记 key、不记请求体。
- 默认只绑 127.0.0.1，本机隔离就是保护，不用网关密钥。
- 监听非本机地址时必须设 `GATEWAY_KEY`，否则网关拒绝启动。
- 网关不对浏览器开放，浏览器聊天走直连各家，不走网关。

## 模块

- `gateway.js`：入口，只做启动接线。
- `config.js`：配置（.env 与常量），不依赖其他模块。
- `providers.js`：库与路由。
- `util.js`：共享工具与日志。
- `chat.js`：对话。
- `admin.js`：管理接口。
- `ui.js`：管理页。
- `server.js`：路由分发。

依赖方向无循环：config 不依赖谁；util、providers 只依赖 config；chat、admin 依赖 config、providers、util；server 依赖全部。

## 更新

- 库更新：启动时自动拉最新库，不用重新部署网关。
- 网关代码更新：重新下载 `gateway/` 目录，重启。
