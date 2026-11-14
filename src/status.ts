import type { MacDesktopStatus, MacWindowInfo } from "./macos/desktop.ts"
import { getMacDesktopStatus, listWindows } from "./macos/desktop.ts"
import type { KeepAwakeController } from "./macos/awake.ts"
import type { MacBrowserController } from "./macos/browser.ts"
import type { BotOptions } from "./options.ts"
import { consoleLink } from "./console/link.ts"
import type { TakeoverManager, PendingTakeover } from "./takeover/manager.ts"
import type { RoutineScheduler, RoutineRecord } from "./routines/scheduler.ts"

export interface BotStatusSummary {
  desktop: MacDesktopStatus
  keepAwakeActive: boolean
  browserMode: string
  consoleUrl?: string
  activeTakeovers: readonly PendingTakeover[]
  routines: readonly RoutineRecord[]
  windows?: readonly MacWindowInfo[]
}

export async function collectBotStatus(params: {
  awake: KeepAwakeController
  browser: MacBrowserController
  options: BotOptions
  takeovers: TakeoverManager
  routines: RoutineScheduler
  sessionID?: string
  includeWindows?: boolean
  signal?: AbortSignal
}): Promise<BotStatusSummary> {
  const { awake, browser, options, takeovers, routines, sessionID, includeWindows, signal } = params
  const [desktop, routineList, windows] = await Promise.all([
    getMacDesktopStatus(signal),
    routines.list(),
    includeWindows ? listWindows(undefined, signal) : Promise.resolve(undefined),
  ])

  return {
    desktop,
    keepAwakeActive: awake.isActive,
    browserMode: browser.modeDescription,
    consoleUrl: consoleLink(options, sessionID),
    activeTakeovers: takeovers.list(),
    routines: routineList,
    ...(windows ? { windows } : {}),
  }
}
