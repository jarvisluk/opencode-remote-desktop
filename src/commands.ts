import type { CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command"
import type { BotOptions } from "./options.ts"
import type { KeepAwakeController } from "./macos/awake.ts"
import type { MacBrowserController } from "./macos/browser.ts"
import type { TakeoverManager } from "./takeover/manager.ts"
import type { RoutineScheduler } from "./routines/scheduler.ts"
import { collectBotStatus } from "./status.ts"
import { consoleLink } from "./console/link.ts"
import { collectDiagnostics, formatDoctorReport, startupWarnings } from "./diagnostics.ts"
import { resolveLocale, toBcp47 } from "./i18n/locale.ts"
import { tServer } from "./i18n/server.ts"

export function registerBotCommands(
  editor: CommandEditor,
  context: {
    options: BotOptions
    awake: KeepAwakeController
    browser: MacBrowserController
    takeovers: TakeoverManager
    routines: RoutineScheduler
    syntheticSessionMessage: (sessionID: string, text: string) => Promise<void>
  },
): void {
  const { options, awake, browser, takeovers, routines, syntheticSessionMessage } = context
  const locale = resolveLocale(options.locale)

  editor.add({
    name: "bot",
    description: tServer(locale, "cmd.bot.description"),
    execute: async ({ sessionID }: CommandInvocation) => {
      const summary = await collectBotStatus({
        awake,
        browser,
        options,
        takeovers,
        routines,
        sessionID,
      })
      const { desktop, keepAwakeActive, browserMode, consoleUrl, routines: routineList } = summary
      const healthWarnings = startupWarnings(
        await collectDiagnostics(undefined, { backend: options.streamBackend, locale }),
        locale,
      )
      const lines = [
        tServer(locale, "cmd.bot.title"),
        tServer(locale, "cmd.bot.platform", {
          platform: desktop.platform,
          status: tServer(locale, desktop.supported ? "cmd.bot.platformEnabled" : "cmd.bot.platformMacOnly"),
        }),
        tServer(locale, "cmd.bot.accessibility", { state: desktop.accessibility }),
        tServer(locale, "cmd.bot.screenRecording", { state: desktop.screenRecording }),
        tServer(locale, "cmd.bot.keepAwake", {
          state: keepAwakeActive
            ? tServer(locale, "cmd.bot.keepAwakeRunning")
            : tServer(locale, "cmd.bot.keepAwakeStandby", { mode: options.keepAwake }),
        }),
        tServer(locale, "cmd.bot.browserMode", { mode: browserMode }),
        tServer(locale, "cmd.bot.pendingTakeovers", { count: takeovers.size }),
        tServer(locale, "cmd.bot.routines", { count: routineList.length }),
        consoleUrl
          ? tServer(locale, "cmd.bot.consoleUrl", { url: consoleUrl })
          : tServer(locale, "cmd.bot.consoleDisabled"),
        healthWarnings.length > 0
          ? tServer(locale, "cmd.bot.healthWarn", { count: healthWarnings.length })
          : tServer(locale, "cmd.bot.healthOk"),
      ]
      await syntheticSessionMessage(sessionID, lines.join("\n"))
    },
  })

  editor.add({
    name: "doctor",
    description: tServer(locale, "cmd.doctor.description"),
    execute: async ({ sessionID }: CommandInvocation) => {
      const [report, summary] = await Promise.all([
        collectDiagnostics(undefined, { backend: options.streamBackend, locale }),
        collectBotStatus({
          awake,
          browser,
          options,
          takeovers,
          routines,
          sessionID,
        }),
      ])
      const lines = [formatDoctorReport(report, locale)]
      lines.push(tServer(locale, "doctor.browserMode", { mode: summary.browserMode }))
      await syntheticSessionMessage(sessionID, lines.join("\n"))
    },
  })

  editor.add({
    name: "bot-link",
    description: tServer(locale, "cmd.screen.description"),
    execute: async ({ sessionID }: CommandInvocation) => {
      const url = consoleLink(options, sessionID, true)
      await syntheticSessionMessage(
        sessionID,
        url ? tServer(locale, "cmd.screen.prompt", { url }) : tServer(locale, "cmd.bot.consoleDisabled"),
      )
    },
  })

  editor.add({
    name: "takeover",
    description: tServer(locale, "cmd.takeover.description"),
    execute: async ({ sessionID, prompt }: CommandInvocation) => {
      const arg = (prompt.text ?? "").trim()
      if (!arg || arg === "list") {
        const items = takeovers.list()
        const body =
          items.length === 0
            ? tServer(locale, "cmd.takeover.empty", { url: consoleLink(options, sessionID) ?? "-" })
            : items
                .map((t) => tServer(locale, "cmd.takeover.item", { id: t.id, sessionID: t.sessionID, reason: t.reason }))
                .join("\n") + tServer(locale, "cmd.takeover.footer")
        await syntheticSessionMessage(sessionID, body)
        return
      }
      const note = arg.replace(/^done\s*/i, "").trim() || "User confirmed via /takeover"
      const resolved = takeovers.resolveBySession(sessionID, note, { source: "command" })
      if (resolved.length === 0) {
        // Also allow resolving any session's pending takeover if invoked from another tab
        const anyResolved = takeovers.resolveBySession(undefined, note, { source: "command" })
        await syntheticSessionMessage(
          sessionID,
          anyResolved.length > 0
            ? tServer(locale, "cmd.takeover.resumedCount", { count: anyResolved.length })
            : tServer(locale, "cmd.takeover.nonePending"),
        )
      }
    },
  })

  editor.add({
    name: "routine",
    description: tServer(locale, "cmd.routine.description"),
    execute: async ({ sessionID, prompt }: CommandInvocation) => {
      const arg = (prompt.text ?? "").trim()
      const runMatch = arg.match(/^run\s+(\S+)/i)
      if (runMatch) {
        const out = await routines.triggerNow(runMatch[1])
        await syntheticSessionMessage(
          sessionID,
          out.ok
            ? tServer(locale, "cmd.routine.triggered", { id: runMatch[1], sessionID: out.sessionID ?? "" })
            : tServer(locale, "cmd.routine.triggerFailed", { error: out.error ?? "" }),
        )
        return
      }
      const list = await routines.list()
      if (list.length === 0) {
        await syntheticSessionMessage(sessionID, tServer(locale, "cmd.routine.empty"))
        return
      }
      const dateLocale = toBcp47(locale)
      const rows = list.map((r) =>
        tServer(locale, "cmd.routine.row", {
          id: r.id,
          name: r.name,
          state: tServer(locale, r.enabled ? "cmd.routine.enabled" : "cmd.routine.paused"),
          schedule: r.everyMinutes
            ? tServer(locale, "cmd.routine.everyMinutes", { minutes: r.everyMinutes })
            : tServer(locale, "cmd.routine.dailyAt", { time: r.dailyAt ?? "" }),
          nextRun: new Date(r.nextRunAt).toLocaleString(dateLocale),
        }),
      )
      await syntheticSessionMessage(sessionID, tServer(locale, "cmd.routine.header", { rows: rows.join("\n") }))
    },
  })
}
