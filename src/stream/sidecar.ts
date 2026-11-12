import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const binDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/bin")

function binary(name: string): string {
  const ext = process.platform === "win32" ? ".exe" : ""
  return path.join(binDir, `${name}-${process.platform}-${process.arch}${ext}`)
}

export interface StreamOptions {
  readonly iceServers: readonly string[]
  readonly fps: number
  readonly bitrate: number
  readonly maxDimension: number
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }

/** Owns the dotbot-stream sidecar (WebRTC) and talks to it over JSON lines. */
export class StreamSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private readonly options: StreamOptions

  constructor(options: StreamOptions) {
    this.options = options
  }

  static available(): boolean {
    return existsSync(binary("dotbot-stream")) && existsSync(binary("dotbot-capture"))
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const proc = spawn(binary("dotbot-stream"), [
      "--capture", binary("dotbot-capture"),
      "--ice", this.options.iceServers.join(","),
      "--fps", String(this.options.fps),
      "--bitrate", String(this.options.bitrate),
      "--max-dim", String(this.options.maxDimension),
    ])
    proc.stderr.on("data", (d) => process.stderr.write(d))
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const p = this.pending.get(msg.id as number)
      if (!p) return
      this.pending.delete(msg.id as number)
      if (msg.t === "error") p.reject(new Error(String(msg.message)))
      else p.resolve(msg)
    })
    proc.on("exit", () => {
      this.proc = null
      for (const p of this.pending.values()) p.reject(new Error("stream sidecar exited"))
      this.pending.clear()
    })
    this.proc = proc
    return proc
  }

  private request(msg: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const proc = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("stream sidecar timed out"))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      proc.stdin.write(JSON.stringify({ ...msg, id }) + "\n")
    })
  }

  async offer(sdp: string): Promise<{ sdp: string; session: string }> {
    const res = await this.request({ t: "offer", sdp })
    return { sdp: String(res.sdp), session: String(res.session) }
  }

  async close(session: string): Promise<void> {
    if (this.proc) await this.request({ t: "close", session })
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = null
  }
}
