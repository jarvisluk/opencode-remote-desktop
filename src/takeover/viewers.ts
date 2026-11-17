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

  /**
   * True when the user needs the console link: no controller shows Live Screen for this session. A desktop app
   * without a panel is the app on the host itself, where the screen is already in front of the user.
   */
  needsLink(sessionID: string, now = Date.now()): boolean {
    const w = this.watching(sessionID, now)
    return w.length === 0 || (!w.some((b) => b.panel) && w.some((b) => b.platform !== "desktop"))
  }

  /**
   * True when the only fresh controller on this session is the desktop app running on the host itself — the local
   * server, where Live Screen is intentionally hidden. There is no panel and no remote person who could take over
   * or type a secret, so takeover and secret prompts must not block the session (they have no input endpoint).
   */
  isLocalHost(sessionID: string, now = Date.now()): boolean {
    const w = this.watching(sessionID, now)
    return w.length > 0 && w.every((b) => b.platform === "desktop" && !b.panel)
  }

  /** One line for the model describing who is controlling this session. */
  describe(sessionID: string, now = Date.now()): string {
    const w = this.watching(sessionID, now)
    if (w.length === 0) return "No desktop app with the bot plugin reports this session open, so the user is likely on the web/mobile client, the TUI or a third-party client. None of these has a Live Screen panel (plugin panels load only in the desktop app); takeover goes through the console link, which you must give the user."
    const kind = (b: ViewerBeat) =>
      `${b.platform}${b.mobile ? " (mobile)" : ""} — ${b.panel ? "Live Screen panel available" : b.platform === "desktop" ? "on the host Mac itself, no panel needed" : "no Live Screen panel"}`
    return `This session is open in: ${w.map(kind).join("; ")}.`
  }
}
