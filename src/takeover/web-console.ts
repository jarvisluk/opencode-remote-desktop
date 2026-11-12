import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { DotBotOptions } from "../options.ts"
import { captureScreenJpeg, injectRemoteInput, listWindows } from "../macos/desktop.ts"
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
        const kind = String(body.kind ?? "") as any
        if (!["click", "double_click", "right_click", "scroll", "type", "key"].includes(kind)) {
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
  <title>OpenCode DotBot · Mac 远程控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #151921;
      --border: #262d3b;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #3b82f6;
      --green: #10b981;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    select, input, button {
      background: #1e2430;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }
    button { cursor: pointer; touch-action: manipulation; }
    button:active { opacity: 0.8; }
    button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.resume { background: var(--green); border-color: var(--green); color: #052e16; font-weight: 600; }
    #takeoverBanner {
      display: none;
      background: rgba(245, 158, 11, 0.14);
      border-bottom: 1px solid var(--amber);
      padding: 10px 12px;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
      padding: 6px;
      position: relative;
    }
    #screenWrap {
      position: relative;
      display: inline-block;
      max-width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: #000;
    }
    #screenImg {
      display: block;
      max-width: 100%;
      max-height: calc(100dvh - 165px);
      width: auto;
      height: auto;
      user-select: none;
      -webkit-user-drag: none;
      cursor: crosshair;
    }
    .dot {
      position: absolute;
      width: 16px;
      height: 16px;
      margin-left: -8px;
      margin-top: -8px;
      border: 2px solid var(--accent);
      border-radius: 50%;
      pointer-events: none;
      animation: pulse 0.45s ease-out forwards;
    }
    @keyframes pulse {
      from { transform: scale(0.5); opacity: 1; }
      to { transform: scale(2); opacity: 0; }
    }
    footer {
      background: var(--panel);
      border-top: 1px solid var(--border);
      padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #textForm { display: flex; gap: 6px; width: 100%; }
    #textInput { flex: 1; min-width: 120px; }
    #statusText { font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div id="takeoverBanner">
    <div id="takeoverReason" style="font-size:13px;">AI 正在等待人工接管验证…</div>
    <button class="resume" id="resumeBtn">已完成操作，交还 AI 继续</button>
  </div>

  <header>
    <div class="row">
      <strong style="font-size:13px;">Mac 画面</strong>
      <select id="windowSelect"><option value="">全屏主显示器</option></select>
      <select id="fpsSelect">
        <option value="900">流畅 (1.1 FPS)</option>
        <option value="450">高速 (2.2 FPS)</option>
        <option value="2000">省流 (0.5 FPS)</option>
        <option value="0">手动刷新</option>
      </select>
      <button id="refreshBtn">刷新</button>
    </div>
    <div class="row" id="modeBar">
      <button data-mode="click" class="active">左键</button>
      <button data-mode="double_click">双击</button>
      <button data-mode="right_click">右键</button>
      <button data-mode="view">仅浏览(防误触)</button>
      <span id="statusText">连接中…</span>
    </div>
  </header>

  <main>
    <div id="screenWrap">
      <img id="screenImg" alt="macOS live screen" />
    </div>
  </main>

  <footer>
    <form id="textForm">
      <input id="textInput" type="text" autocomplete="off" placeholder="输入验证码 / 密码 / 中文（直接发往 Mac 当前焦点，不经过 AI）" />
      <button type="submit">发送文字</button>
    </form>
    <div class="row">
      <button data-key="return">回车 ↵</button>
      <button data-key="escape">Esc</button>
      <button data-key="tab">Tab ⇥</button>
      <button data-key="delete">退格 ⌫</button>
      <button data-key="space">空格</button>
      <button data-key="cmd+v">⌘V</button>
      <button data-key="cmd+c">⌘C</button>
      <button data-key="up">↑</button>
      <button data-key="down">↓</button>
      <button id="scrollUpBtn">滚轮 ↑</button>
      <button id="scrollDownBtn">滚轮 ↓</button>
    </div>
  </footer>

  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const targetSession = params.get("session") || "";
      if (params.has("token")) {
        params.delete("token");
        const clean = location.pathname + (params.toString() ? "?" + params.toString() : "");
        history.replaceState(null, "", clean);
      }

      const img = document.getElementById("screenImg");
      const wrap = document.getElementById("screenWrap");
      const statusText = document.getElementById("statusText");
      const windowSelect = document.getElementById("windowSelect");
      const fpsSelect = document.getElementById("fpsSelect");
      const banner = document.getElementById("takeoverBanner");
      const reasonEl = document.getElementById("takeoverReason");

      let clickMode = "click";
      let logical = { x: 0, y: 0, w: 1920, h: 1080 };
      let lastLogicalCenter = { x: 960, y: 540 };
      let prevBlobUrl = null;
      let inFlight = false;
      let timer = null;

      document.querySelectorAll("#modeBar button[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          clickMode = btn.dataset.mode;
          document.querySelectorAll("#modeBar button[data-mode]").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          img.style.cursor = clickMode === "view" ? "grab" : "crosshair";
        });
      });

      async function fetchFrame() {
        if (inFlight || document.hidden) return;
        inFlight = true;
        try {
          const winId = windowSelect.value;
          const q = winId ? "?windowId=" + encodeURIComponent(winId) : "";
          const res = await fetch("/api/frame" + q, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          logical = {
            x: Number(res.headers.get("X-Logical-X") || 0),
            y: Number(res.headers.get("X-Logical-Y") || 0),
            w: Number(res.headers.get("X-Logical-Width") || 1920),
            h: Number(res.headers.get("X-Logical-Height") || 1080),
          };
          lastLogicalCenter = { x: logical.x + logical.w / 2, y: logical.y + logical.h / 2 };
          const blob = await res.blob();
          const nextUrl = URL.createObjectURL(blob);
          img.src = nextUrl;
          if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
          prevBlobUrl = nextUrl;
          statusText.textContent = Math.round(logical.w) + "×" + Math.round(logical.h) + " · 在线";
        } catch (e) {
          statusText.textContent = "等待画面: " + e.message;
        } finally {
          inFlight = false;
        }
      }

      async function fetchState() {
        try {
          const res = await fetch("/api/state", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          const currentVal = windowSelect.value;
          const opts = ['<option value="">全屏主显示器</option>'];
          for (const w of data.windows || []) {
            const label = (w.appName + (w.title ? " — " + w.title : "")).slice(0, 46);
            const sel = w.id === currentVal ? " selected" : "";
            opts.push('<option value="' + w.id + '"' + sel + ">" + label.replace(/</g, "&lt;") + "</option>");
          }
          windowSelect.innerHTML = opts.join("");

          const items = data.takeovers || [];
          const matched = targetSession ? items.find((t) => t.sessionID === targetSession) || items[0] : items[0];
          if (matched) {
            banner.style.display = "flex";
            reasonEl.textContent = "需要人工接管：" + matched.reason;
            banner.dataset.session = matched.sessionID;
          } else {
            banner.style.display = "none";
          }
        } catch {}
      }

      function scheduleLoop() {
        if (timer) clearInterval(timer);
        const ms = Number(fpsSelect.value);
        if (ms > 0) timer = setInterval(fetchFrame, ms);
      }

      async function sendInput(payload) {
        statusText.textContent = "执行中…";
        try {
          const res = await fetch("/api/input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const out = await res.json();
          statusText.textContent = out.ok ? (out.detail || "已发送") : ("失败: " + (out.detail || ""));
          setTimeout(fetchFrame, 160);
        } catch (e) {
          statusText.textContent = "发送失败: " + e.message;
        }
      }

      img.addEventListener("click", (ev) => {
        if (clickMode === "view") return;
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const relX = (ev.clientX - rect.left) / rect.width;
        const relY = (ev.clientY - rect.top) / rect.height;
        const macX = logical.x + relX * logical.w;
        const macY = logical.y + relY * logical.h;
        lastLogicalCenter = { x: macX, y: macY };

        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.left = (ev.clientX - rect.left) + "px";
        dot.style.top = (ev.clientY - rect.top) + "px";
        wrap.appendChild(dot);
        setTimeout(() => dot.remove(), 480);

        sendInput({ kind: clickMode, x: macX, y: macY });
      });

      img.addEventListener("contextmenu", (ev) => {
        if (clickMode === "view") return;
        ev.preventDefault();
        const rect = img.getBoundingClientRect();
        const macX = logical.x + ((ev.clientX - rect.left) / rect.width) * logical.w;
        const macY = logical.y + ((ev.clientY - rect.top) / rect.height) * logical.h;
        sendInput({ kind: "right_click", x: macX, y: macY });
      });

      document.getElementById("textForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = document.getElementById("textInput");
        if (!input.value) return;
        const text = input.value;
        input.value = "";
        sendInput({ kind: "type", text });
      });

      document.querySelectorAll("footer button[data-key]").forEach((btn) => {
        btn.addEventListener("click", () => sendInput({ kind: "key", key: btn.dataset.key }));
      });

      document.getElementById("scrollUpBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastLogicalCenter.x, y: lastLogicalCenter.y, deltaY: 5 })
      );
      document.getElementById("scrollDownBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastLogicalCenter.x, y: lastLogicalCenter.y, deltaY: -5 })
      );

      document.getElementById("refreshBtn").addEventListener("click", fetchFrame);
      windowSelect.addEventListener("change", fetchFrame);
      fpsSelect.addEventListener("change", scheduleLoop);

      document.getElementById("resumeBtn").addEventListener("click", async () => {
        const sid = banner.dataset.session || targetSession || undefined;
        await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: sid, note: "User completed takeover via Web Console" }),
        });
        await fetchState();
        statusText.textContent = "已交还 AI，请切回 OpenCode 查看进度";
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
