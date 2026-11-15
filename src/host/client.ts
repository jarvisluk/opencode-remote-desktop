import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function hostPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `@opencode-bot/host-${platform}-${arch}`
}

export function resolveHostBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const envBin = process.env.OPENCODE_BOT_HOST_BIN?.trim()
  if (envBin && existsSync(envBin)) {
    return envBin
  }

  const ext = platform === "win32" ? ".exe" : ""
  const localBin = path.join(repoRoot, "dist", "bin", `bot-host-${platform}-${arch}${ext}`)
  if (existsSync(localBin)) {
    return localBin
  }

  try {
    const pkgJson = require.resolve(`${hostPlatformPackageName(platform, arch)}/package.json`)
    const pkgBin = path.join(path.dirname(pkgJson), "bin", `bot-host${ext}`)
    if (existsSync(pkgBin)) {
      return pkgBin
    }
  } catch {
    // Optional platform package not installed.
  }

  if (platform === process.platform && arch === process.arch) {
    const cargoBin = path.join(repoRoot, "native", "bot-host", "target", "release", `bot-host${ext}`)
    if (existsSync(cargoBin)) {
      return cargoBin
    }
  }

  return null
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly cleanupAbort?: () => void
}

export class BotHostClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRpc>()
  private keepAwakeWanted = false
  private activeStreams = 0

  available(): boolean {
    return resolveHostBinary() !== null
  }

  private updateRefState(): void {
    const proc = this.proc
    if (!proc) return
    const keepAlive = this.pending.size > 0 || this.keepAwakeWanted || this.activeStreams > 0
    if (keepAlive) {
      proc.ref()
      ;(proc.stdout as any)?.ref?.()
      ;(proc.stderr as any)?.ref?.()
      ;(proc.stdin as any)?.ref?.()
    } else {
      proc.unref()
      ;(proc.stdout as any)?.unref?.()
      ;(proc.stderr as any)?.unref?.()
      ;(proc.stdin as any)?.unref?.()
    }
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc
    }

    const bin = resolveHostBinary()
    if (!bin) {
      throw new Error(
        `bot-host binary missing for ${process.platform}-${process.arch} (run \`npm run build:native\` or install ${hostPlatformPackageName()})`,
      )
    }

    const proc = spawn(bin, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc = proc

    let stderrTail = ""
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1024)
      if (process.env.OPENCODE_BOT_HOST_DEBUG === "1") {
        process.stderr.write(chunk)
      }
    })

    createInterface({ input: proc.stdout }).on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return
      }
      if (typeof msg.id !== "number") return
      const req = this.pending.get(msg.id)
      if (!req) return
      this.pending.delete(msg.id)
      clearTimeout(req.timer)
      req.cleanupAbort?.()
      this.updateRefState()

      if (msg.error) {
        req.reject(new Error(msg.error.message || "bot-host RPC error"))
      } else {
        req.resolve(msg.result)
      }
    })

    const failAll = (reason: string) => {
      if (this.proc === proc) {
        this.proc = null
      }
      for (const [id, req] of this.pending) {
        this.pending.delete(id)
        clearTimeout(req.timer)
        req.cleanupAbort?.()
        req.reject(new Error(reason))
      }
    }

    proc.on("error", (err) => {
      failAll(`bot-host process error: ${err.message}`)
    })

    proc.on("exit", (code, sig) => {
      const detail = stderrTail.trim()
      failAll(
        `bot-host exited (${code ?? sig ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      )
    })

    if (this.keepAwakeWanted) {
      void this.sendRaw("power.keepAwake", { enabled: true }).catch(() => {})
    }

    this.updateRefState()
    return proc
  }

  private sendRaw<T>(
    method: string,
    params: Record<string, unknown>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<T> {
    if (options?.signal?.aborted) {
      return Promise.reject(new Error("Aborted"))
    }
    const proc = this.ensureStarted()
    const id = this.nextId++
    if (this.nextId > 0x7fff_ff00) this.nextId = 1
    const timeoutMs = options?.timeoutMs ?? 15_000

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        this.updateRefState()
        reject(new Error("Aborted"))
      }

      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.cleanupAbort?.()
        this.updateRefState()
        reject(new Error(`bot-host RPC timeout (${method})`))
      }, timeoutMs)

      options?.signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanupAbort: options?.signal
          ? () => options.signal?.removeEventListener("abort", onAbort)
          : undefined,
      })
      this.updateRefState()

      const payload = JSON.stringify({ id, method, params }) + "\n"
      proc.stdin.write(payload, (err) => {
        if (!err) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.cleanupAbort?.()
        this.updateRefState()
        reject(err)
      })
    })
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<T> {
    return this.sendRaw<T>(method, params, options)
  }

  async setKeepAwake(enabled: boolean): Promise<boolean> {
    this.keepAwakeWanted = enabled
    if (!enabled && !this.proc) {
      return false
    }
    const res = await this.request<{ active?: boolean }>("power.keepAwake", { enabled }, { timeoutMs: 5_000 })
    this.updateRefState()
    return Boolean(res?.active ?? enabled)
  }

  trackStreamOpen(): void {
    this.activeStreams += 1
    this.updateRefState()
  }

  trackStreamClose(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1)
    this.updateRefState()
  }

  dispose(): void {
    this.keepAwakeWanted = false
    this.activeStreams = 0
    const proc = this.proc
    this.proc = null
    for (const [id, req] of this.pending) {
      this.pending.delete(id)
      clearTimeout(req.timer)
      req.cleanupAbort?.()
      req.reject(new Error("bot-host disposed"))
    }
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM")
      } catch {
        // Ignore already-exited child.
      }
    }
  }
}

export const hostClient = new BotHostClient()
process.once("exit", () => hostClient.dispose())
