const FRESH_MS = 45_000

export interface ViewerBeat {
  readonly clientId: string
  readonly platform: "web" | "desktop"
  readonly mobile: boolean
}

/** Tracks which controllers have the bot GUI plugin loaded, from the heartbeats it sends over RPC. */
export class ViewerRegistry {
  private readonly beats = new Map<string, ViewerBeat & { at: number }>()

  beat(input: ViewerBeat, now = Date.now()): void {
    for (const [id, b] of this.beats) if (now - b.at > FRESH_MS) this.beats.delete(id)
    this.beats.set(input.clientId, { ...input, at: now })
  }

  /** True when a controller with the Live Screen panel is watching, so no link needs to be sent. */
  hasPanelViewer(now = Date.now()): boolean {
    for (const b of this.beats.values()) if (!b.mobile && now - b.at <= FRESH_MS) return true
    return false
  }

  /** True when nothing has reported at all: the controller probably has no plugin (TUI, third-party client). */
  isUnknown(now = Date.now()): boolean {
    for (const b of this.beats.values()) if (now - b.at <= FRESH_MS) return false
    return true
  }
}
