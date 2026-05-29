# gemini-web2api-worker — Cloudflare Workers 部署指南

> ⚡ **本分支专门用于 Cloudflare Workers 部署**  
> 将 Google Gemini 网页端转为 OpenAI 兼容 API，运行在 Cloudflare Workers 上。  
> 无需科学上网，无需 NAS 代理，CF 全球网络直连 Gemini。  
> 上游代码同步自 [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api)，由 TypeScript 重写。

---

## 目录

- [前置要求](#前置要求)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [部署](#部署)
- [使用示例](#使用示例)
- [API 端点](#api-端点)
- [Cookie 配置（可选）](#cookie-配置可选)
- [Docker 版对比](#docker-版对比)

---

## 前置要求

- **Node.js 18+** + **npm**
- **Cloudflare 账号**（免费即可）
- **一个域名**（可选，自定义路由用）

---

## 快速开始

```bash
# 1. 进入项目目录
cd gemini-web2api-worker

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare
npx wrangler login

# 4. 部署
npx wrangler deploy

# 5. 用 curl 测试
curl https://gemini-web2api.你的用户名.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"你好"}]}'
```

---

## 配置说明

所有配置通过 `wrangler.toml` 或 `wrangler secret` 注入：

### wrangler.toml（非敏感配置）

```toml
[vars]
DEFAULT_MODEL = "gemini-3.5-flash"
API_KEYS = ""            # 逗号分隔，留空=免认证
LOG_REQUESTS = "true"
```

### 敏感配置（wrangler secret）

```bash
# Cookie（可选，用于 Pro 模型）
echo '{"cookie":"SID=xxx; HSID=xxx; ...","sapisid":"xxx"}' | npx wrangler secret put COOKIE_JSON

# API Keys（如果不想写在 wrangler.toml 中）
echo "sk-key1,sk-key2" | npx wrangler secret put API_KEYS
```

### 所有配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `DEFAULT_MODEL` | string | `gemini-3.5-flash` | 默认模型名 |
| `GEMINI_BL` | string | `boq_assistant-bard-web-server_20260525.09_p0` | Gemini BL 版本号 |
| `API_KEYS` | string (逗号分隔) | `""` | 空=免认证；非空时需 Bearer Token |
| `LOG_REQUESTS` | string | `"true"` | 是否打印请求日志 |
| `COOKIE_JSON` | secret | — | JSON 格式的 Cookie 数据 |

---

## 部署

### 首次部署

```bash
npx wrangler deploy
```

### 更新

```bash
npx wrangler deploy
```

### 自定义域名

```toml
# wrangler.toml 中添加
routes = [
  { pattern = "api.你的域名.com", custom_domain = true }
]
```

然后 DNS 添加 CNAME 指向 Worker。

### 本地开发

```bash
npx wrangler dev
```

启动后在 `http://localhost:8787` 测试。

---

## 使用示例

### curl（流式）

```bash
curl https://你的worker域名/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash-thinking",
    "messages": [{"role": "user", "content": "讲个冷笑话"}],
    "stream": true
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://你的worker域名/v1",
    api_key="sk-your-key"  # 仅当配置了 API_KEYS 时需要
)

resp = client.chat.completions.create(
    model="gemini-3.5-flash-thinking",
    messages=[{"role": "user", "content": "解释量子纠缠"}]
)
print(resp.choices[0].message.content)
```

### Cherry Studio / ChatBox

| 字段 | 值 |
|------|-----|
| Base URL | `https://你的worker域名/v1` |
| API Key | 任意 (如果未配置 API_KEYS) |
| Model | `gemini-3.5-flash-thinking` |

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查 (版本 + 模型列表) |
| `/v1/models` | GET | OpenAI 模型列表 |
| `/v1/chat/completions` | POST | OpenAI 聊天补全 (流式 + 非流式) |
| `/v1/responses` | POST | OpenAI Responses API (Codex CLI) |
| `/v1beta/models` | GET | Google 原生模型列表 |
| `/v1beta/models/{m}:generateContent` | POST | Google 原生非流式 |
| `/v1beta/models/{m}:streamGenerateContent` | POST | Google 原生流式 |

### 可用模型

| 模型名 | 说明 | 思维深度默认值 |
|--------|------|---------------|
| `gemini-3.5-flash` | 快速通用 | 4 |
| `gemini-3.5-flash-thinking` | 深度思考 (~20k 字符) | 0 |
| `gemini-3.5-flash-thinking-lite` | 自适应深度思考 | 0 |
| `gemini-3.1-pro` | Pro (需 Cookie) | 4 |
| `gemini-auto` | 自动选择 | 4 |
| `gemini-flash-lite` | 轻量快速 | 4 |

支持 `@think=N` 后缀：`gemini-3.5-flash@think=2`

---

## Cookie 配置（可选）

如果不需要 Pro 模型，可以跳过此步骤，匿名访问即可。

**获取 Cookie：**

1. 在浏览器打开 `https://gemini.google.com` 并登录 Google 账号
2. F12 → Application → Cookies → `https://gemini.google.com`
3. 复制：`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`
4. 注入到 Workers：

```bash
echo '{"cookie": "SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx; __Secure-1PSID=xxx", "sapisid": "xxx"}' \
  | npx wrangler secret put COOKIE_JSON
```

> **注意**: Cookie 有有效期，过期后需更新。可以用 `wrangler secret put` 覆盖更新，无需重部署。

---

## Docker 版 vs Workers 版对比

| 特性 | Docker (NAS) | Cloudflare Workers |
|------|-------------|-------------------|
| **网络需求** | ❌ 需要科学上网/代理 | ✅ CF 全球直连 Gemini |
| **部署** | Docker Compose | `npx wrangler deploy` |
| **价格** | NAS 电费 | Free Plan 100k req/day |
| **流式** | ✅ httpx SSE | ✅ Web Streams SSE |
| **图片多模态** | ✅ | ✅ |
| **Tool Calling** | ✅ | ✅ |
| **Cookie 管理** | 本地文件 | `wrangler secret` 环境变量 |
| **自定义** | ✅ 全可控 | ⚠️ 受 Worker 限制 |
| **延迟** | LAN | 全球 CDN 边缘节点 |
| **持久 IP** | ✅ 固定出口 IP | CF 共享 IP 池 |

---

## 项目结构

```
gemini-web2api-worker/
├── wrangler.toml           # Workers 配置
├── package.json            # 依赖
├── tsconfig.json           # TypeScript 配置
└── src/
    ├── index.ts            # ★ 入口 (export default fetch)
    ├── types.ts            # 共享类型定义
    ├── config.ts           # 配置读取 (Env 绑定)
    ├── models.ts           # 模型定义 + resolve_model()
    ├── gemini.ts           # ★ 协议核心 (f.req / fetch / wrb.fr 解析)
    ├── tools.ts            # 消息转换 + Tool Calling
    ├── multimodal.ts       # 图片上传 (ProcessFile RPC)
    ├── router.ts           # URL 路由 + 认证
    ├── version.ts          # 版本号 + 模型列表导出
    ├── handlers/
    │   ├── chat.ts         # /v1/chat/completions
    │   ├── responses.ts    # /v1/responses (Codex CLI)
    │   └── google.ts       # /v1beta/models (Google native)
    └── utils/
        ├── log.ts          # 日志工具
        ├── sse.ts          # SSE 流式工具
        └── response.ts     # JSON/错误响应工具
```

---

## 从 Python 版移植说明

移植自 [gemini-web2api v1.1.0](https://github.com/your-repo/gemini-web2api)。

关键差异：

| 模块 | Python | TypeScript (Workers) |
|------|--------|---------------------|
| HTTP | `http.server` + `ThreadingMixIn` | `fetch()` handler |
| 流式 | `self.wfile.write()` | `TransformStream` + `WritableStream` |
| SHA-1 | `hashlib.sha1` | `crypto.subtle.digest("SHA-1", ...)` |
| Cookie | 文件系统 (`open()`) | 环境变量 / Secrets |
| 代理 | `ProxyHandler` | 不需要 (CF 全球网络) |
| 重试 | `time.sleep()` | `setTimeout` Promise |
| 图片 base64 | `base64.b64encode` | `btoa()` |

---


## ⚠️ 已知限制

### Tool Calling / Function Calling

当前 Tool Calling（工具调用）**并非原生支持**，而是通过**提示词约束**（Prompt Engineering）模拟实现的：

- 在系统提示词中注入可用工具列表和调用格式说明
- 模型输出中提取 `` `tool_call` `` 代码块来模拟函数调用
- 这种方式**非常不稳定**，模型可能：
  - 忽略工具调用指令，直接返回文本
  - 调用格式不对，无法解析
  - 产生幻觉，调用不存在的工具

如果你需要稳定的 Tool Calling，建议使用 Google 官方的 Gemini API。

## License

MIT
