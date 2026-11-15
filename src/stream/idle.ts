export type SleepReason = "idle" | "hidden"

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions | boolean): void
  removeEventListener(type: string, listener: () => void, options?: EventListenerOptions | boolean): void
}

export interface DocumentLike extends EventTargetLike {
  readonly hidden?: boolean
}

export interface IdleWatcherOptions {
  idleTimeoutMs?: number
  hiddenTimeoutMs?: number
  isBusy?: () => boolean
  onSleep: (reason: SleepReason) => void
  onWake?: (from: SleepReason) => void
  target?: EventTargetLike | null
  doc?: DocumentLike | null
}

export interface IdleWatcher {
  touch(): void
  setTimeouts(idleMs: number, hiddenMs: number): void
  sleep(reason: SleepReason): void
  wake(): void
  readonly sleeping: SleepReason | null
  dispose(): void
}

const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const
const TOUCH_THROTTLE_MS = 500

/**
 * Watches user interaction and page visibility to pause/close live screen streams when idle or hidden.
 */
export function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
  let idleMs = options.idleTimeoutMs ?? 300_000
  let hiddenMs = options.hiddenTimeoutMs ?? 10_000
  let sleepReason: SleepReason | null = null
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let lastTouchAt = 0

  const doc = options.doc !== undefined ? options.doc : ((globalThis as { document?: DocumentLike }).document ?? null)
  const target = options.target !== undefined ? options.target : ((globalThis as { window?: EventTargetLike }).window ?? doc)

  const clearIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const clearHidden = () => {
    clearTimeout(hiddenTimer)
    hiddenTimer = undefined
  }

  const scheduleIdle = () => {
    clearIdle()
    if (disposed || sleepReason !== null || idleMs <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (disposed || sleepReason !== null) return
      if (options.isBusy?.()) {
        scheduleIdle()
        return
      }
      sleep("idle")
    }, idleMs)
  }

  const scheduleHidden = () => {
    clearHidden()
    if (disposed || sleepReason !== null || hiddenMs <= 0 || !doc?.hidden) return
    hiddenTimer = setTimeout(() => {
      hiddenTimer = undefined
      if (disposed || sleepReason !== null || !doc?.hidden) return
      if (options.isBusy?.()) {
        scheduleHidden()
        return
      }
      sleep("hidden")
    }, hiddenMs)
  }

  const sleep = (reason: SleepReason) => {
    if (disposed || sleepReason !== null) return
    sleepReason = reason
    clearIdle()
    clearHidden()
    options.onSleep(reason)
  }

  const wake = () => {
    if (disposed || sleepReason === null) return
    const from = sleepReason
    sleepReason = null
    clearHidden()
    lastTouchAt = Date.now()
    scheduleIdle()
    options.onWake?.(from)
  }

  const touch = () => {
    if (disposed || sleepReason !== null) return
    const now = Date.now()
    if (now - lastTouchAt < TOUCH_THROTTLE_MS && idleTimer !== undefined) return
    lastTouchAt = now
    scheduleIdle()
  }

  const onVisibility = () => {
    if (disposed) return
    if (doc?.hidden) {
      scheduleHidden()
    } else {
      clearHidden()
      if (sleepReason === "hidden") wake()
    }
  }

  const onInteract = () => touch()

  for (const ev of INTERACTION_EVENTS) {
    target?.addEventListener(ev, onInteract, { passive: true })
  }
  doc?.addEventListener("visibilitychange", onVisibility)

  scheduleIdle()
  if (doc?.hidden) scheduleHidden()

  return {
    touch,
    setTimeouts(nextIdleMs: number, nextHiddenMs: number) {
      idleMs = nextIdleMs
      hiddenMs = nextHiddenMs
      if (sleepReason === null) {
        scheduleIdle()
        if (doc?.hidden) scheduleHidden()
      }
    },
    sleep,
    wake,
    get sleeping() {
      return sleepReason
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearIdle()
      clearHidden()
      for (const ev of INTERACTION_EVENTS) {
        target?.removeEventListener(ev, onInteract)
      }
      doc?.removeEventListener("visibilitychange", onVisibility)
    },
  }
}
