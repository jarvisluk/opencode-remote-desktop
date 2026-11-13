import type { ToolEditor, ToolContext } from "@opencode/plugin/promise/tool"
import type { BotOptions } from "./options.ts"
import { captureScreenJpeg, runAgentDesktop } from "./macos/desktop.ts"
import type { KeepAwakeController } from "./macos/awake.ts"
import type { MacBrowserController } from "./macos/browser.ts"
import type { WebTakeoverConsole } from "./takeover/web-console.ts"
import type { TakeoverManager } from "./takeover/manager.ts"
import type { RoutineScheduler } from "./routines/scheduler.ts"
import { parseDailyAt } from "./routines/scheduler.ts"
import { collectBotStatus } from "./status.ts"
import { buildDesktopArgs, buildBrowserArgs } from "./args-builder.ts"

export function registerBotTools(
  editor: ToolEditor,
  context: {
    options: BotOptions
    isMac: boolean
    awake: KeepAwakeController
    takeovers: TakeoverManager
    webConsole: WebTakeoverConsole
    browser: MacBrowserController
    routines: RoutineScheduler
    permissionAssert: (params: any) => Promise<void>
  },
): void {
  const { options, isMac, awake, takeovers, webConsole, browser, routines, permissionAssert } = context

  editor.namespace({
    name: "computer",
    description:
      "Operate the macOS host computer running OpenCode Server (accessibility desktop GUI, signed-in browser, screenshots, remote Web takeover, and 24/7 routines).",
  })

  editor.add({
    name: "status",
    description:
      "Check macOS host readiness, TCC permissions (Accessibility & Screen Recording), displays, running windows, signed-in browser connection, and remote Web Console URLs.",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        includeWindows: { type: "boolean", description: "Include open macOS windows list" },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: any, toolCtx: ToolContext) => {
      const input = (rawInput ?? {}) as { includeWindows?: boolean }
      const summary = await collectBotStatus({
        awake,
        browser,
        webConsole,
        takeovers,
        routines,
        sessionID: toolCtx.sessionID,
        includeWindows: input.includeWindows,
        signal: toolCtx.signal,
      })
      return {
        content: JSON.stringify(
          {
            ...summary.desktop,
            keepAwakeActive: summary.keepAwakeActive,
            browserMode: summary.browserMode,
            consoleUrls: summary.consoleUrls,
            activeTakeovers: summary.activeTakeovers,
            routinesCount: summary.routines.length,
            ...(summary.windows ? { windows: summary.windows } : {}),
          },
          null,
          2,
        ),
      }
    },
  })

  editor.add({
    name: "screenshot",
    description:
      "Capture a JPEG screenshot of the macOS primary display or a specific application/window, returning both logical coordinates and the inline image to OpenCode Web.",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        app: { type: "string", description: "Optional macOS application name to capture (e.g. 'WeChat', 'Safari')" },
        windowId: { type: "string", description: "Optional window ID from list_windows (e.g. 'w-14675')" },
        screenIndex: { type: "number", description: "Display index (0 = primary)" },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: any, toolCtx: ToolContext) => {
      if (!isMac) {
        return { content: "computer_screenshot currently requires a macOS OpenCode Server." }
      }
      const input = (rawInput ?? {}) as { app?: string; windowId?: string; screenIndex?: number }
      const frame = await captureScreenJpeg({
        app: input.app,
        windowId: input.windowId,
        screenIndex: input.screenIndex,
        maxDimension: options.maxImageDimension,
        quality: options.jpegQuality,
        keepFile: false,
        signal: toolCtx.signal,
      })
      const dataUri = `data:image/jpeg;base64,${frame.jpegBuffer.toString("base64")}`
      return {
        content: [
          {
            type: "text",
            text: `Captured macOS screenshot (${frame.imageWidth}x${frame.imageHeight}px). Logical coordinate bounds: origin=(${frame.logicalX}, ${frame.logicalY}), size=${frame.logicalWidth}x${frame.logicalHeight}. Map visual positions proportionally into [origin, origin + size] when using mouse_click_xy.`,
          },
          {
            type: "file",
            uri: dataUri,
            mime: "image/jpeg",
            name: "macos-screen.jpg",
          },
        ],
      }
    },
  })

  editor.add({
    name: "desktop",
    description:
      "Observe and control macOS desktop GUI apps via native Accessibility Tree (`agent-desktop`) or headed coordinate fallback.",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "snapshot",
            "find",
            "list_windows",
            "list_apps",
            "list_notifications",
            "click",
            "double_click",
            "right_click",
            "type",
            "set_value",
            "press",
            "scroll",
            "launch",
            "focus_window",
            "mouse_click_xy",
            "wait",
          ],
        },
        app: { type: "string", description: "Target macOS application name (e.g. 'Finder', 'Notes', 'WeChat')" },
        ref: { type: "string", description: "Qualified element ref from snapshot (e.g. '@s8f3k2p9:e5')" },
        rootRef: { type: "string", description: "Drill into a container ref during snapshot" },
        skeleton: { type: "boolean", description: "Shallow skeleton map for large windows" },
        interactiveOnly: { type: "boolean", description: "Keep interactive elements only (default true for snapshot)" },
        text: { type: "string", description: "Text for type/set_value/find, or key combo for press (e.g. 'cmd+c', 'return')" },
        role: { type: "string", description: "Element role filter for find" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
        amount: { type: "number", description: "Scroll amount or wait ms" },
        x: { type: "number", description: "Logical X coordinate on macOS screen for mouse_click_xy" },
        y: { type: "number", description: "Logical Y coordinate on macOS screen for mouse_click_xy" },
        windowId: { type: "string", description: "Optional window ID for focus_window" },
        headed: { type: "boolean", description: "Use physical foreground input when semantic headless action is unsupported" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (rawInput: any, toolCtx: ToolContext) => {
      if (!isMac) {
        return { content: "computer_desktop currently requires a macOS OpenCode Server." }
      }
      const input = rawInput as any
      const readOnlyActions = new Set(["snapshot", "find", "list_windows", "list_apps", "list_notifications", "wait"])
      const needsHeaded =
        Boolean(input.headed) || input.action === "double_click" || input.action === "mouse_click_xy"

      if (!readOnlyActions.has(input.action)) {
        const targetResource = input.app || input.ref || "macos-desktop"
        await permissionAssert({
          sessionID: toolCtx.sessionID,
          agent: toolCtx.agent,
          source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
          action: needsHeaded ? "bot.desktop.headed" : "bot.desktop.act",
          resources: [targetResource],
          save: [targetResource],
          metadata: {
            desktopAction: input.action,
            text: input.text,
            headed: needsHeaded,
          },
        })
      }

      const built = buildDesktopArgs(input)
      if (built.error) {
        return { content: built.error }
      }

      const res = await runAgentDesktop(built.args!, {
        headed: needsHeaded,
        signal: toolCtx.signal,
      })
      return { content: res.raw }
    },
  })

  editor.add({
    name: "browser",
    description:
      "Operate the macOS host's browser via `agent-browser` (automatically reuses signed-in Microsoft Edge / Chrome via CDP when available).",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "snapshot", "read", "click", "fill", "type", "press", "scroll", "wait", "eval"],
        },
        target: {
          type: "string",
          description: "URL for open/read, element @ref/selector for click/fill/type, key for press, direction for scroll, or JS for eval",
        },
        value: {
          type: "string",
          description: "Text to fill/type, or pixel amount for scroll",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (rawInput: any, toolCtx: ToolContext) => {
      if (!isMac) {
        return { content: "computer_browser currently requires a macOS OpenCode Server." }
      }
      const input = rawInput as any
      const readOnly = new Set(["snapshot", "read", "wait"])

      if (!readOnly.has(input.action)) {
        const resource = input.target || "host-browser"
        await permissionAssert({
          sessionID: toolCtx.sessionID,
          agent: toolCtx.agent,
          source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
          action: "bot.browser.act",
          resources: [resource],
          save: [resource],
          metadata: { browserAction: input.action, target: input.target, value: input.value },
        })
      }

      const built = buildBrowserArgs(input)
      if (built.error) {
        return { content: built.error }
      }

      const out = await browser.run(built.args!, { signal: toolCtx.signal })
      const prefix = `[browser=${out.mode}]${out.warning ? ` Note: ${out.warning}` : ""}`
      return { content: `${prefix}\n${out.output}` }
    },
  })

  editor.add({
    name: "request_takeover",
    description:
      "Pause automation and ask the human user to take over the remote macOS screen for 2FA, QR login, Passkey, CAPTCHA, or payment confirmation. Resumes automatically when the user finishes in the Web Console or replies in chat.",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Clear explanation shown to the user (e.g. '请在远程画面中完成微信扫码登录')",
        },
        app: {
          type: "string",
          description: "Optional macOS app name to bring to front for the user",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    execute: async (rawInput: any, toolCtx: ToolContext) => {
      const input = rawInput as { reason: string; app?: string }
      if (isMac && input.app) {
        await runAgentDesktop(["focus-window", "--app", input.app], {
          headed: true,
          timeoutMs: 5_000,
          signal: toolCtx.signal,
        }).catch(() => {})
      }

      const urls = webConsole.getUrls(toolCtx.sessionID)
      const { item, promise } = takeovers.waitForHuman({
        sessionID: toolCtx.sessionID,
        reason: input.reason,
        app: input.app,
        signal: toolCtx.signal,
      })

      await toolCtx.progress({
        status: "waiting_for_human_takeover",
        takeoverID: item.id,
        reason: input.reason,
        consoleUrls: urls,
        hint: "打开上方链接远程操控 Mac 并点击「已完成操作」，或直接在聊天框回复任意确认消息继续。",
      })

      const userNote = await promise
      return {
        content: `Human completed takeover (${item.id})${userNote ? `: "${userNote}"` : ""}. Take a fresh snapshot or screenshot to verify the updated UI state before continuing.`,
      }
    },
  })

  editor.add({
    name: "routine",
    description:
      "Create, list, enable/disable, run immediately, or delete 24/7 background routines (persistent tasks that keep running on the Mac server even after clients disconnect).",
    options: { namespace: "computer", codemode: false },
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "enable", "disable", "run_now", "remove"],
        },
        id: { type: "string", description: "Routine ID (rt_...) for enable/disable/run_now/remove" },
        name: { type: "string", description: "Short name when creating a routine" },
        prompt: { type: "string", description: "Full autonomous task instructions when creating a routine" },
        everyMinutes: { type: "number", description: "Run repeatedly every N minutes (e.g. 60)" },
        dailyAt: { type: "string", description: "Run daily at local 24h time HH:MM (e.g. '09:00')" },
        reuseSession: {
          type: "boolean",
          description: "Keep memory in one dedicated session across runs (default true)",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (rawInput: any) => {
      const input = rawInput as {
        action: "list" | "create" | "enable" | "disable" | "run_now" | "remove"
        id?: string
        name?: string
        prompt?: string
        everyMinutes?: number
        dailyAt?: string
        reuseSession?: boolean
      }

      if (input.action === "list") {
        return { content: JSON.stringify(await routines.list(), null, 2) }
      }
      if (input.action === "create") {
        if (!input.name || !input.prompt) {
          return { content: "Error: `name` and `prompt` are required to create a routine." }
        }
        if (typeof input.everyMinutes === "number" && input.everyMinutes < 1) {
          return { content: "Error: `everyMinutes` must be at least 1." }
        }
        if (input.dailyAt && !parseDailyAt(input.dailyAt)) {
          return { content: "Error: `dailyAt` must be a valid 'HH:MM' time between 00:00 and 23:59." }
        }
        if (!input.everyMinutes && !input.dailyAt) {
          return { content: "Error: specify either `everyMinutes` (>= 1) or `dailyAt` ('HH:MM')." }
        }
        const created = await routines.create({
          name: input.name,
          prompt: input.prompt,
          everyMinutes: input.everyMinutes,
          dailyAt: input.dailyAt,
          reuseSession: input.reuseSession,
        })
        return { content: JSON.stringify(created, null, 2) }
      }
      if (!input.id) {
        return { content: `Error: \`id\` is required for action=${input.action}.` }
      }
      if (input.action === "enable" || input.action === "disable") {
        const updated = await routines.setEnabled(input.id, input.action === "enable")
        return { content: updated ? JSON.stringify(updated, null, 2) : `Routine not found: ${input.id}` }
      }
      if (input.action === "run_now") {
        return { content: JSON.stringify(await routines.triggerNow(input.id), null, 2) }
      }
      if (input.action === "remove") {
        const ok = await routines.remove(input.id)
        return { content: ok ? `Removed routine ${input.id}` : `Routine not found: ${input.id}` }
      }
      return { content: "Unknown routine action" }
    },
  })
}
