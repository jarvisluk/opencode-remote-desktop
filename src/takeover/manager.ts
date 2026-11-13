import { randomUUID } from "node:crypto"

export type TakeoverResolveSource = "ui" | "chat" | "command" | "superseded"

export interface PendingTakeover {
  readonly id: string
  readonly sessionID: string
  readonly reason: string
  readonly app?: string
  readonly createdAt: number
}

interface InternalTakeover extends PendingTakeover {
  readonly resolve?: (note?: string) => void
  readonly reject?: (reason: Error) => void
  readonly releaseAwake: () => void
}

function toPublic(entry: PendingTakeover): PendingTakeover {
  return {
    id: entry.id,
    sessionID: entry.sessionID,
    reason: entry.reason,
    ...(entry.app !== undefined ? { app: entry.app } : {}),
    createdAt: entry.createdAt,
  }
}

export class TakeoverManager {
  private readonly pending = new Map<string, InternalTakeover>()
  private readonly onRequestCallbacks = new Set<(item: PendingTakeover) => void>()
  private readonly onResolveCallbacks = new Set<
    (item: PendingTakeover, note?: string, source?: TakeoverResolveSource) => void
  >()
  private readonly acquireAwake: () => () => void

  constructor(acquireAwake: () => () => void) {
    this.acquireAwake = acquireAwake
  }

  get size(): number {
    return this.pending.size
  }

  getBySession(sessionID: string): PendingTakeover | undefined {
    const entry = this.pending.get(sessionID)
    return entry ? toPublic(entry) : undefined
  }

  list(): PendingTakeover[] {
    return [...this.pending.values()].map(toPublic)
  }

  onRequested(cb: (item: PendingTakeover) => void): () => void {
    this.onRequestCallbacks.add(cb)
    return () => this.onRequestCallbacks.delete(cb)
  }

  onResolved(cb: (item: PendingTakeover, note?: string, source?: TakeoverResolveSource) => void): () => void {
    this.onResolveCallbacks.add(cb)
    return () => this.onResolveCallbacks.delete(cb)
  }

  request(input: {
    readonly sessionID: string
    readonly reason: string
    readonly app?: string
  }): PendingTakeover {
    if (this.pending.has(input.sessionID)) {
      this.resolveBySession(input.sessionID, "Superseded by newer takeover request", { source: "superseded" })
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

    this.pending.set(input.sessionID, {
      ...item,
      releaseAwake,
    })

    this.emitRequested(item)
    return item
  }

  waitForHuman(input: {
    readonly sessionID: string
    readonly reason: string
    readonly app?: string
    readonly signal?: AbortSignal
  }): { readonly item: PendingTakeover; readonly promise: Promise<string | undefined> } {
    // Resolve any stale takeover on the same session before registering a new one
    if (this.pending.has(input.sessionID)) {
      this.resolveBySession(input.sessionID, "Superseded by newer takeover request", { source: "superseded" })
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

    this.emitRequested(item)
    return { item, promise }
  }

  private emitRequested(item: PendingTakeover): void {
    for (const cb of this.onRequestCallbacks) {
      try {
        cb(item)
      } catch {
        // Ignore listener errors.
      }
    }
  }

  resolveBySession(
    sessionID?: string,
    note?: string,
    options?: { readonly source?: TakeoverResolveSource },
  ): PendingTakeover[] {
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
      const publicItem = toPublic(entry)
      resolvedItems.push(publicItem)
      entry.resolve?.(note)
      for (const cb of this.onResolveCallbacks) {
        try {
          cb(publicItem, note, options?.source)
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
      entry.reject?.(new Error("Plugin unloaded"))
    }
    this.pending.clear()
  }
}
