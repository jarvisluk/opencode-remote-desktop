import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveBinary, runCommand } from "./exec.ts"
import { binaryPath } from "../stream/sidecar.ts"

import { REMOTE_INPUT_KINDS, type RemoteInputKind } from "../input-types.ts"
export { REMOTE_INPUT_KINDS, type RemoteInputKind }

export interface DisplayBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MacDisplayInfo {
  readonly id: string
  readonly isPrimary: boolean
  readonly scale: number
  readonly bounds: DisplayBounds
}

export interface MacWindowInfo {
  readonly id: string
  readonly appName: string
  readonly title: string
  readonly isFocused: boolean
  readonly visible: boolean
  readonly accessible: boolean
  readonly bounds: DisplayBounds
}

export interface MacDesktopStatus {
  readonly platform: string
  readonly supported: boolean
  readonly agentDesktopInstalled: boolean
  readonly accessibility: string
  readonly screenRecording: string
  readonly displays: readonly MacDisplayInfo[]
}

export interface CapturedFrame {
  readonly jpegPath: string
  readonly jpegBuffer: Buffer
  readonly imageWidth: number
  readonly imageHeight: number
  readonly logicalX: number
  readonly logicalY: number
  readonly logicalWidth: number
  readonly logicalHeight: number
  readonly timestamp: number
}

function getTempCaptureDir(): string {
  return join(tmpdir(), "opencode-bot-captures")
}

function parseJsonSafe(raw: string): any {
  try {
    return JSON.parse(raw.trim())
  } catch {
    return null
  }
}

export async function getMacDesktopStatus(signal?: AbortSignal): Promise<MacDesktopStatus> {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      supported: false,
      agentDesktopInstalled: false,
      accessibility: "unsupported",
      screenRecording: "unsupported",
      displays: [],
    }
  }

  const bin = resolveBinary("agent-desktop")
  if (!bin) {
    return {
      platform: "darwin",
      supported: true,
      agentDesktopInstalled: false,
      accessibility: "missing_agent_desktop",
      screenRecording: "missing_agent_desktop",
      displays: [],
    }
  }

  const [statusRes, displays] = await Promise.all([
    runCommand(bin, ["status"], { timeoutMs: 8_000, signal }),
    listDisplays(signal),
  ])

  const parsed = parseJsonSafe(statusRes.stdout)
  const perms = parsed?.data?.permissions ?? {}

  return {
    platform: "darwin",
    supported: true,
    agentDesktopInstalled: true,
    accessibility: String(perms?.accessibility?.state ?? "unknown"),
    screenRecording: String(perms?.screen_recording?.state ?? "unknown"),
    displays,
  }
}

let cachedDisplays: { data: MacDisplayInfo[]; timestamp: number } | null = null
const DISPLAYS_CACHE_TTL_MS = 5_000

export async function listDisplays(signal?: AbortSignal, forceRefresh = false): Promise<MacDisplayInfo[]> {
  const now = Date.now()
  if (!forceRefresh && cachedDisplays && now - cachedDisplays.timestamp < DISPLAYS_CACHE_TTL_MS) {
    return cachedDisplays.data
  }
  const bin = resolveBinary("agent-desktop")
  if (!bin) return []
  const res = await runCommand(bin, ["list-displays"], { timeoutMs: 8_000, signal })
  const parsed = parseJsonSafe(res.stdout)
  if (!parsed?.ok || !Array.isArray(parsed.data)) return cachedDisplays?.data ?? []
  const displays = parsed.data.map((d: any) => ({
    id: String(d.id ?? "0"),
    isPrimary: Boolean(d.is_primary),
    scale: typeof d.scale === "number" && d.scale > 0 ? d.scale : 1,
    bounds: {
      x: Number(d.bounds?.x ?? 0),
      y: Number(d.bounds?.y ?? 0),
      width: Number(d.bounds?.width ?? 1920),
      height: Number(d.bounds?.height ?? 1080),
    },
  }))
  cachedDisplays = { data: displays, timestamp: now }
  return displays
}

const WINDOWS_CACHE_TTL_MS = 2_000
const cachedWindows = new Map<string, { data: MacWindowInfo[]; timestamp: number }>()
const inFlightWindows = new Map<string, Promise<MacWindowInfo[]>>()

export async function listWindows(app?: string, signal?: AbortSignal, forceRefresh = false): Promise<MacWindowInfo[]> {
  const key = app ?? ""
  const now = Date.now()
  if (!forceRefresh) {
    const cached = cachedWindows.get(key)
    if (cached && now - cached.timestamp < WINDOWS_CACHE_TTL_MS) {
      return cached.data
    }
    const existing = inFlightWindows.get(key)
    if (existing) return existing
  }
  const mapRawWindows = (rows: any[]): MacWindowInfo[] =>
    rows
      .filter((w: any) => w.visible !== false && w.app_name !== "WindowManager" && Number(w.bounds?.width ?? 0) >= 80)
      .map((w: any) => ({
        id: String(w.id ?? ""),
        appName: String(w.app_name ?? ""),
        title: String(w.title ?? ""),
        isFocused: Boolean(w.is_focused),
        visible: Boolean(w.visible),
        accessible: Boolean(w.accessible),
        bounds: {
          x: Number(w.bounds?.x ?? 0),
          y: Number(w.bounds?.y ?? 0),
          width: Number(w.bounds?.width ?? 0),
          height: Number(w.bounds?.height ?? 0),
        },
      }))

  const task = (async () => {
    if (process.platform === "darwin") {
      try {
        const res = await snapServer.request({ cmd: "list-windows", app: app || undefined, signal }, 1_500)
        const rows = JSON.parse(res.jpegBuffer.toString("utf8"))
        if (Array.isArray(rows)) {
          const windows = mapRawWindows(rows)
          cachedWindows.set(key, { data: windows, timestamp: Date.now() })
          return windows
        }
      } catch {
        // Fall through to agent-desktop CLI
      }
    }
    const bin = resolveBinary("agent-desktop")
    if (!bin) return []
    const args = ["list-windows"]
    if (app) args.push("--app", app)
    const res = await runCommand(bin, args, { timeoutMs: 2_000, signal })
    const parsed = parseJsonSafe(res.stdout)
    if (!parsed?.ok || !Array.isArray(parsed.data)) {
      const fallback = cachedWindows.get(key)?.data ?? []
      cachedWindows.set(key, { data: fallback, timestamp: Date.now() })
      return fallback
    }
    const windows = mapRawWindows(parsed.data)
    cachedWindows.set(key, { data: windows, timestamp: Date.now() })
    return windows
  })().finally(() => {
    inFlightWindows.delete(key)
  })
  inFlightWindows.set(key, task)
  return task
}

export function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]
    offset += 2
    // SOF markers: SOF0 (0xC0) through SOF15 (0xCF), excluding DHT (0xC4), JPG (0xC8), DAC (0xCC)
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isSof) {
      if (offset + 7 <= buffer.length) {
        // [length: 2 bytes] [precision: 1 byte] [height: 2 bytes] [width: 2 bytes]
        const height = buffer.readUInt16BE(offset + 3)
        const width = buffer.readUInt16BE(offset + 5)
        return { width, height }
      }
      break
    }
    if (marker === 0xd9 || marker === 0xda) {
      // EOI or SOS (start of scan)
      break
    }
    if (offset + 2 <= buffer.length) {
      const length = buffer.readUInt16BE(offset)
      offset += length
    } else {
      break
    }
  }
  return null
}

async function readImageDimensions(filePath: string, jpegBuffer?: Buffer, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  if (jpegBuffer) {
    const parsed = parseJpegDimensions(jpegBuffer)
    if (parsed && parsed.width > 0 && parsed.height > 0) {
      return parsed
    }
  }
  const res = await runCommand("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
    timeoutMs: 5_000,
    signal,
  })
  const widthMatch = res.stdout.match(/pixelWidth:\s*(\d+)/)
  const heightMatch = res.stdout.match(/pixelHeight:\s*(\d+)/)
  return {
    width: widthMatch ? Number(widthMatch[1]) : 1920,
    height: heightMatch ? Number(heightMatch[1]) : 1080,
  }
}

// In-flight capture singleflight map to avoid duplicate external process calls
const inFlightCaptures = new Map<string, Promise<CapturedFrame>>()

interface SnapPending {
  resolve: (frame: CapturedFrame) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class SnapServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readyPromise: Promise<void> | null = null
  private nextId = 1
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private pending = new Map<number, SnapPending>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disabled = false

  private resetIdle() {
    clearTimeout(this.idleTimer)
    if (this.pending.size > 0) {
      this.proc?.ref()
      return
    }
    this.proc?.unref()
    ;(this.proc?.stdout as any)?.unref?.()
    ;(this.proc?.stderr as any)?.unref?.()
    ;(this.proc?.stdin as any)?.unref?.()
    this.idleTimer = setTimeout(() => this.dispose(), 60_000)
    this.idleTimer.unref?.()
  }

  private failAll(reason: string) {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error("snap-server disabled"))
    if (this.readyPromise) return this.readyPromise
    const bin = binaryPath("bot-capture")
    if (!existsSync(bin)) return Promise.reject(new Error("bot-capture missing"))

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["--snap-server"], { stdio: ["pipe", "pipe", "pipe"] })
      this.proc = child
      this.buf = Buffer.alloc(0)
      let settled = false
      let errTail = ""

      const bootTimer = setTimeout(() => {
        if (settled) return
        settled = true
        this.dispose()
        reject(new Error(`snap-server startup timeout${errTail ? `: ${errTail}` : ""}`))
      }, 3_000)

      child.stderr.on("data", (chunk: Buffer) => {
        errTail = (errTail + chunk.toString("utf8")).slice(-512)
        if (!settled && errTail.includes("snap-ready")) {
          settled = true
          clearTimeout(bootTimer)
          resolve()
        }
      })

      child.stdout.on("data", (chunk: Buffer) => {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
        while (this.buf.length >= 33) {
          const payloadLen = this.buf.readUInt32BE(28)
          if (this.buf.length < 33 + payloadLen) break
          const id = this.buf.readUInt32BE(0)
          const imageWidth = this.buf.readUInt32BE(4)
          const imageHeight = this.buf.readUInt32BE(8)
          const logicalX = this.buf.readInt32BE(12)
          const logicalY = this.buf.readInt32BE(16)
          const logicalWidth = this.buf.readUInt32BE(20)
          const logicalHeight = this.buf.readUInt32BE(24)
          const status = this.buf.readUInt8(32)
          const payload = Buffer.allocUnsafe(payloadLen)
          this.buf.copy(payload, 0, 33, 33 + payloadLen)
          this.buf = this.buf.subarray(33 + payloadLen)

          const req = this.pending.get(id)
          if (!req) continue
          this.pending.delete(id)
          clearTimeout(req.timer)
          this.resetIdle()
          if (status !== 0) {
            req.reject(new Error(payload.toString("utf8") || "snap-server capture failed"))
          } else {
            req.resolve({
              jpegPath: "",
              jpegBuffer: payload,
              imageWidth,
              imageHeight,
              logicalX,
              logicalY,
              logicalWidth,
              logicalHeight,
              timestamp: Date.now(),
            })
          }
        }
      })

      child.on("exit", (code) => {
        clearTimeout(bootTimer)
        if (this.proc === child) {
          this.proc = null
          this.readyPromise = null
        }
        if (!settled) {
          settled = true
          if (errTail.includes("requires macOS 14")) this.disabled = true
          reject(new Error(`snap-server exited (${code})${errTail ? `: ${errTail}` : ""}`))
        }
        this.failAll(`snap-server exited (${code})`)
      })

      child.on("error", (err) => {
        clearTimeout(bootTimer)
        if (this.proc === child) {
          this.proc = null
          this.readyPromise = null
        }
        if (!settled) {
          settled = true
          reject(err)
        }
        this.failAll(err.message)
      })
    })
    return this.readyPromise
  }

  async request(
    payload: Record<string, unknown> & { readonly signal?: AbortSignal },
    timeoutMs = 10_000,
  ): Promise<CapturedFrame> {
    await this.ensureStarted()
    const proc = this.proc
    if (!proc || proc.killed) throw new Error("snap-server not running")
    clearTimeout(this.idleTimer)

    const id = this.nextId++
    if (this.nextId > 0x7fff_ff00) this.nextId = 1
    const { signal, ...rest } = payload
    proc.ref()
    ;(proc.stdout as any)?.ref?.()
    ;(proc.stderr as any)?.ref?.()

    return new Promise<CapturedFrame>((resolve, reject) => {
      const onAbort = () => {
        const req = this.pending.get(id)
        if (req) {
          clearTimeout(req.timer)
          this.pending.delete(id)
          this.resetIdle()
        }
        reject(new Error("Screenshot aborted"))
      }
      if (signal?.aborted) return onAbort()

      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        this.dispose()
        reject(new Error("snap-server request timeout"))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (frame) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(frame)
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort)
          reject(err)
        },
        timer,
      })
      signal?.addEventListener("abort", onAbort, { once: true })

      const line = JSON.stringify({ id, ...rest })
      proc.stdin.write(`${line}\n`)
    })
  }

  async capture(options?: {
    readonly windowId?: string
    readonly app?: string
    readonly screenIndex?: number
    readonly maxDimension?: number
    readonly quality?: number
    readonly signal?: AbortSignal
  }): Promise<CapturedFrame> {
    return this.request({
      screen: options?.screenIndex ?? 0,
      maxDim: options?.maxDimension ?? 1440,
      quality: options?.quality ?? 72,
      ...(options?.windowId ? { windowId: options.windowId } : {}),
      ...(options?.app ? { app: options.app } : {}),
      signal: options?.signal,
    })
  }

  dispose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const p = this.proc
    this.proc = null
    this.readyPromise = null
    if (p && !p.killed) p.kill("SIGTERM")
    this.failAll("snap-server disposed")
  }
}

const snapServer = new SnapServerClient()
process.once("exit", () => snapServer.dispose())

export function disposeDesktopHelpers(): void {
  snapServer.dispose()
}

export async function captureScreenJpeg(options?: {
  readonly windowId?: string
  readonly app?: string
  readonly screenIndex?: number
  readonly maxDimension?: number
  readonly quality?: number
  readonly keepFile?: boolean
  readonly signal?: AbortSignal
}): Promise<CapturedFrame> {
  const cacheKey = [
    options?.windowId ?? "",
    options?.app ?? "",
    options?.screenIndex ?? 0,
    options?.maxDimension ?? 1440,
    options?.quality ?? 72,
    Boolean(options?.keepFile),
  ].join(":")

  const existing = inFlightCaptures.get(cacheKey)
  if (existing) {
    return existing
  }

  const promise = doCaptureScreenJpeg(options).finally(() => {
    inFlightCaptures.delete(cacheKey)
  })
  inFlightCaptures.set(cacheKey, promise)
  return promise
}

async function doCaptureScreenJpeg(options?: {
  readonly windowId?: string
  readonly app?: string
  readonly screenIndex?: number
  readonly maxDimension?: number
  readonly quality?: number
  readonly keepFile?: boolean
  readonly signal?: AbortSignal
}): Promise<CapturedFrame> {
  // Fast path: resident ScreenCaptureKit in-memory JPEG encoder (~45 ms/frame, zero disk I/O).
  if (process.platform === "darwin") {
    try {
      const fast = await snapServer.capture(options)
      if (options?.keepFile) {
        const dir = getTempCaptureDir()
        await mkdir(dir, { recursive: true })
        const outJpg = join(dir, `${randomUUID()}.jpg`)
        await writeFile(outJpg, fast.jpegBuffer)
        return { ...fast, jpegPath: outJpg }
      }
      return fast
    } catch (err: any) {
      // Surface missing window errors immediately instead of running a redundant fallback process.
      if (typeof err?.message === "string" && err.message.includes("Window not found")) {
        throw new Error(`Window not found for screenshot: ${options?.windowId ? `id=${options.windowId}` : `app=${options?.app}`}`)
      }
      // Fall back to agent-desktop/screencapture + sips if bot-capture is unavailable or aborted.
      if (options?.signal?.aborted) throw err
    }
  }

  const dir = getTempCaptureDir()
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const rawPng = join(dir, `${id}.png`)
  const outJpg = join(dir, `${id}.jpg`)
  const maxDimension = options?.maxDimension ?? 1440
  const quality = options?.quality ?? 72
  const signal = options?.signal

  // Determine fallback bounds from primary display instead of hardcoded 1920x1080
  const displays = await listDisplays(signal)
  const primaryDisplay = displays.find((d) => d.isPrimary) ?? displays[0]
  let logicalBounds: DisplayBounds = primaryDisplay?.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 }

  try {
    const adBin = resolveBinary("agent-desktop")
    if (adBin && (options?.windowId || options?.app)) {
      const windows = await listWindows(options.app, signal)
      const matched = options.windowId
        ? windows.find((w) => w.id === options.windowId)
        : windows[0]
      if (matched && matched.bounds.width > 0 && matched.bounds.height > 0) {
        logicalBounds = matched.bounds
      } else if (options.windowId || options.app) {
        // Issue 3: If an app or windowId was explicitly requested but not found, throw error instead of using wrong bounds
        throw new Error(`Window not found for screenshot: ${options.windowId ? `id=${options.windowId}` : `app=${options.app}`}`)
      }

      const args = ["screenshot"]
      if (options.windowId) args.push("--window-id", options.windowId)
      else if (options.app) args.push("--app", options.app)
      args.push(rawPng)
      const shot = await runCommand(adBin, args, { timeoutMs: 12_000, signal })
      if (shot.code !== 0) {
        throw new Error(`agent-desktop screenshot failed: ${shot.stderr || shot.stdout}`)
      }
    } else {
      const idx = options?.screenIndex ?? 0
      const targetDisplay = displays[idx] ?? primaryDisplay
      if (targetDisplay) {
        logicalBounds = targetDisplay.bounds
      }

      if (adBin) {
        const shot = await runCommand(adBin, ["screenshot", "--screen", String(idx), rawPng], {
          timeoutMs: 12_000,
          signal,
        })
        if (shot.code !== 0) {
          // Fallback to macOS native screencapture
          const sc = await runCommand("screencapture", ["-x", "-D", String(idx + 1), rawPng], {
            timeoutMs: 12_000,
            signal,
          })
          if (sc.code !== 0) {
            throw new Error(`Screen capture failed (check macOS Screen Recording permission): ${sc.stderr || shot.stderr}`)
          }
        }
      } else {
        const sc = await runCommand("screencapture", ["-x", "-D", String(idx + 1), rawPng], {
          timeoutMs: 12_000,
          signal,
        })
        if (sc.code !== 0) {
          throw new Error(`screencapture failed: ${sc.stderr}`)
        }
      }
    }

    // Resize & compress PNG -> JPEG using built-in macOS `sips`
    const sipsArgs = [
      "-Z",
      String(maxDimension),
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(quality),
      rawPng,
      "--out",
      outJpg,
    ]
    const conv = await runCommand("sips", sipsArgs, { timeoutMs: 10_000, signal })
    if (conv.code !== 0) {
      throw new Error(`sips conversion failed: ${conv.stderr || conv.stdout}`)
    }

    const jpegBuffer = await readFile(outJpg)
    const dims = await readImageDimensions(outJpg, jpegBuffer, signal)

    return {
      jpegPath: outJpg,
      jpegBuffer,
      imageWidth: dims.width,
      imageHeight: dims.height,
      logicalX: logicalBounds.x,
      logicalY: logicalBounds.y,
      logicalWidth: logicalBounds.width,
      logicalHeight: logicalBounds.height,
      timestamp: Date.now(),
    }
  } finally {
    await rm(rawPng, { force: true }).catch(() => {})
    if (!options?.keepFile) {
      await rm(outJpg, { force: true }).catch(() => {})
    }
  }
}

export async function runAgentDesktop(
  args: readonly string[],
  options?: { readonly headed?: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<{ readonly ok: boolean; readonly raw: string; readonly parsed: any }> {
  const bin = resolveBinary("agent-desktop")
  if (!bin) {
    return {
      ok: false,
      raw: "agent-desktop is not installed. Install it with `npm install -g agent-desktop` (or `brew install agent-desktop`), then run `agent-desktop permissions --guide` to grant Accessibility & Screen Recording.",
      parsed: null,
    }
  }
  const fullArgs = options?.headed ? ["--headed", ...args] : [...args]
  const res = await runCommand(bin, fullArgs, {
    timeoutMs: options?.timeoutMs ?? 25_000,
    signal: options?.signal,
  })
  const output = (res.stdout || res.stderr).trim()
  const parsed = parseJsonSafe(res.stdout)
  return {
    ok: res.code === 0 && (parsed ? parsed.ok !== false : true),
    raw: output,
    parsed,
  }
}

function pbcopy(text: string): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    proc.stderr.on("data", (d) => { stderr += d })
    proc.on("error", (err) => resolve({ ok: false, detail: err.message }))
    proc.on("close", (code) => resolve({ ok: code === 0, detail: stderr.trim() || undefined }))
    proc.stdin.end(text)
  })
}

function formatCoordPair(x: number, y: number): string {
  return `--xy=${Math.round(x)},${Math.round(y)}`
}

export async function injectRemoteInput(
  input: {
    readonly kind: RemoteInputKind
    readonly x?: number
    readonly y?: number
    readonly deltaY?: number
    readonly text?: string
    readonly key?: string
    readonly app?: string
  },
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  if (input.kind === "click" || input.kind === "double_click" || input.kind === "right_click") {
    if (typeof input.x !== "number" || typeof input.y !== "number") {
      return { ok: false, detail: "Missing x/y coordinates" }
    }
    const args = ["mouse-click", formatCoordPair(input.x, input.y)]
    if (input.kind === "right_click") args.push("--button", "right")
    if (input.kind === "double_click") args.push("--count", "2")
    const res = await runAgentDesktop(args, { headed: true, timeoutMs: 8_000, signal })
    return { ok: res.ok, detail: res.ok ? `${input.kind} at (${Math.round(input.x)}, ${Math.round(input.y)})` : res.raw }
  }

  if (input.kind === "scroll") {
    const x = Math.round(input.x ?? 600)
    const y = Math.round(input.y ?? 400)
    // agent-desktop: positive dy scrolls up, negative scrolls down; dy=0 is rejected with INVALID_ARGS.
    if (input.deltaY === 0) {
      return { ok: true, detail: "No-op scroll" }
    }
    let dy = -4
    if (typeof input.deltaY === "number") {
      const clamped = Math.max(-20, Math.min(20, input.deltaY))
      dy = clamped > 0 ? Math.max(1, Math.round(clamped)) : Math.min(-1, Math.round(clamped))
    }
    const res = await runAgentDesktop(
      ["mouse-wheel", `--x=${x}`, `--y=${y}`, `--dy=${dy}`],
      { headed: true, timeoutMs: 8_000, signal },
    )
    return { ok: res.ok, detail: res.ok ? `Scrolled dy=${dy}` : res.raw }
  }

  if (input.kind === "key") {
    const combo = (input.key ?? "").trim()
    if (!combo) return { ok: false, detail: "Missing key combo" }
    const args = ["press"]
    if (input.app) args.push("--app", input.app)
    args.push(combo)
    const res = await runAgentDesktop(args, { headed: true, timeoutMs: 8_000, signal })
    return { ok: res.ok, detail: res.ok ? `Pressed ${combo}` : res.raw }
  }

  if (input.kind === "type") {
    const text = input.text ?? ""
    if (!text) return { ok: false, detail: "Empty text" }

    // Single letters and digits are plain key presses, which keeps the clipboard untouched. agent-desktop's own
    // `type` needs an element ref and cannot target "whatever has focus".
    if (/^[a-z0-9]$/i.test(text)) {
      const key = text === text.toUpperCase() && text !== text.toLowerCase() ? `shift+${text.toLowerCase()}` : text
      const pressArgs = ["press"]
      if (input.app) pressArgs.push("--app", input.app)
      pressArgs.push(key)
      const res = await runAgentDesktop(pressArgs, { headed: true, timeoutMs: 8_000, signal })
      return { ok: res.ok, detail: res.ok ? "Typed 1 char" : res.raw }
    }

    // Everything else (symbols, CJK, longer text) is pasted with Cmd+V through the system clipboard.
    const prevClip = await runCommand("/usr/bin/pbpaste", [], { timeoutMs: 4_000, signal })
    const previousText = prevClip.code === 0 && prevClip.stdout ? prevClip.stdout : null

    const setRes = await pbcopy(text)
    if (!setRes.ok) {
      return { ok: false, detail: setRes.detail }
    }

    const pasteArgs = ["press"]
    if (input.app) pasteArgs.push("--app", input.app)
    pasteArgs.push("cmd+v")
    const pasteRes = await runAgentDesktop(pasteArgs, { headed: true, timeoutMs: 6_000, signal })

    await new Promise((r) => setTimeout(r, 140))
    // Only restore clipboard text if previousText was indeed string; NEVER call clipboard-clear which wipes images/files
    if (previousText !== null) {
      await pbcopy(previousText).catch(() => {})
    }

    return { ok: pasteRes.ok, detail: pasteRes.ok ? `Typed ${text.length} chars (clipboard fallback)` : pasteRes.raw }
  }

  return { ok: false, detail: "Unsupported input kind" }
}
