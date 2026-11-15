import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { hostClient } from "./host/client.ts"

export const KEYCHAIN_SERVICE = "opencode-bot"
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** Names go into a `security -i` command line, so they are restricted to characters that need no quoting. */
export const isValidSecretName = (name: unknown): name is string => typeof name === "string" && NAME_RE.test(name)

function security(args: readonly string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/security", [...args])
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

function keychainError(stderr: string, fallback: string): Error {
  const msg = stderr.trim()
  if (/interaction is not allowed|-25308/i.test(msg)) {
    return new Error("macOS Keychain is locked (no GUI login session on the host). Sign in on the Mac or unlock the login keychain.")
  }
  return new Error(msg || fallback)
}

export async function saveSecret(name: string, value: string): Promise<void> {
  if (!isValidSecretName(name)) throw new Error(`Invalid secret name: ${name}`)
  if (hostClient.available()) {
    await hostClient.request("secret.set", { name, value })
    return
  }
  if (process.platform !== "darwin") {
    throw new Error("bot-host binary is required to store secrets on this platform")
  }
  // Fallback when bot-host is not built yet: value travels over stdin as hex (never argv).
  const hex = Buffer.from(Buffer.from(value, "utf8").toString("hex"), "utf8").toString("hex")
  const res = await security(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -X ${hex}\n`)
  if (res.code !== 0 || res.stderr.trim()) throw keychainError(res.stderr, "Keychain write failed")
}

export async function readSecret(name: string): Promise<string | null> {
  if (!isValidSecretName(name)) return null
  if (hostClient.available()) {
    const res = await hostClient.request<{ value?: string | null }>("secret.get", { name })
    return typeof res?.value === "string" ? res.value : null
  }
  if (process.platform !== "darwin") return null
  const res = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"])
  if (res.code !== 0) {
    if (/could not be found|-25300/i.test(res.stderr)) return null
    throw keychainError(res.stderr, "Keychain read failed")
  }
  return Buffer.from(res.stdout.trim(), "hex").toString("utf8")
}

export async function deleteSecret(name: string): Promise<boolean> {
  if (!isValidSecretName(name)) return false
  if (hostClient.available()) {
    const res = await hostClient.request<{ deleted?: boolean }>("secret.delete", { name })
    return Boolean(res?.deleted)
  }
  if (process.platform !== "darwin") return false
  const res = await security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name])
  return res.code === 0
}

export type SecretOutcome = "saved" | "cancelled"

export interface PendingSecret {
  readonly id: string
  readonly sessionID: string
  readonly name: string
  readonly reason: string
  readonly createdAt: number
}

interface InternalSecret extends PendingSecret {
  readonly resolve: () => void
  readonly reject: (err: Error) => void
  readonly release: () => void
}

const toPublic = (e: PendingSecret): PendingSecret => ({
  id: e.id,
  sessionID: e.sessionID,
  name: e.name,
  reason: e.reason,
  createdAt: e.createdAt,
})

/** Pending "please enter a secret" requests. Values pass straight to the keychain and are never kept here. */
export class SecretManager {
  private readonly pending = new Map<string, InternalSecret>()
  private readonly onRequestCallbacks = new Set<(item: PendingSecret) => void>()
  private readonly onResolveCallbacks = new Set<(item: PendingSecret, outcome: SecretOutcome) => void>()

  private readonly acquireAwake: () => () => void
  private readonly save: (name: string, value: string) => Promise<void>
  private readonly timeoutMs: number

  constructor(
    acquireAwake: () => () => void,
    save: (name: string, value: string) => Promise<void> = saveSecret,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.acquireAwake = acquireAwake
    this.save = save
    this.timeoutMs = timeoutMs
  }

  list(): PendingSecret[] {
    return [...this.pending.values()].map(toPublic)
  }

  getBySession(sessionID: string): PendingSecret | undefined {
    for (const e of this.pending.values()) if (e.sessionID === sessionID) return toPublic(e)
    return undefined
  }

  onRequested(cb: (item: PendingSecret) => void): () => void {
    this.onRequestCallbacks.add(cb)
    return () => this.onRequestCallbacks.delete(cb)
  }

  onResolved(cb: (item: PendingSecret, outcome: SecretOutcome) => void): () => void {
    this.onResolveCallbacks.add(cb)
    return () => this.onResolveCallbacks.delete(cb)
  }

  /** Resolves once the user submits a value and it is stored; rejects on cancel, abort, timeout or supersede. */
  request(input: { sessionID: string; name: string; reason: string; signal?: AbortSignal }): {
    item: PendingSecret
    promise: Promise<void>
  } {
    if (!isValidSecretName(input.name)) throw new Error(`Invalid secret name: ${input.name}`)
    this.cancel({ sessionID: input.sessionID }, "Superseded by a newer secret request")

    const item: PendingSecret = {
      id: `sec_${randomUUID().slice(0, 8)}`,
      sessionID: input.sessionID,
      name: input.name,
      reason: input.reason,
      createdAt: Date.now(),
    }
    const promise = new Promise<void>((resolve, reject) => {
      const release = this.acquireAwake()
      // Not unref'd: the pending request is what keeps the timeout meaningful, and a test (or a short-lived
      // process) that awaits it must not have the event loop drain first.
      const timer = setTimeout(() => this.cancel({ id: item.id }, "Timed out waiting for the user"), this.timeoutMs)
      const onAbort = () => this.cancel({ id: item.id }, "Session stopped")
      input.signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(item.id, {
        ...item,
        resolve,
        reject,
        release: () => {
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", onAbort)
          release()
        },
      })
      if (input.signal?.aborted) onAbort()
    })
    if (this.pending.has(item.id)) this.emit(this.onRequestCallbacks, item)
    return { item, promise }
  }

  /** Stores the value, then wakes the waiting tool. A failed write keeps the request open so the user can retry. */
  async submit(id: string, value: string): Promise<boolean> {
    const entry = this.pending.get(id)
    if (!entry) return false
    if (!value) throw new Error("Empty value")
    await this.save(entry.name, value)
    if (this.pending.get(id) !== entry) return false
    this.finish(entry, "saved")
    entry.resolve()
    return true
  }

  cancel(target: { id?: string; sessionID?: string }, message = "Cancelled by the user"): number {
    const entries = [...this.pending.values()].filter((e) =>
      target.id ? e.id === target.id : target.sessionID ? e.sessionID === target.sessionID : false,
    )
    for (const entry of entries) {
      this.finish(entry, "cancelled")
      entry.reject(new Error(message))
    }
    return entries.length
  }

  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.id)
      entry.release()
      entry.reject(new Error("Plugin unloaded"))
    }
  }

  private finish(entry: InternalSecret, outcome: SecretOutcome): void {
    this.pending.delete(entry.id)
    entry.release()
    const item = toPublic(entry)
    for (const cb of this.onResolveCallbacks) {
      try {
        cb(item, outcome)
      } catch {
        // Ignore listener errors.
      }
    }
  }

  private emit(set: Set<(item: PendingSecret) => void>, item: PendingSecret): void {
    for (const cb of set) {
      try {
        cb(item)
      } catch {
        // Ignore listener errors.
      }
    }
  }
}
