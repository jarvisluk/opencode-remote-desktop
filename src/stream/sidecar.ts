import type { SupportedLocale } from "../i18n/locale.ts"
import { hostClient, resolveHostBinary } from "../host/client.ts"
import {
  buildFfmpegArgs,
  findFfmpeg,
  pickStreamBackend,
  type BackendProbe,
  type StreamBackendPreference,
} from "./ffmpeg.ts"

export interface StreamOptions {
  readonly iceServers: readonly string[]
  readonly fps: number
  readonly bitrate: number
  readonly maxDimension: number
  /** Capture backend selection. Default: "auto" (native bot-host when available, ffmpeg fallback). */
  readonly backend?: StreamBackendPreference
  /** Optional override of the ffmpeg capture-source args (everything before the scale filter). */
  readonly ffmpegInputArgs?: readonly string[]
}

/**
 * Coordinates live WebRTC streaming through the resident `bot-host` daemon.
 * Preserves the legacy `StreamSidecar` surface for plugin RPC and diagnostics.
 */
export class StreamSidecar {
  private inputEnabled = true
  private readonly options: StreamOptions
  private readonly sessions = new Set<string>()

  constructor(options: StreamOptions) {
    this.options = options
  }

  static available(): boolean {
    return this.probe().backend !== null
  }

  /** Probes the chosen capture backend (native `bot-host` vs ffmpeg on PATH). */
  static probe(
    options: Pick<StreamOptions, "backend" | "ffmpegInputArgs"> & { locale?: SupportedLocale } = {},
  ): BackendProbe {
    const hasHost = resolveHostBinary() !== null
    const pref = options.backend ?? "auto"
    // `bot-host` now provides native capture + H.264 + WebRTC across macOS, Windows, and Linux.
    if (pref === "auto" && hasHost) {
      return { backend: "native" }
    }
    return pickStreamBackend(
      {
        preference: pref,
        platform: process.platform,
        nativeBinariesAvailable: hasHost,
        ffmpegPath: findFfmpeg(),
      },
      options.locale,
    )
  }

  async offer(sdp: string, target?: string): Promise<{ sdp: string; session: string }> {
    const probe = StreamSidecar.probe(this.options)
    if (!probe.backend) {
      throw new Error(probe.reason ?? "no stream backend available")
    }
    if (!hostClient.available()) {
      throw new Error(probe.reason ?? "bot-host binary missing")
    }

    const iceServers = this.options.iceServers
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ urls: [url] }))

    const ffmpegCmd =
      probe.backend === "ffmpeg"
        ? [
            probe.ffmpegPath ?? "ffmpeg",
            ...buildFfmpegArgs({
              fps: this.options.fps,
              bitrate: this.options.bitrate,
              maxDimension: this.options.maxDimension,
              platform: process.platform,
              inputArgs: this.options.ffmpegInputArgs,
            }),
          ]
        : undefined

    const res = await hostClient.request<{ sdp: string; session: string }>(
      "stream.offer",
      {
        sdp,
        ...(target ? { target } : {}),
        fps: this.options.fps,
        bitrate: this.options.bitrate,
        maxDim: this.options.maxDimension,
        ...(iceServers.length ? { iceServers } : {}),
        ...(ffmpegCmd ? { ffmpegCmd } : {}),
      },
      { timeoutMs: 20_000 },
    )

    if (!this.inputEnabled) {
      await hostClient.request("stream.setInput", { enabled: false }).catch(() => {})
    }
    if (res.session) {
      this.sessions.add(res.session)
      hostClient.trackStreamOpen()
    }
    return { sdp: String(res.sdp), session: String(res.session) }
  }

  async retarget(session: string, target: string): Promise<void> {
    if (!hostClient.available()) return
    await hostClient.request("stream.retarget", { session, target })
  }

  async close(session: string): Promise<void> {
    if (this.sessions.delete(session)) {
      hostClient.trackStreamClose()
    }
    if (hostClient.available()) {
      await hostClient.request("stream.close", { session }).catch(() => {})
    }
  }

  /** Gates DataChannel input from every viewer while the agent owns the screen. */
  async setInput(enabled: boolean): Promise<void> {
    this.inputEnabled = enabled
    if (hostClient.available() && this.sessions.size > 0) {
      await hostClient.request("stream.setInput", { enabled }).catch(() => {})
    }
  }

  dispose(): void {
    for (const session of [...this.sessions]) {
      this.sessions.delete(session)
      hostClient.trackStreamClose()
      void hostClient.request("stream.close", { session }).catch(() => {})
    }
  }
}
