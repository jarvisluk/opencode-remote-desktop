import { randomUUID } from "node:crypto"

export interface PendingTakeover {
  readonly id: string
  readonly sessionID: string
  readonly reason: string
  readonly app?: string
  readonly createdAt: number
}

interface InternalTakeover extends PendingTakeover {
  readonly resolve: (note?: string) => void
  readonly reject: (reason: Error) => void
  readonly releaseAwake: () => void
}

export class TakeoverManager {
  private readonly pending = new Map<string, InternalTakeover>()
  private readonly onRequestCallbacks = new Set<(item: PendingTakeover) => void>()
  private readonly onResolveCallbacks = new Set<(item: PendingTakeover, note?: string) => void>()
  private readonly acquireAwake: () => () => void

  constructor(acquireAwake: () => () => void) {
    this.acquireAwake = acquireAwake
  }

  get size(): number {
    return this.pending.size
  }

  list(): PendingTakeover[] {
    return [...this.pending.values()].map(({ id, sessionID, reason, app, createdAt }) => ({
      id,
      sessionID,
      reason,
      app,
      createdAt,
    }))
  }

  onRequested(cb: (item: PendingTakeover) => void): () => void {
    this.onRequestCallbacks.add(cb)
    return () => this.onRequestCallbacks.delete(cb)
  }

  onResolved(cb: (item: PendingTakeover, note?: string) => void): () => void {
    this.onResolveCallbacks.add(cb)
    return () => this.onResolveCallbacks.delete(cb)
  }

  waitForHuman(input: {
    readonly sessionID: string
    readonly reason: string
    readonly app?: string
    readonly signal?: AbortSignal
  }): { readonly item: PendingTakeover; readonly promise: Promise<string | undefined> } {
    // Resolve any stale takeover on the same session before registering a new one
    const existing = this.pending.get(input.sessionID)
    if (existing) {
      this.resolveBySession(input.sessionID, "Superseded by newer takeover request")
    }

    const id = `tk_${randomUUID().slice(0, 8)}`
    const releaseAwake = this.acquireAwake()
    const item: PendingTakeover = {
      id,
      sessionID: input.sessionID,
      reason: input.reason,
      app: input.app,
      createdAt: Date.now(),
    }

    const promise = new Promise<string | undefined>((resolve, reject) => {
      const entry: InternalTakeover = {
        ...item,
        resolve,
        reject,
        releaseAwake,
      }
      this.pending.set(input.sessionID, entry)

      const onAbort = () => {
        const cur = this.pending.get(input.sessionID)
        if (cur?.id === id) {
          this.pending.delete(input.sessionID)
          cur.releaseAwake()
        }
        reject(new Error("Takeover cancelled because session stopped."))
      }

      if (input.signal?.aborted) {
        onAbort()
        return
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })
    })

    for (const cb of this.onRequestCallbacks) {
      try {
        cb(item)
      } catch {
        // Ignore listener errors.
      }
    }

    return { item, promise }
  }

  resolveBySession(sessionID?: string, note?: string): PendingTakeover[] {
    const targets = sessionID
      ? (() => {
          const single = this.pending.get(sessionID)
          return single ? [single] : []
        })()
      : [...this.pending.values()]

    const resolvedItems: PendingTakeover[] = []
    for (const entry of targets) {
      this.pending.delete(entry.sessionID)
      entry.releaseAwake()
      const publicItem: PendingTakeover = {
        id: entry.id,
        sessionID: entry.sessionID,
        reason: entry.reason,
        app: entry.app,
        createdAt: entry.createdAt,
      }
      resolvedItems.push(publicItem)
      entry.resolve(note)
      for (const cb of this.onResolveCallbacks) {
        try {
          cb(publicItem, note)
        } catch {
          // Ignore listener errors.
        }
      }
    }
    return resolvedItems
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.releaseAwake()
      entry.reject(new Error("Plugin unloaded"))
    }
    this.pending.clear()
  }
}
