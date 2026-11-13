import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveBinary, runCommand } from "./exec.ts"

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

export async function listWindows(app?: string, signal?: AbortSignal): Promise<MacWindowInfo[]> {
  const bin = resolveBinary("agent-desktop")
  if (!bin) return []
  const args = ["list-windows"]
  if (app) args.push("--app", app)
  const res = await runCommand(bin, args, { timeoutMs: 8_000, signal })
  const parsed = parseJsonSafe(res.stdout)
  if (!parsed?.ok || !Array.isArray(parsed.data)) return []
  return parsed.data
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
    // agent-desktop: positive dy scrolls up, negative scrolls down
    const dy = typeof input.deltaY === "number" ? Math.max(-20, Math.min(20, Math.round(input.deltaY))) : -4
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

    // First try agent-desktop type directly (avoids touching clipboard and losing images/files or leaking secrets)
    const typeArgs = ["type"]
    if (input.app) typeArgs.push("--app", input.app)
    typeArgs.push(text)
    const directType = await runAgentDesktop(typeArgs, { headed: true, timeoutMs: 8_000, signal })
    if (directType.ok) {
      return { ok: true, detail: `Typed ${text.length} chars` }
    }

    // Fallback: paste text into focused field via Cmd+V
    const prevClip = await runAgentDesktop(["clipboard-get"], { timeoutMs: 4_000, signal })
    const previousText = typeof prevClip.parsed?.data?.text === "string" ? prevClip.parsed.data.text : null

    const setRes = await runAgentDesktop(["clipboard-set", text], { timeoutMs: 4_000, signal })
    if (!setRes.ok) {
      return { ok: false, detail: setRes.raw }
    }

    const pasteArgs = ["press"]
    if (input.app) pasteArgs.push("--app", input.app)
    pasteArgs.push("cmd+v")
    const pasteRes = await runAgentDesktop(pasteArgs, { headed: true, timeoutMs: 6_000, signal })

    await new Promise((r) => setTimeout(r, 140))
    // Only restore clipboard text if previousText was indeed string; NEVER call clipboard-clear which wipes images/files
    if (previousText !== null) {
      await runAgentDesktop(["clipboard-set", previousText], { timeoutMs: 4_000 }).catch(() => {})
    }

    return { ok: pasteRes.ok, detail: pasteRes.ok ? `Typed ${text.length} chars (clipboard fallback)` : pasteRes.raw }
  }

  return { ok: false, detail: "Unsupported input kind" }
}
