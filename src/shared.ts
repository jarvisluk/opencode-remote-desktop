// OpenCode loads the plugin once per project directory in the same process. Host state (pending takeovers,
// secret requests, screen owner, controller heartbeats, the stream sidecar) must be one per process, or an RPC
// that lands in one instance never sees what a tool call recorded in another.
const KEY = Symbol.for("opencode-bot.host")

interface Slot<T> {
  value: T
  refs: number
  dispose: () => void
}

export interface Shared<T> {
  readonly value: T
  /** True the first time `key` is claimed in this process; for side effects every instance would otherwise repeat. */
  once(key: string): boolean
  release(): void
}

export function acquireShared<T>(create: () => { value: T; dispose: () => void }): Shared<T> {
  const g = globalThis as unknown as Record<symbol, (Slot<T> & { claimed: Set<string> }) | undefined>
  let slot = g[KEY]
  if (!slot) {
    slot = { ...create(), refs: 0, claimed: new Set() }
    g[KEY] = slot
  }
  slot.refs++
  const s = slot
  let released = false
  return {
    value: s.value,
    once(key) {
      if (s.claimed.has(key)) return false
      s.claimed.add(key)
      if (s.claimed.size > 1000) s.claimed.delete(s.claimed.values().next().value!)
      return true
    },
    release() {
      if (released) return
      released = true
      if (--s.refs > 0) return
      if (g[KEY] === s) g[KEY] = undefined
      s.dispose()
    },
  }
}
