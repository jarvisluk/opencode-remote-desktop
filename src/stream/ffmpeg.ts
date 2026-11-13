import { resolveBinary } from "../macos/exec.ts"
import { resolveLocale, type SupportedLocale } from "../i18n/locale.ts"
import { tServer } from "../i18n/server.ts"

/** Which live-stream capture backend the sidecar should use. */
export type StreamBackendPreference = "auto" | "native" | "ffmpeg"

export interface FfmpegEncoderParams {
  readonly fps: number
  readonly bitrate: number
  readonly maxDimension: number
  readonly platform: NodeJS.Platform
  /** Overrides the platform-default capture source args (everything before the scale filter). */
  readonly inputArgs?: readonly string[]
}

/**
 * Captures the screen with ffmpeg and emits raw H.264 Annex-B on stdout:
 * one process, one pipe, no timestamps. The Go sidecar reframes the NAL
 * stream into samples; `-f h264` output is exactly the Annex-B byte stream
 * the bot-capture contract also produces, minus the length/pts header.
 */
export function buildFfmpegArgs(params: FfmpegEncoderParams): string[] {
  const { fps, bitrate, maxDimension: max } = params
  const input = params.inputArgs ?? defaultInputArgs(params.platform, fps)
  const gop = Math.max(2, Math.round(fps) * 2)
  const longestEdge = max
  return [
    ...input,
    "-vf",
    // Cap the longest edge, keep aspect, force even dimensions for yuv420p.
    `scale='if(gt(iw,ih),min(iw,${longestEdge}),-2)':'if(gt(iw,ih),-2,min(ih,${longestEdge}))'`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-pix_fmt", "yuv420p",
    // Late joiners decode from the next keyframe: cap the GOP at 2 seconds.
    "-g", String(gop),
    "-b:v", String(bitrate),
    "-maxrate", String(bitrate),
    "-bufsize", String(bitrate * 2),
    "-an",
    "-f", "h264",
    "-nostdin",
    "-loglevel", "error",
    "pipe:1",
  ]
}

/** Platform-default capture sources. Override with the `ffmpegInputArgs` option. */
export function defaultInputArgs(platform: NodeJS.Platform, fps: number): string[] {
  switch (platform) {
    case "win32":
      return ["-f", "gdigrab", "-framerate", String(fps), "-i", "desktop"]
    case "linux":
      // x11grab defaults to the full :0.0 screen when no video_size is given.
      return ["-f", "x11grab", "-framerate", String(fps), "-i", ":0.0"]
    case "darwin":
      // avfoundation device indices vary per machine; native backend is
      // preferred on macOS and this is only a last-resort fallback.
      return ["-f", "avfoundation", "-framerate", String(fps), "-capture_cursor", "1", "-i", "1:0"]
    default:
      return ["-f", "lavfi", "-framerate", String(fps), "-i", "testsrc=size=1280x720"]
  }
}

export interface BackendProbeInput {
  readonly preference: StreamBackendPreference
  readonly platform: NodeJS.Platform
  readonly nativeBinariesAvailable: boolean
  readonly ffmpegPath: string | null
}

export interface BackendProbe {
  readonly backend: "native" | "ffmpeg" | null
  readonly ffmpegPath?: string
  /** Set when backend is null. */
  readonly reason?: string
}

/** Picks the live-stream backend: native bot-capture (framed contract) or a raw ffmpeg pipe. */
export function pickStreamBackend(
  input: BackendProbeInput,
  locale: SupportedLocale = resolveLocale(),
): BackendProbe {
  if (input.preference === "native") {
    return input.nativeBinariesAvailable
      ? { backend: "native" }
      : { backend: null, reason: tServer(locale, "stream.nativeMissing") }
  }
  if (input.preference === "ffmpeg") {
    return input.ffmpegPath
      ? { backend: "ffmpeg", ffmpegPath: input.ffmpegPath }
      : { backend: null, reason: tServer(locale, "stream.ffmpegMissing") }
  }
  // auto: native first on macOS (hardware encode + input injection), ffmpeg elsewhere.
  if (input.platform === "darwin" && input.nativeBinariesAvailable) return { backend: "native" }
  if (input.ffmpegPath) return { backend: "ffmpeg", ffmpegPath: input.ffmpegPath }
  if (input.nativeBinariesAvailable) return { backend: "native" }
  return {
    backend: null,
    reason: tServer(locale, "stream.noneAvailable"),
  }
}

/** Resolves ffmpeg on PATH (with the standard extra dirs). */
export function findFfmpeg(): string | null {
  return resolveBinary("ffmpeg")
}
