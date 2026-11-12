import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { DotBotOptions } from "../options.ts"
import {
  captureScreenJpeg,
  injectRemoteInput,
  listWindows,
  REMOTE_INPUT_KINDS,
  type RemoteInputKind,
} from "../macos/desktop.ts"
import type { TakeoverManager } from "./manager.ts"

const COOKIE_NAME = "dotbot_auth"

function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error("Payload too large"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}

function discoverHostAddresses(bindHost: string): string[] {
  if (bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1") {
    return ["127.0.0.1"]
  }
  const tailscaleIps: string[] = []
  const lanIps: string[] = []
  const nets = networkInterfaces()
  for (const entries of Object.values(nets)) {
    if (!entries) continue
    for (const net of entries) {
      if (net.family !== "IPv4" || net.internal) continue
      // Tailscale CGNAT range 100.64.0.0/10
      const octets = net.address.split(".").map(Number)
      if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
        tailscaleIps.push(net.address)
      } else {
        lanIps.push(net.address)
      }
    }
  }
  // Order: Tailscale first (best for remote Web/Mobile), then LAN, then localhost
  return [...new Set([...tailscaleIps, ...lanIps, "127.0.0.1"])]
}

export class WebTakeoverConsole {
  private server: Server | null = null
  private boundPort: number | null = null
  private readonly token = randomBytes(24).toString("base64url")
  private readonly options: DotBotOptions
  private readonly takeovers: TakeoverManager

  constructor(options: DotBotOptions, takeovers: TakeoverManager) {
    this.options = options
    this.takeovers = takeovers
  }

  async start(): Promise<void> {
    if (!this.options.consoleEnabled || this.server) return

    const srv = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && this.options.consolePort !== 0) {
          srv.off("error", onError)
          srv.listen(0, this.options.consoleHost, () => resolve())
          return
        }
        reject(err)
      }
      srv.once("error", onError)
      srv.listen(this.options.consolePort, this.options.consoleHost, () => {
        srv.off("error", onError)
        resolve()
      })
    })

    const addr = srv.address()
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.options.consolePort
    this.server = srv
  }

  async dispose(): Promise<void> {
    if (!this.server) return
    const srv = this.server
    this.server = null
    this.boundPort = null
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }

  getUrls(sessionID?: string): string[] {
    if (!this.server || !this.boundPort) return []
    const suffix = sessionID
      ? `/?token=${encodeURIComponent(this.token)}&session=${encodeURIComponent(sessionID)}`
      : `/?token=${encodeURIComponent(this.token)}`

    const urls: string[] = []
    if (this.options.publicBaseUrl) {
      urls.push(`${this.options.publicBaseUrl}${suffix}`)
    }
    for (const host of discoverHostAddresses(this.options.consoleHost)) {
      urls.push(`http://${host}:${this.boundPort}${suffix}`)
    }
    return urls
  }

  private isAuthenticated(req: IncomingMessage, url: URL): { readonly ok: boolean; readonly fromQuery: boolean } {
    const queryToken = url.searchParams.get("token")
    if (queryToken && safeTokenEquals(queryToken, this.token)) {
      return { ok: true, fromQuery: true }
    }
    const headerToken = req.headers["x-dotbot-token"]
    if (typeof headerToken === "string" && safeTokenEquals(headerToken, this.token)) {
      return { ok: true, fromQuery: false }
    }
    const cookies = parseCookies(req.headers.cookie)
    if (cookies[COOKIE_NAME] && safeTokenEquals(cookies[COOKIE_NAME], this.token)) {
      return { ok: true, fromQuery: false }
    }
    return { ok: false, fromQuery: false }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
      const auth = this.isAuthenticated(req, url)
      if (!auth.ok) {
        res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Unauthorized: open this console using the signed link from OpenCode.")
        return
      }

      if (auth.fromQuery) {
        res.setHeader(
          "Set-Cookie",
          `${COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        )
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        })
        res.end(CONSOLE_HTML)
        return
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const windows = await listWindows()
        const payload = {
          takeovers: this.takeovers.list(),
          windows: windows.map((w) => ({
            id: w.id,
            appName: w.appName,
            title: w.title,
            isFocused: w.isFocused,
            bounds: w.bounds,
          })),
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        })
        res.end(JSON.stringify(payload))
        return
      }

      if (req.method === "GET" && url.pathname === "/api/frame") {
        const windowId = url.searchParams.get("windowId") || undefined
        const maxDim = Number(url.searchParams.get("maxDim") || this.options.maxImageDimension)
        const quality = Number(url.searchParams.get("quality") || 65)
        const frame = await captureScreenJpeg({
          windowId,
          maxDimension: Number.isFinite(maxDim) ? Math.max(640, Math.min(2560, maxDim)) : 1280,
          quality: Number.isFinite(quality) ? Math.max(30, Math.min(90, quality)) : 65,
        })
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "X-Image-Width": String(frame.imageWidth),
          "X-Image-Height": String(frame.imageHeight),
          "X-Logical-X": String(frame.logicalX),
          "X-Logical-Y": String(frame.logicalY),
          "X-Logical-Width": String(frame.logicalWidth),
          "X-Logical-Height": String(frame.logicalHeight),
        })
        res.end(frame.jpegBuffer)
        return
      }

      if (req.method === "POST" && url.pathname === "/api/input") {
        const body = await readJsonBody(req)
        const kind = String(body.kind ?? "") as RemoteInputKind
        if (!REMOTE_INPUT_KINDS.includes(kind)) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, detail: "Invalid input kind" }))
          return
        }
        const out = await injectRemoteInput({
          kind,
          x: typeof body.x === "number" ? body.x : undefined,
          y: typeof body.y === "number" ? body.y : undefined,
          deltaY: typeof body.deltaY === "number" ? body.deltaY : undefined,
          text: typeof body.text === "string" ? body.text : undefined,
          key: typeof body.key === "string" ? body.key : undefined,
          app: typeof body.app === "string" ? body.app : undefined,
        })
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        res.end(JSON.stringify(out))
        return
      }

      if (req.method === "POST" && url.pathname === "/api/resolve") {
        const body = await readJsonBody(req)
        const sessionID = typeof body.sessionID === "string" && body.sessionID ? body.sessionID : undefined
        const note = typeof body.note === "string" && body.note ? body.note : undefined
        const resolved = this.takeovers.resolveBySession(sessionID, note)
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: true, resolved: resolved.length }))
        return
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Not Found")
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }
}

const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#000000" />
  <title>Mac 远程控制 · OpenCode</title>
  <style>
    :root {
      color-scheme: dark;
      --glass: rgba(22, 22, 22, 0.78);
      --glass-border: rgba(255, 255, 255, 0.12);
      --surface-hover: rgba(255, 255, 255, 0.08);
      --surface-active: rgba(255, 255, 255, 0.14);
      --text-strong: rgba(255, 255, 255, 0.94);
      --text-base: rgba(255, 255, 255, 0.64);
      --text-weak: rgba(255, 255, 255, 0.42);
      --interactive: #9dbefe;
      --success: #7add71;
      --critical: #fc533a;
      --warning: #f5c84b;
      --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --radius: 10px;
      --shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      --safe-top: env(safe-area-inset-top);
      --safe-bottom: env(safe-area-inset-bottom);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; background: #000; }
    body {
      color: var(--text-strong);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 20px;
      -webkit-font-smoothing: antialiased;
      overscroll-behavior: none;
    }
    button, select, input { font: inherit; color: inherit; }
    button { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    :focus-visible { outline: 2px solid var(--interactive); outline-offset: 1px; }
    [hidden] { display: none !important; }

    /* 全屏画面 */
    #stage {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #screenWrap { position: relative; line-height: 0; }
    #screenImg {
      display: block;
      max-width: 100vw;
      max-height: 100dvh;
      width: auto;
      height: auto;
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      -webkit-touch-callout: none;
      cursor: crosshair;
    }
    #screenImg:not([src]) { width: 100vw; height: 100dvh; }
    #screenWrap[data-mode="view"] #screenImg { cursor: default; }
    .placeholder {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--text-weak);
      line-height: 20px;
      pointer-events: none;
    }
    .dot {
      position: absolute;
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      border: 2px solid var(--interactive);
      border-radius: 50%;
      pointer-events: none;
      animation: pulse 0.45s ease-out forwards;
    }
    @keyframes pulse {
      from { transform: scale(0.5); opacity: 1; }
      to { transform: scale(1.8); opacity: 0; }
    }

    /* 浮层通用 */
    .glass {
      background: var(--glass);
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      backdrop-filter: blur(16px) saturate(1.4);
    }
    .icon-btn {
      width: 32px;
      height: 32px;
      display: inline-grid;
      place-items: center;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--text-base);
    }
    .icon-btn:hover { background: var(--surface-hover); color: var(--text-strong); }
    .icon-btn[aria-pressed="true"] { background: var(--surface-active); color: var(--text-strong); }
    .icon-btn svg { width: 18px; height: 18px; }

    /* 悬浮把手：默认唯一可见的控件，闲置时变淡 */
    #handle {
      position: fixed;
      top: calc(10px + var(--safe-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border-radius: 999px;
      transition: opacity 0.3s, transform 0.25s;
    }
    #handle .icon-btn { border-radius: 999px; }
    #handle[data-idle="true"]:not(:hover):not(:focus-within) { opacity: 0.28; }
    body[data-top="open"] #handle { transform: translateX(-50%) translateY(-80px); opacity: 0; pointer-events: none; }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 46vw;
      padding: 0 10px 0 8px;
      color: var(--text-base);
      font-size: 12px;
      white-space: nowrap;
    }
    .status-pill span:last-child { overflow: hidden; text-overflow: ellipsis; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-weak); flex-shrink: 0; }
    .status-dot[data-state="online"] { background: var(--success); }
    .status-dot[data-state="error"] { background: var(--critical); }
    .status-dot[data-state="busy"] { background: var(--interactive); }

    /* 顶部工具栏：按需唤出 */
    #topbar {
      position: fixed;
      top: calc(8px + var(--safe-top));
      left: 50%;
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100vw - 16px);
      padding: 4px;
      border-radius: 12px;
      transform: translate(-50%, calc(-100% - 24px));
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    body[data-top="open"] #topbar { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
    .segmented {
      display: inline-flex;
      padding: 2px;
      gap: 2px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      flex-shrink: 0;
    }
    .segmented button {
      border: 0;
      background: transparent;
      color: var(--text-base);
      height: 28px;
      padding: 0 10px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .segmented button:hover { color: var(--text-strong); }
    .segmented button[aria-pressed="true"] { background: rgba(255, 255, 255, 0.16); color: var(--text-strong); }
    .select {
      height: 32px;
      max-width: 200px;
      min-width: 0;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid var(--glass-border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-strong);
    }
    .select option { background: #1c1c1c; }
    .vsep { width: 1px; height: 20px; background: var(--glass-border); flex-shrink: 0; }

    /* 底部输入坞：按需唤出 */
    #dock {
      position: fixed;
      left: 50%;
      bottom: calc(10px + var(--safe-bottom));
      z-index: 40;
      width: min(760px, calc(100vw - 16px));
      border-radius: 14px;
      transform: translate(-50%, calc(100% + 24px));
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    body[data-dock="open"] #dock { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
    #textForm { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; }
    #textInput {
      flex: 1;
      min-width: 0;
      height: 32px;
      border: 0;
      outline: 0;
      background: transparent;
      font-size: 15px;
    }
    #textInput::placeholder { color: var(--text-weak); }
    .send-btn {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: var(--text-strong);
      color: #111;
    }
    .send-btn:disabled { opacity: 0.25; cursor: default; }
    .send-btn svg { width: 16px; height: 16px; }
    .keys {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-top: 1px solid var(--glass-border);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .keys::-webkit-scrollbar { display: none; }
    .keys .vsep { height: 16px; margin: 0 2px; }
    .key {
      height: 28px;
      min-width: 28px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-base);
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .key:hover { background: var(--surface-hover); color: var(--text-strong); }
    .key:active { background: var(--surface-active); }

    /* 接管提示：AI 等待时始终显示 */
    #takeoverBanner {
      position: fixed;
      left: 50%;
      top: calc(58px + var(--safe-top));
      z-index: 35;
      display: none;
      align-items: center;
      gap: 10px;
      width: max-content;
      max-width: calc(100vw - 16px);
      padding: 6px 6px 6px 12px;
      border-radius: 12px;
      border-color: rgba(245, 200, 75, 0.45);
      transform: translateX(-50%);
    }
    #takeoverBanner[data-open="true"] { display: flex; }
    body[data-top="open"] #takeoverBanner { top: calc(62px + var(--safe-top)); }
    #takeoverBanner p { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #takeoverBanner .warn { color: var(--warning); flex-shrink: 0; }
    .btn-primary {
      height: 30px;
      padding: 0 12px;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: var(--text-strong);
      color: #111;
      font-weight: 560;
      white-space: nowrap;
    }
    .btn-primary:hover { opacity: 0.9; }

    @media (max-width: 720px) {
      #topbar { flex-wrap: wrap; justify-content: center; width: calc(100vw - 16px); }
      .segmented { width: 100%; }
      .segmented button { flex: 1; }
      .select { flex: 1; max-width: none; }
      #topbar > .vsep { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot { animation: none; opacity: 0.6; }
      #handle, #topbar, #dock { transition: none; }
    }
  </style>
</head>
<body data-top="closed" data-dock="closed">
  <div id="stage">
    <div id="screenWrap" data-mode="click">
      <img id="screenImg" alt="Mac 实时画面" />
      <div class="placeholder" id="placeholder">正在连接 Mac…</div>
    </div>
  </div>

  <div id="handle" class="glass" data-idle="false">
    <div class="status-pill" title="连接状态">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">连接中…</span>
    </div>
    <button class="icon-btn" id="dockToggle" type="button" title="键盘与输入 (Ctrl+K)" aria-label="键盘与输入" aria-pressed="false">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M5.5 8h1M9.5 8h1M13.5 8h1M6.5 12h7"/></svg>
    </button>
    <button class="icon-btn" id="topToggle" type="button" title="工具栏 (Ctrl+.)" aria-label="工具栏" aria-pressed="false">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 10h12M4 14h12"/></svg>
    </button>
  </div>

  <header id="topbar" class="glass">
    <div class="segmented" id="modeBar" role="group" aria-label="点击方式">
      <button type="button" data-mode="click" aria-pressed="true">单击</button>
      <button type="button" data-mode="double_click" aria-pressed="false">双击</button>
      <button type="button" data-mode="right_click" aria-pressed="false">右键</button>
      <button type="button" data-mode="view" aria-pressed="false">只看</button>
    </div>
    <span class="vsep"></span>
    <select class="select" id="windowSelect" aria-label="画面来源"><option value="">整个屏幕</option></select>
    <select class="select" id="fpsSelect" aria-label="刷新频率">
      <option value="900">每秒 1 帧</option>
      <option value="450">每秒 2 帧</option>
      <option value="2000">每 2 秒 1 帧</option>
      <option value="0">手动刷新</option>
    </select>
    <button class="icon-btn" id="refreshBtn" type="button" title="刷新画面" aria-label="刷新画面">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v3h-3"/></svg>
    </button>
    <button class="icon-btn" id="fullscreenBtn" type="button" title="浏览器全屏" aria-label="浏览器全屏">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg>
    </button>
    <button class="icon-btn" id="topClose" type="button" title="收起工具栏" aria-label="收起工具栏">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l5-5 5 5"/></svg>
    </button>
  </header>

  <div id="takeoverBanner" class="glass" role="alert">
    <span class="warn">●</span>
    <p id="takeoverReason">AI 在等你完成一步操作</p>
    <button class="btn-primary" id="resumeBtn" type="button">完成，交还 AI</button>
  </div>

  <div id="dock" class="glass">
    <form id="textForm">
      <input id="textInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="输入文字发送到 Mac 当前光标处" />
      <button class="send-btn" id="sendBtn" type="submit" title="发送" aria-label="发送" disabled>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4"/><path d="M5 9l5-5 5 5"/></svg>
      </button>
      <button class="icon-btn" id="dockClose" type="button" title="收起" aria-label="收起输入">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5l5 5 5-5"/></svg>
      </button>
    </form>
    <div class="keys" id="keyBar">
      <button class="key" type="button" data-key="return" title="回车">⏎ Return</button>
      <button class="key" type="button" data-key="escape" title="Esc">Esc</button>
      <button class="key" type="button" data-key="tab" title="Tab">⇥ Tab</button>
      <button class="key" type="button" data-key="delete" title="退格">⌫</button>
      <button class="key" type="button" data-key="space" title="空格">Space</button>
      <span class="vsep"></span>
      <button class="key" type="button" data-key="cmd+c" title="复制">⌘C</button>
      <button class="key" type="button" data-key="cmd+v" title="粘贴">⌘V</button>
      <span class="vsep"></span>
      <button class="key" type="button" data-key="up" title="上箭头">↑</button>
      <button class="key" type="button" data-key="down" title="下箭头">↓</button>
      <button class="key" type="button" id="scrollUpBtn" title="向上滚动">滚动 ↑</button>
      <button class="key" type="button" id="scrollDownBtn" title="向下滚动">滚动 ↓</button>
    </div>
  </div>

  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const targetSession = params.get("session") || "";
      if (params.has("token")) {
        params.delete("token");
        const clean = location.pathname + (params.toString() ? "?" + params.toString() : "");
        history.replaceState(null, "", clean);
      }

      const $ = (id) => document.getElementById(id);
      const img = $("screenImg");
      const wrap = $("screenWrap");
      const placeholder = $("placeholder");
      const statusText = $("statusText");
      const statusDot = $("statusDot");
      const handle = $("handle");
      const windowSelect = $("windowSelect");
      const fpsSelect = $("fpsSelect");
      const banner = $("takeoverBanner");
      const reasonEl = $("takeoverReason");
      const textInput = $("textInput");
      const sendBtn = $("sendBtn");
      const topToggle = $("topToggle");
      const dockToggle = $("dockToggle");

      let clickMode = "click";
      let logical = { x: 0, y: 0, w: 1920, h: 1080 };
      let lastPoint = { x: 960, y: 540 };
      let prevBlobUrl = null;
      let inFlight = false;
      let timer = null;
      let lastWheel = 0;
      let idleTimer = null;

      function setStatus(text, state) {
        statusText.textContent = text;
        if (state) statusDot.dataset.state = state;
      }

      // 悬浮把手闲置变淡
      function wake() {
        handle.dataset.idle = "false";
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { handle.dataset.idle = "true"; }, 2500);
      }
      ["pointermove", "pointerdown", "keydown"].forEach((t) => document.addEventListener(t, wake, { passive: true }));
      wake();

      // 面板唤出 / 收起
      function setTop(open) {
        document.body.dataset.top = open ? "open" : "closed";
        topToggle.setAttribute("aria-pressed", String(open));
      }
      function setDock(open) {
        document.body.dataset.dock = open ? "open" : "closed";
        dockToggle.setAttribute("aria-pressed", String(open));
        if (open) setTimeout(() => textInput.focus(), 60);
        else textInput.blur();
      }
      topToggle.addEventListener("click", () => setTop(document.body.dataset.top !== "open"));
      dockToggle.addEventListener("click", () => setDock(document.body.dataset.dock !== "open"));
      $("topClose").addEventListener("click", () => setTop(false));
      $("dockClose").addEventListener("click", () => setDock(false));
      document.addEventListener("keydown", (ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod && ev.key === "k") { ev.preventDefault(); setDock(document.body.dataset.dock !== "open"); }
        else if (mod && ev.key === ".") { ev.preventDefault(); setTop(document.body.dataset.top !== "open"); }
        else if (ev.key === "Escape" && (document.body.dataset.top === "open" || document.body.dataset.dock === "open")) {
          setTop(false);
          setDock(false);
        }
      });

      const fsBtn = $("fullscreenBtn");
      if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;
      fsBtn.addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      });

      document.querySelectorAll("#modeBar button[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          clickMode = btn.dataset.mode;
          wrap.dataset.mode = clickMode;
          document.querySelectorAll("#modeBar button[data-mode]").forEach((b) =>
            b.setAttribute("aria-pressed", String(b === btn))
          );
        });
      });

      async function fetchFrame() {
        if (inFlight || document.hidden) return;
        inFlight = true;
        try {
          const winId = windowSelect.value;
          const dim = Math.round(Math.max(screen.width, screen.height) * Math.min(devicePixelRatio || 1, 2));
          const q = "?maxDim=" + dim + (winId ? "&windowId=" + encodeURIComponent(winId) : "");
          const res = await fetch("/api/frame" + q, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          logical = {
            x: Number(res.headers.get("X-Logical-X") || 0),
            y: Number(res.headers.get("X-Logical-Y") || 0),
            w: Number(res.headers.get("X-Logical-Width") || 1920),
            h: Number(res.headers.get("X-Logical-Height") || 1080),
          };
          const blob = await res.blob();
          const nextUrl = URL.createObjectURL(blob);
          img.src = nextUrl;
          placeholder.hidden = true;
          if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
          prevBlobUrl = nextUrl;
          if (statusDot.dataset.state !== "busy") setStatus(Math.round(logical.w) + " × " + Math.round(logical.h), "online");
        } catch (e) {
          setStatus("画面获取失败：" + e.message, "error");
        } finally {
          inFlight = false;
        }
      }

      async function fetchState() {
        try {
          const res = await fetch("/api/state", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          if (document.activeElement !== windowSelect) {
            const currentVal = windowSelect.value;
            const opts = ['<option value="">整个屏幕</option>'];
            for (const w of data.windows || []) {
              const label = (w.title && w.title !== w.appName ? w.appName + "：" + w.title : w.appName).slice(0, 48);
              const sel = w.id === currentVal ? " selected" : "";
              const safeId = String(w.id).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              const safeLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              opts.push('<option value="' + safeId + '"' + sel + ">" + safeLabel + "</option>");
            }
            windowSelect.innerHTML = opts.join("");
          }

          const items = data.takeovers || [];
          const matched = targetSession ? items.find((t) => t.sessionID === targetSession) || items[0] : items[0];
          if (matched) {
            banner.dataset.open = "true";
            reasonEl.textContent = matched.reason;
            banner.dataset.session = matched.sessionID;
          } else {
            banner.dataset.open = "false";
          }
        } catch {}
      }

      function scheduleLoop() {
        if (timer) clearInterval(timer);
        const ms = Number(fpsSelect.value);
        if (ms > 0) timer = setInterval(fetchFrame, ms);
      }

      async function sendInput(payload) {
        setStatus("发送中…", "busy");
        wake();
        try {
          const res = await fetch("/api/input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const out = await res.json();
          setStatus(out.ok ? (out.detail || "已发送") : "失败：" + (out.detail || ""), out.ok ? "online" : "error");
          setTimeout(fetchFrame, 160);
        } catch (e) {
          setStatus("发送失败：" + e.message, "error");
        }
      }

      function toMac(ev) {
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const relX = (ev.clientX - rect.left) / rect.width;
        const relY = (ev.clientY - rect.top) / rect.height;
        return {
          x: logical.x + relX * logical.w,
          y: logical.y + relY * logical.h,
          px: ev.clientX - rect.left,
          py: ev.clientY - rect.top,
        };
      }

      function ripple(p) {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.left = p.px + "px";
        dot.style.top = p.py + "px";
        wrap.appendChild(dot);
        setTimeout(() => dot.remove(), 480);
      }

      img.addEventListener("click", (ev) => {
        setTop(false);
        if (clickMode === "view" || !img.src) return;
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        ripple(p);
        sendInput({ kind: clickMode, x: p.x, y: p.y });
      });

      img.addEventListener("contextmenu", (ev) => {
        if (clickMode === "view" || !img.src) return;
        ev.preventDefault();
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        ripple(p);
        sendInput({ kind: "right_click", x: p.x, y: p.y });
      });

      img.addEventListener("wheel", (ev) => {
        if (clickMode === "view" || !img.src) return;
        ev.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 250) return;
        lastWheel = now;
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        sendInput({ kind: "scroll", x: p.x, y: p.y, deltaY: ev.deltaY > 0 ? -3 : 3 });
      }, { passive: false });

      textInput.addEventListener("input", () => { sendBtn.disabled = !textInput.value; });

      $("textForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (!textInput.value) return;
        const text = textInput.value;
        textInput.value = "";
        sendBtn.disabled = true;
        sendInput({ kind: "type", text });
      });

      document.querySelectorAll("#keyBar button[data-key]").forEach((btn) => {
        btn.addEventListener("click", () => sendInput({ kind: "key", key: btn.dataset.key }));
      });

      $("scrollUpBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastPoint.x, y: lastPoint.y, deltaY: 5 })
      );
      $("scrollDownBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastPoint.x, y: lastPoint.y, deltaY: -5 })
      );

      $("refreshBtn").addEventListener("click", fetchFrame);
      windowSelect.addEventListener("change", fetchFrame);
      fpsSelect.addEventListener("change", scheduleLoop);

      $("resumeBtn").addEventListener("click", async () => {
        const sid = banner.dataset.session || targetSession || undefined;
        await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: sid, note: "User completed takeover via Web Console" }),
        });
        await fetchState();
        setStatus("已交还 AI", "online");
      });

      fetchState();
      fetchFrame();
      scheduleLoop();
      setInterval(fetchState, 3000);
    })();
  </script>
</body>
</html>
`
