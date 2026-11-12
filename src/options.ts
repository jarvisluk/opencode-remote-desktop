export type KeepAwakeMode = "off" | "active" | "always"

export interface DotBotOptions {
  /** Bind address for the Web/Mobile Takeover Console. Default: "0.0.0.0" (reachable via LAN/Tailscale with token). */
  readonly consoleHost: string
  /** Port for the Web/Mobile Takeover Console. Set 0 for OS-assigned port. Default: 49375. */
  readonly consolePort: number
  /** Enable the standalone Web/Mobile Takeover Console HTTP server. Default: true. */
  readonly consoleEnabled: boolean
  /** Optional external tunnel base URL (e.g. Cloudflare Tunnel / Tailscale Funnel) pointing to consolePort. */
  readonly publicBaseUrl?: string
  /** Prevent macOS from sleeping via `caffeinate -di`. Default: "active" (awake during takeovers & routines). */
  readonly keepAwake: KeepAwakeMode
  /** Reuse host's signed-in Microsoft Edge / Chrome via DevToolsActivePort when available. Default: true. */
  readonly reuseHostBrowser: boolean
  /** Max pixel width/height for screenshots returned to Web UI / LLM. Default: 1440. */
  readonly maxImageDimension: number
  /** JPEG compression quality (20-95). Default: 72. */
  readonly jpegQuality: number
  /** Poll interval in ms for 24/7 background routines. Default: 30000. */
  readonly routinePollMs: number
  /** STUN/TURN URLs for the WebRTC live stream. Default: none (LAN / direct host candidates only). */
  readonly iceServers: readonly string[]
  /** Live stream frame rate. Default: 30. */
  readonly streamFps: number
  /** Live stream H.264 bitrate in bps. Default: 4000000. */
  readonly streamBitrate: number
  /** Longest edge of the live stream video. Default: 1920. */
  readonly streamMaxDimension: number
}

function intOption(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback
}

export function resolveOptions(raw: Record<string, unknown> | undefined): DotBotOptions {
  const opts = raw ?? {}
  const keepAwakeRaw = opts.keepAwake
  const keepAwake: KeepAwakeMode =
    keepAwakeRaw === "off" || keepAwakeRaw === "always" || keepAwakeRaw === "active"
      ? keepAwakeRaw
      : "active"

  const port = typeof opts.consolePort === "number" && Number.isInteger(opts.consolePort) && opts.consolePort >= 0
    ? opts.consolePort
    : 49375

  const maxDim = typeof opts.maxImageDimension === "number" && opts.maxImageDimension >= 480
    ? Math.min(3840, Math.round(opts.maxImageDimension))
    : 1440

  const quality = typeof opts.jpegQuality === "number"
    ? Math.max(20, Math.min(95, Math.round(opts.jpegQuality)))
    : 72

  const pollMs = typeof opts.routinePollMs === "number" && opts.routinePollMs >= 5_000
    ? Math.round(opts.routinePollMs)
    : 30_000

  return {
    consoleHost: typeof opts.consoleHost === "string" && opts.consoleHost.trim() ? opts.consoleHost.trim() : "0.0.0.0",
    consolePort: port,
    consoleEnabled: opts.consoleEnabled !== false,
    publicBaseUrl: typeof opts.publicBaseUrl === "string" && opts.publicBaseUrl.trim()
      ? opts.publicBaseUrl.trim().replace(/\/+$/, "")
      : undefined,
    keepAwake,
    reuseHostBrowser: opts.reuseHostBrowser !== false,
    maxImageDimension: maxDim,
    jpegQuality: quality,
    routinePollMs: pollMs,
    iceServers: Array.isArray(opts.iceServers)
      ? opts.iceServers.filter((s): s is string => typeof s === "string" && /^(stun|turns?):/.test(s))
      : [],
    streamFps: intOption(opts.streamFps, 5, 60, 30),
    streamBitrate: intOption(opts.streamBitrate, 300_000, 20_000_000, 4_000_000),
    streamMaxDimension: intOption(opts.streamMaxDimension, 640, 3840, 1920),
  }
}
