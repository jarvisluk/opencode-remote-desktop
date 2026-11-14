const FRESH_MS = 45_000

export interface ViewerBeat {
  readonly clientId: string
  readonly platform: "web" | "desktop"
  readonly mobile: boolean
  /** Session currently open in this controller on this server, if any. */
  readonly sessionID?: string
  /** Whether the Live Screen panel (or its mobile tab) can show for that session; hidden when the desktop app is on the host itself. */
  readonly panel: boolean
}

/** Tracks which controllers have the bot GUI plugin loaded and which session each is looking at, from RPC heartbeats. */
export class ViewerRegistry {
  private readonly beats = new Map<string, ViewerBeat & { at: number }>()

  beat(input: ViewerBeat, now = Date.now()): void {
    for (const [id, b] of this.beats) if (now - b.at > FRESH_MS) this.beats.delete(id)
    this.beats.set(input.clientId, { ...input, at: now })
  }

  /** Fresh controllers that have this session open. */
  watching(sessionID: string, now = Date.now()): ViewerBeat[] {
    return [...this.beats.values()].filter((b) => b.sessionID === sessionID && now - b.at <= FRESH_MS)
  }

  /** True when some controller showing this session can open Live Screen for it. */
  hasPanelViewer(sessionID: string, now = Date.now()): boolean {
    return this.watching(sessionID, now).some((b) => b.panel)
  }

  /** True when the console link should go into the chat: nobody has a panel for this session, or someone watching it lacks one. */
  needsLink(sessionID: string, now = Date.now()): boolean {
    const w = this.watching(sessionID, now)
    return w.length === 0 || w.some((b) => !b.panel)
  }

  /** True when a desktop app has this session open without a panel, so its in-app browser is in front of the user. */
  hasDesktopWithoutPanel(sessionID: string, now = Date.now()): boolean {
    return this.watching(sessionID, now).some((b) => b.platform === "desktop" && !b.panel)
  }

  /** One line for the model describing who is controlling this session. */
  describe(sessionID: string, now = Date.now()): string {
    const w = this.watching(sessionID, now)
    if (w.length === 0) return "No controller with the bot plugin reports this session open (TUI, third-party client, or web/mobile without the plugin)."
    const kind = (b: ViewerBeat) =>
      `${b.platform}${b.mobile ? " (mobile)" : ""} — ${b.panel ? "Live Screen panel available" : "no Live Screen panel"}`
    return `This session is open in: ${w.map(kind).join("; ")}.`
  }
}
