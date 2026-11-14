import type { TakeoverManager } from "./manager.ts"

export type ScreenOwner = "idle" | "agent" | "human"

/** `detail` of a rejected remote input; clients match the `agent-busy` prefix. */
export const SCREEN_BUSY_DETAIL = "agent-busy: an AI agent is operating the screen; force a takeover to interrupt it"

export interface ScreenState {
  readonly owner: ScreenOwner
  /** Sessions driving the screen (agent) or waiting on the human (human). */
  readonly sessionIDs: string[]
  /** Last GUI tool the agent used. */
  readonly tool?: string
  /** When the current owner took the screen. */
  readonly since?: number
  readonly takeoverId?: string
  readonly reason?: string
}

// Tools that drive the host screen. The in-app `browser` pane is excluded: it renders in the client, not on the host.
const GUI_TOOL = /^(computer[._-](desktop|browser)|browse[._-]|playwright|chrome[-_]devtools|agent[-_](browser|desktop))/i
// Wrapper tools (code mode, shell) are matched on what they run.
const WRAPPER_TOOL = /^(execute|shell|bash)$/i
const GUI_PAYLOAD =
  /tools\.(computer\.(desktop|browser)\b|browse\b)|tools\[\\?["']browse\\?["']\]|\bagent-(desktop|browser)\b|\b(playwright|chrome-devtools|agent-browser)__/

/** Whether a tool call drives the host screen (mouse, keyboard, browser automation). */
export function isGuiToolCall(tool: string, input: unknown): boolean {
  if (GUI_TOOL.test(tool)) return true
  if (!WRAPPER_TOOL.test(tool)) return false
  let payload = ""
  try {
    payload = typeof input === "string" ? input : JSON.stringify(input ?? "")
  } catch {
    return false
  }
  return GUI_PAYLOAD.test(payload)
}

interface AgentActivity {
  readonly since: number
  tool: string
  lastActive: number
  readonly running: Set<string>
}

/**
 * Who owns the host screen. A pending human takeover wins; otherwise a session owns it while one of its GUI tool
 * calls runs and for `graceMs` after, which covers the model thinking between steps. Session idle or interrupt
 * releases it early.
 */
export class ScreenLock {
  private readonly agents = new Map<string, AgentActivity>()
  private readonly listeners = new Set<(state: ScreenState) => void>()
  private readonly unsubs: (() => void)[]
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private lastKey = ""
  private readonly takeovers: TakeoverManager
  private readonly graceMs: number
  private readonly now: () => number

  constructor(takeovers: TakeoverManager, graceMs = 20_000, now: () => number = Date.now) {
    this.takeovers = takeovers
    this.graceMs = graceMs
    this.now = now
    this.unsubs = [
      // The agent yields the screen by asking for a takeover.
      takeovers.onRequested((item) => this.release(item.sessionID)),
      takeovers.onResolved(() => this.changed()),
    ]
  }

  state(): ScreenState {
    const pending = this.takeovers.list()
    if (pending.length > 0) {
      const first = pending[0]
      return {
        owner: "human",
        sessionIDs: pending.map((t) => t.sessionID),
        since: first.createdAt,
        takeoverId: first.id,
        reason: first.reason,
      }
    }
    const now = this.now()
    const active = [...this.agents.entries()].filter(([, a]) => a.running.size > 0 || now - a.lastActive < this.graceMs)
    if (active.length === 0) return { owner: "idle", sessionIDs: [] }
    const latest = active.reduce((a, b) => (b[1].lastActive > a[1].lastActive ? b : a))[1]
    return {
      owner: "agent",
      sessionIDs: active.map(([id]) => id),
      tool: latest.tool,
      since: Math.min(...active.map(([, a]) => a.since)),
    }
  }

  /** True when a person may send input to the screen. */
  inputAllowed(): boolean {
    return this.state().owner !== "agent"
  }

  begin(sessionID: string, callID: string, tool: string): void {
    const now = this.now()
    const cur = this.agents.get(sessionID)
    const entry = cur && (cur.running.size > 0 || now - cur.lastActive < this.graceMs)
      ? cur
      : { since: now, tool, lastActive: now, running: new Set<string>() }
    entry.tool = tool
    entry.lastActive = now
    entry.running.add(callID)
    this.agents.set(sessionID, entry)
    this.changed()
  }

  end(sessionID: string, callID: string): void {
    const entry = this.agents.get(sessionID)
    if (!entry?.running.delete(callID)) return
    entry.lastActive = this.now()
    this.changed()
  }

  /** Drops agent activity for one session, or for all of them. */
  release(sessionID?: string): void {
    if (sessionID) this.agents.delete(sessionID)
    else this.agents.clear()
    this.changed()
  }

  onChange(cb: (state: ScreenState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    clearTimeout(this.expiryTimer)
    const now = this.now()
    for (const [id, a] of this.agents) {
      if (a.running.size === 0 && now - a.lastActive >= this.graceMs) this.agents.delete(id)
    }
    const idle = [...this.agents.values()].filter((a) => a.running.size === 0)
    if (idle.length > 0) {
      const next = Math.min(...idle.map((a) => a.lastActive + this.graceMs)) - now
      this.expiryTimer = setTimeout(() => this.changed(), Math.max(0, next) + 10)
      this.expiryTimer.unref?.()
    }
    const state = this.state()
    const key = `${state.owner}|${state.sessionIDs.join(",")}|${state.tool ?? ""}|${state.takeoverId ?? ""}`
    if (key === this.lastKey) return
    this.lastKey = key
    for (const cb of this.listeners) {
      try {
        cb(state)
      } catch {
        // Ignore listener errors.
      }
    }
  }

  dispose(): void {
    clearTimeout(this.expiryTimer)
    for (const u of this.unsubs) u()
    this.listeners.clear()
    this.agents.clear()
  }
}
