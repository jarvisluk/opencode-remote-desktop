# OpenCode Bot (macOS & Remote Web)

让 OpenCode 拥有一台**永远在线、AI 可驾驶、人可随时接管的真实 Mac 主机**。

当 OpenCode 以服务端形式运行在你的 macOS 机器（Mac mini、Mac Studio、MacBook）上时，Agent 直接操控这台**你自己的电脑**：复用本机已登录的浏览器与账号，通过原生无障碍树操作真实桌面应用；即使客户端断开，仍可在后台 7×24 常驻执行例行任务。遇到关键时刻（2FA 验证码、扫码登录、人脸识别、支付密码），AI 主动挂起并通过 Web 控制台把画面与键鼠**交还给你**，完成后一键恢复 AI 继续执行。

---

## 🌟 核心特性 (Features)

1. **真实桌面级自动化 (Desktop Automation via Accessibility)**
   - 基于 macOS 原生无障碍辅助树（Accessibility API）与 `agent-desktop`，不依赖不可靠的纯视觉坐标猜测，按 UI 语义树定位元素精确点击、聚焦与输入。
   - 真实键鼠注入支持（AppleScript / CGEvent / 系统剪贴板安全写入），平滑支持中英文输入法。

2. **浏览器登录态无缝复用 (Signed-in Browser Reuse)**
   - 自动探测宿主机运行中的 Microsoft Edge / Google Chrome 之 CDP 调试端口（`DevToolsActivePort`）。
   - 直接复用用户本地已登录的所有账号、Cookie 和插件，告别传统无头浏览器每次需要重新登录的困境。

3. **人机无缝接管 (Human Takeover State Machine)**
   - 当遇到验证码、两步验证、敏感支付确认时，Agent 主动发起 `computer_request_takeover` 工具调用。
   - OpenCode 会话自动进入挂起（Suspending）等待状态，并向用户提供专属 Web 接管控制台 URL（支持局域网或内网穿透公网访问）。
   - 用户在手机浏览器或电脑网页端打开控制台，即可查看宿主机屏幕实时预览，直接点击、滚轮滚动、打字，完成后点击 **"Resume AI"**，Agent 立即无缝继续。

4. **24/7 全天候防休眠与例行任务调度 (Keep-Awake & Routines)**
   - 在任务执行和等待接管期间，通过 `caffeinate` 进程动态保持 Mac 屏幕和系统清醒，任务结束后自动释放功耗。
   - 内置例行任务调度器（Routine Scheduler），支持 Cron 风格定时表达式与间隔周期，自动向 OpenCode 派发定时自动化会话。

5. **全端多通道 RPC 支持 (Cross-Network RPC)**
   - 实现了完整的 OpenCode RPC 契约定义（`BotRpc`），Web 客户端以及未来的 OpenCode 移动端 / 桌面端均可通过统一协议接收屏幕流、下发指令与处理接管事件。

---

## 📁 架构分层 (Architecture)

```text
┌────────────────────────────────────────────────────────┐
│            OpenCode Web / Mobile Client                │
│  (Chat Session + Live Takeover Canvas Web Console)     │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP / RPC / WebSocket
┌──────────────────────────▼─────────────────────────────┐
│          OpenCode Server (macOS Host Machine)          │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ opencode-bot Plugin                              │  │
│  │  - TakeoverManager (挂起/恢复状态机)             │  │
│  │  - BotRpc (面板 / Web 控制台共用的唯一通道)      │  │
│  │  - RoutineScheduler (全天候后台定时器)           │  │
│  │  - KeepAwakeController (caffeinate 防休眠)       │  │
│  └───────────────┬───────────────────┬──────────────┘  │
│                  │                   │                 │
│  ┌───────────────▼────────┐ ┌────────▼──────────────┐  │
│  │ agent-desktop (macOS)  │ │ CDP / agent-browser   │  │
│  │ Accessibility Tree &   │ │ Connect to host Edge  │  │
│  │ CGEvent Input          │ │ or Chrome             │  │
│  └────────────────────────┘ └───────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 🛠 工具与命令列表 (Tools & Commands)

### 原生侧边栏标签页 (Native Side Panel)
- **实时屏幕侧边栏 (Live Screen Tab)**:
  - 侧边栏支持直接打开 Live Screen Tab（`region: "side"`）。
  - 仅在 App 连接远端服务（如 OpenTunnel、局域网/Tailscale 地址）时出现；连本机服务时面板、`+` 菜单项和 `/screen` 都会隐藏。
  - OpenCode Desktop 只加载**本机**服务上插件的界面，所以控制端也要装本插件，并设 `"host": false`：只提供侧边栏，不注册 `computer_*` 工具、不开接管控制台：
    ```json
    "plugins": [{ "package": "/path/to/opencode-bot", "options": { "host": false } }]
    ```
  - 支持快捷键 `Cmd+Shift+S` 或输入 `/screen` 或点击侧边栏 `+` 菜单快速呼出。
  - 直接在 OpenCode 内实时观看远端 macOS 桌面（1~4 FPS 动态可调，150ms 超低延迟）。
  - **直接远程操作**：支持鼠标点击（Click）、双击（Double Click）、右键菜单（Right Click）、滚轮滑动（Scroll）。
  - **文本与键盘输入**：支持剪贴板无损文本键入及各种常用功能键（Return、Esc、Tab、Cmd+C、Cmd+V、Cmd+W、方向键等）。
  - **窗口聚焦切换**：下拉直接切换并置顶宿主机上的任何前台应用窗口。
  - **无缝接管恢复**：AI 请求接管时侧边栏顶部直接亮起接管横幅，用户操作完成后点击“完成并恢复 AI”即可自动唤醒 AI Agent 继续执行。

### AI 工具 (Tools)
- `computer_status`: 获取宿主机操作系统、屏幕分辨率、无障碍权限以及接管控制台运行状态。
- `computer_screenshot`: 高性能捕获当前屏幕或指定窗口，返回压缩 JPEG 及逻辑显示坐标。
- `computer_desktop`: 运行原生桌面动作（`snapshot` 读取无障碍树、`click`、`type`、`press`、`scroll`）。
- `computer_browser`: 操作宿主机 Edge/Chrome 浏览器（`open`、`snapshot`、`click`、`type`、`eval`）。
- `computer_request_takeover`: 请求人类接管屏幕并挂起当前会话，返回接管链接并在侧边栏高亮提示。
- `computer_routine`: 管理全天候例行任务（`list`、`add`、`remove`）。
- `computer_secret_request`: 在 Live Screen / 网页控制台弹出密钥输入卡片并等待提交，值直接存入 macOS 钥匙串（服务名 `opencode-bot`），不会返回给 Agent。
- `computer_secret_type`: 把已存的密钥输入到桌面元素（`agent-desktop type`），只返回成功或失败。已知限制：钥匙串条目由 `/usr/bin/security` 写入，同一用户的 `security find-generic-password` 可直接读出，插件只能让这类 shell 命令弹出确认；输入时密码会短暂出现在 `agent-desktop` 的进程参数里。

### 斜杠命令 (Slash Commands)
- `/screen`: 切换/打开侧边栏实时远程屏幕（Live Screen Tab）。
- `/bot-link`: 给出 Web 控制台链接，在手机/浏览器中打开远程屏幕；链接不含任何凭证，可安全发进会话。
- `/bot`: 查看 Bot 状态与 Web 控制台入口。

接管时，若控制端没有 Live Screen 面板（手机、未装插件，由 GUI 插件每 15 秒的心跳判断），会自动把控制台链接发进会话；完全没有心跳时，还会提示 agent 用侧边浏览器打开。

### Web / 手机控制台 (Web Console)
- 一个静态页面（`npm run build:pages` 生成到 `pages/`），部署在 Cloudflare Pages：`npx wrangler pages deploy pages --project-name bot-console`。
- 页面在浏览器里直接调用 OpenCode 服务器上的插件 RPC（`POST <server>/api/rpc/bot/<method>`），走服务器自带的密码认证和远程访问隧道；插件自己不再开端口。
- 链接形如 `https://bot-console.pages.dev/#server=<服务器地址>&session=<会话>`，参数放在 `#` 后，不会发给 Pages。首次打开输入 OpenCode 服务器密码，之后保存在该浏览器的 localStorage 中。
- 服务器地址默认取 OpenCode 远程访问隧道（`opencode service set remote true`），也可用插件选项 `serverUrl` 指定；`consoleUrl` 改页面地址，设为 `""` 关闭链接。
- 服务器需要允许页面来源跨域：`opencode service set cors https://bot-console.pages.dev`（会重启后台服务）。
- `/doctor`: 宿主机依赖体检（agent CLI 及版本、原生 sidecar、TCC 权限），给出修复建议。
- `/takeover`: 手动挂起会话并请求人类接管。
- `/routine`: 列出或管理例行任务。

---

## 🚀 安装与配置 (Installation)

### 1. 确保宿主机环境已安装依赖
macOS 宿主机需要安装 `agent-desktop` 与 `agent-browser`（vercel-labs 开源 CLI）：
```bash
# 安装两个 CLI（npm 全局装或 brew 均可）
npm install -g agent-desktop agent-browser
# 首次使用 agent-browser 需下载 Chrome for Testing
agent-browser install
# 按交互引导授予 macOS 辅助功能与屏幕录制权限
agent-desktop permissions --guide
```

安装完成后在 OpenCode 中运行 `/doctor` 一键体检：CLI 是否就绪及版本、TCC 权限、原生直播 sidecar、浏览器连接模式，缺什么会直接给出修复命令。

启用 WebRTC 低延迟直播（可选，否则自动降级为 JPEG 轮询）：
```bash
npm run build:native   # 需要 Go 与 swiftc
```

### 2. 在 OpenCode 配置文件中注册插件
在 `~/.config/opencode/opencode.json` 的 `plugins` 中添加本地插件路径：
```json
{
  "plugins": [
    "/Users/zippy/codespace/opencode-bot"
  ]
}
```

可选用参数配置：
```json
{
  "plugins": [
    {
      "source": "/Users/zippy/codespace/opencode-bot",
      "options": {
        "consoleUrl": "https://bot-console.pages.dev",
        "keepAwake": "active",
        "reuseHostBrowser": true,
        "maxImageDimension": 1440,
        "jpegQuality": 72
      }
    }
  ]
}
```

---

## 🧪 自动化测试 (Testing)

```bash
cd /Users/zippy/codespace/opencode-bot
node --test test/core.test.ts
```
