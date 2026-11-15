import { spawn, type ChildProcess } from "node:child_process"
import type { KeepAwakeMode } from "../options.ts"
import { hostClient } from "../host/client.ts"
import { resolveBinary } from "./exec.ts"

export class KeepAwakeController {
  private proc: ChildProcess | null = null
  private mode: KeepAwakeMode
  private activeCount = 0
  private hostActive = false

  constructor(mode: KeepAwakeMode) {
    this.mode = mode
    this.reconcile()
  }

  get isActive(): boolean {
    if (hostClient.available()) {
      return this.hostActive
    }
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed
  }

  acquire(): () => void {
    this.activeCount += 1
    this.reconcile()
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.reconcile()
    }
  }

  setMode(mode: KeepAwakeMode): void {
    this.mode = mode
    this.reconcile()
  }

  dispose(): void {
    this.activeCount = 0
    this.stop()
  }

  private reconcile(): void {
    const shouldRun = this.mode === "always" || (this.mode === "active" && this.activeCount > 0)
    if (hostClient.available()) {
      if (shouldRun !== this.hostActive) {
        this.hostActive = shouldRun
        void hostClient.setKeepAwake(shouldRun).catch(() => {})
      }
      return
    }
    if (process.platform !== "darwin") return
    if (shouldRun && !this.isActive) {
      this.start()
    } else if (!shouldRun && this.isActive) {
      this.stop()
    }
  }

  private start(): void {
    const bin = resolveBinary("caffeinate")
    if (!bin) return
    const child = spawn(bin, ["-di", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    })
    child.unref()
    child.on("exit", () => {
      if (this.proc === child) this.proc = null
    })
    this.proc = child
  }

  private stop(): void {
    if (hostClient.available() && this.hostActive) {
      this.hostActive = false
      void hostClient.setKeepAwake(false).catch(() => {})
    }
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // Ignore already-exited child process.
    }
    this.proc = null
  }
}
