import { spawn, type ChildProcess } from "node:child_process"
import type { KeepAwakeMode } from "../options.ts"
import { resolveBinary } from "./exec.ts"

export class KeepAwakeController {
  private proc: ChildProcess | null = null
  private mode: KeepAwakeMode
  private activeCount = 0

  constructor(mode: KeepAwakeMode) {
    this.mode = mode
    this.reconcile()
  }

  get isActive(): boolean {
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
    if (process.platform !== "darwin") return
    const shouldRun = this.mode === "always" || (this.mode === "active" && this.activeCount > 0)
    if (shouldRun && !this.isActive) {
      this.start()
    } else if (!shouldRun && this.isActive) {
      this.stop()
    }
  }

  private start(): void {
    const bin = resolveBinary("caffeinate")
    if (!bin) return
    // -d prevents display sleep (needed for macOS Screen Recording), -i prevents idle system sleep
    const child = spawn(bin, ["-di"], {
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
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // Ignore already-exited child process.
    }
    this.proc = null
  }
}
