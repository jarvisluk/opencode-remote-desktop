import type { CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command"
import type { DotBotOptions } from "./options.ts"
import type { KeepAwakeController } from "./macos/awake.ts"
import type { MacBrowserController } from "./macos/browser.ts"
import type { WebTakeoverConsole } from "./takeover/web-console.ts"
import type { TakeoverManager } from "./takeover/manager.ts"
import type { RoutineScheduler } from "./routines/scheduler.ts"
import { collectDotBotStatus } from "./status.ts"

export function registerDotBotCommands(
  editor: CommandEditor,
  context: {
    options: DotBotOptions
    awake: KeepAwakeController
    browser: MacBrowserController
    webConsole: WebTakeoverConsole
    takeovers: TakeoverManager
    routines: RoutineScheduler
    syntheticSessionMessage: (sessionID: string, text: string) => Promise<void>
    promptSession: (params: { sessionID: string; delivery?: any; text: string }) => Promise<void>
  },
): void {
  const { options, awake, browser, webConsole, takeovers, routines, syntheticSessionMessage, promptSession } = context

  editor.add({
    name: "dotbot",
    description: "查看 Mac 宿主机状态、无障碍/录屏权限及远程实时画面控制台链接",
    execute: async ({ sessionID }: CommandInvocation) => {
      const summary = await collectDotBotStatus({
        awake,
        browser,
        webConsole,
        takeovers,
        routines,
        sessionID,
      })
      const { desktop, keepAwakeActive, browserMode, consoleUrls, routines: routineList } = summary
      const lines = [
        `### DotBot macOS 宿主机状态`,
        `- **平台**: \`${desktop.platform}\` (${desktop.supported ? "已启用" : "当前仅支持 macOS"})`,
        `- **辅助功能权限 (Accessibility)**: \`${desktop.accessibility}\``,
        `- **屏幕录制权限 (Screen Recording)**: \`${desktop.screenRecording}\``,
        `- **防休眠 (caffeinate)**: \`${keepAwakeActive ? "运行中" : `待命 (${options.keepAwake})`}\``,
        `- **浏览器模式**: \`${browserMode}\``,
        `- **挂起中的人工接管**: \`${takeovers.size}\` 个`,
        `- **24/7 后台例程**: \`${routineList.length}\` 个`,
        consoleUrls.length > 0
          ? `- **Web / 手机端实时远程桌面链接**（含免密安全令牌）:\n${consoleUrls.map((u) => `  - ${u}`).join("\n")}`
          : `- **Web 控制台**: 未启用`,
      ]
      await syntheticSessionMessage(sessionID, lines.join("\n"))
    },
  })

  editor.add({
    name: "screen",
    description: "截取当前 Mac 屏幕并获取 Web / 手机端实时远程操控链接",
    execute: async ({ sessionID, delivery }: CommandInvocation) => {
      const urls = webConsole.getUrls(sessionID)
      await promptSession({
        sessionID,
        delivery,
        text: `请立即调用 computer_screenshot 截取当前 Mac 主屏幕，并把以下远程实时操控台链接展示给我：\n${urls.join("\n")}`,
      })
    },
  })

  editor.add({
    name: "takeover",
    description: "查看或结束人工接管（用法: /takeover 或 /takeover done [说明]）",
    execute: async ({ sessionID, prompt }: CommandInvocation) => {
      const arg = (prompt.text ?? "").trim()
      if (!arg || arg === "list") {
        const items = takeovers.list()
        const urls = webConsole.getUrls(sessionID)
        const body =
          items.length === 0
            ? `当前没有等待中的人工接管。\n实时画面控制台：${urls.join(" | ")}`
            : items
                .map((t) => `- \`${t.id}\` (会话 \`${t.sessionID}\`): ${t.reason}`)
                .join("\n") + `\n\n操作完成后点击控制台绿色按钮，或发送 \`/takeover done\` 交还 AI。`
        await syntheticSessionMessage(sessionID, body)
        return
      }
      const note = arg.replace(/^done\s*/i, "").trim() || "User confirmed via /takeover"
      const resolved = takeovers.resolveBySession(sessionID, note)
      if (resolved.length === 0) {
        // Also allow resolving any session's pending takeover if invoked from another tab
        const anyResolved = takeovers.resolveBySession(undefined, note)
        await syntheticSessionMessage(
          sessionID,
          anyResolved.length > 0 ? `已恢复 ${anyResolved.length} 个挂起的人工接管任务。` : "当前没有挂起的人工接管任务。",
        )
      }
    },
  })

  editor.add({
    name: "routine",
    description: "查看或立即触发 24/7 常驻例程（用法: /routine 或 /routine run <id>）",
    execute: async ({ sessionID, prompt }: CommandInvocation) => {
      const arg = (prompt.text ?? "").trim()
      const runMatch = arg.match(/^run\s+(\S+)/i)
      if (runMatch) {
        const out = await routines.triggerNow(runMatch[1])
        await syntheticSessionMessage(
          sessionID,
          out.ok
            ? `已触发后台例程 \`${runMatch[1]}\`，运行会话：\`${out.sessionID}\``
            : `触发失败：${out.error}`,
        )
        return
      }
      const list = await routines.list()
      if (list.length === 0) {
        await syntheticSessionMessage(
          sessionID,
          "当前暂无 24/7 常驻例程。你可以直接用自然语言告诉我（例如：「每天早上 9 点帮我巡检微信和邮件摘要」），我会调用 `computer_routine` 创建。",
        )
        return
      }
      const rows = list.map(
        (r) =>
          `- \`${r.id}\` **${r.name}** [${r.enabled ? "启用" : "暂停"}] · 周期: ${
            r.everyMinutes ? `每 ${r.everyMinutes} 分钟` : `每日 ${r.dailyAt}`
          } · 下次执行: ${new Date(r.nextRunAt).toLocaleString()}`,
      )
      await syntheticSessionMessage(sessionID, `### 24/7 常驻例程列表\n${rows.join("\n")}`)
    },
  })
}
