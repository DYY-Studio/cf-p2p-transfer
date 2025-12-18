# CF-P2P-Transfer

快速、无需服务器存储的点对点文件传输工具。

本工具利用 Cloudflare 的生态系统建立连接，文件数据直接在用户之间传输（P2P），网络环境复杂时将通过 Cloudflare TURN 中继传输。

架构设计及验证和部分修正工作由本人完成，大多数代码工作由Gemini 3 Pro完成。

## ✨ 功能特性

* **完全无服务器架构**：后端逻辑全部运行在 Cloudflare Workers 上，无需维护 VPS。
* **费用低廉**：Cloudflare相关服务免费额度大，个人或小团队使用几乎0花销。
* **WebRTC P2P 传输**：文件点对点直传，速度仅受限于用户带宽，且不经过第三方存储。
* **企业级 NAT 穿透**：集成 **Cloudflare TURN** 服务，极大提高了内网穿透成功率。
* **房主/访客机制**：房主需批准访客加入（"敲门"机制），有效阻止未授权连接。
* **大文件支持**：前端集成 `StreamSaver.js`，支持流式写入硬盘。
* **安全防护**：集成 **Cloudflare Turnstile** 人机验证，防止接口滥用。
* **现代化 UI**：使用 Vue 3 + Naive UI，基本适配移动端，支持深色模式。

## 🚀 部署指南

### 前置要求

1. 一个 Cloudflare 账号<br>（如需使用TURN服务器，必须绑定信用卡）
2. 安装 Node.js 和 `npm` (或 pnpm/yarn)。
3. 安装并配置 Wrangler CLI (`npm install -g wrangler` && `wrangler login`)。

### 1. 克隆项目

```bash
git clone https://github.com/DYY-Studio/cf-p2p-transfer.git
cd cf-p2p-transfer
```

### 2. 配置 Cloudflare 服务

你需要获取以下密钥和配置：

* **Turnstile (人机验证)** 
  * 在 Cloudflare Dashboard -> Application Security -> Turnstile 中添加站点，获取 `Site Key` 和 `Secret Key`。
* (可选) **Cloudflare TURN Server** 
  * 在 Cloudflare Dashboard -> Media -> Realtime -> TURN Server 中创建一个 App，获取 `Key ID` 和 `API Token`。

### 3. 后端配置及部署 (Workers)

**配置 `wrangler.toml` / `wrangler.jsonc`**

```toml
# wrangler.toml
# 绑定 Durable Objects
[[durable_objects.bindings]]
name = "SIGNALING_DO"
class_name = "SignalingDurableObject"

# 迁移配置 (第一次部署需要)
[[migrations]]
tag = "v1"
new_classes = ["SignalingDurableObject"]
```

```jsonc
// wrangler.jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "SIGNALING_DO",
      "class_name": "SignalingDurableObject"
    }
  ]
},
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": [
      "SignalingDurableObject"
    ]
  }
],
```

**设置环境密钥 (Secrets)**

```bash
wrangler secret put TURN_KEY_ID         # 你的 TURN Server Key ID
wrangler secret put TURN_KEY_API_TOKEN  # 你的 TURN Server API Token
wrangler secret put TURNSTILE_SECRET_KEY # 你的 Turnstile Secret Key
```

**部署**
```bash
wrangler deploy
```

目前 Cloudflare Workers 和 Pages 已经合并，参照下面构建前端后，直接在根目录对本项目执行`wrangler deploy`可完成整体部署。

### 4. 前端配置及部署

在根目录下新建 `.env`，添加以下硬编码的配置：

1. **Worker 地址**:

`VITE_WORKER_HOST=<你的Worker地址>`

1. **Turnstile Site Key**:

`VITE_TURNSTILE_SITE_KEY=<你的 Turnstile Site Key>`

**安装依赖并运行:**

```bash
npm install
npm run dev
```

**构建生产版本:**

```bash
npm run build
```

你可以将构建产物 (`dist` 目录) 部署到 Cloudflare Pages、Vercel 或任何静态托管服务上。

## 📖 使用说明

1. **创建房间**：打开网页，完成人机验证（启用TURN时），输入任意房间号（或使用默认），点击“加入/创建”。
2. **成为房主**：第一个进入房间的用户自动成为**房主**。
3. **邀请好友**：将房间号分享给朋友。
4. **加入房间**：朋友（访客）输入相同的房间号加入。
5. **房主审核**：
   * 访客端显示“敲门中...”。
   * 房主端会弹出请求提示，点击“允许加入”。


6. **传输文件**：
   * 连接建立后（显示 P2P Connected），选择文件并发送。
   * 接收端需先选好是使用“**直接下载**”还是“**内存缓存**”接收文件。

7. **结束传输**:
   * 直接关闭或刷新页面即可退出房间。
   * 房主退出时，房间里的用户会被全部踢出，房间数据自动清空。

## 🤔 直接下载 还是 内存缓存？
> 直接下载: StreamSaver.js 流式保存到硬盘 <br> 内存缓存: 传统Blob数组，存储在内存中，完成后再整个提供给用户
* 能用直接下载就用！
* 内存缓存为兼容性方案，在传输大文件时会占用大量内存，可能导致网页崩溃

## ⚠️ 注意事项

* **Turnstile 验证**：必须通过人机验证才能得到 TURN 凭证，这是为了防止有心人消耗你的 Cloudflare TURN Server 用量。

## 🚧 中国大陆用户
* Cloudflare相关服务在中国大陆连接较为缓慢，体验可能不佳
* 不经过Cloudflare TURN的传输不受影响，但是连接WebSocket和通过TURN中转的速度可能较慢

## 🚨 保护你的站点
* 尽管使用了**Turnstile**阻止机器访问TURN，但是当前设计并没有限制谁能访问TURN
* 请务必使用**Cloudflare Zero Trust**，设置正确的策略，保护你的站点
* 如果需要对外开放，请务必移除TURN相关内容，或增加更好的保护策略

## 🛠️ 技术栈

**Frontend**

* Vue 3 (Composition API)
* TypeScript
* Naive UI (组件库)
* WebRTC (RTCPeerConnection, RTCDataChannel)
* StreamSaver.js (文件流式保存)
* Vue Turnstile (封装Cloudflare Turnstile)

**Backend (Cloudflare Workers)**

* Workers
* Durable Objects (WebSocket 房间状态管理)
* Realtime / TURN API
* Turnstile
* UAParser.js (为房主提供访客的基础信息)

## 📄 License

MIT License