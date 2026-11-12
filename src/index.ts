import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { resolveOptions } from "./options.ts"
import { DotBotRpc } from "./rpc.ts"
import { KeepAwakeController } from "./macos/awake.ts"
import {
  captureScreenJpeg,
  getMacDesktopStatus,
  injectRemoteInput,
  listWindows,
  runAgentDesktop,
} from "./macos/desktop.ts"
import { MacBrowserController } from "./macos/browser.ts"
import { TakeoverManager } from "./takeover/manager.ts"
import { WebTakeoverConsole } from "./takeover/web-console.ts"
import { RoutineScheduler } from "./routines/scheduler.ts"

const HIGH_RISK_KEYWORDS = [
  "pay",
  "checkout",
  "purchase",
  "transfer",
  "delete",
  "remove",
  "send",
  "submit",
  "publish",
  "password",
  "2fa",
  "付款",
  "支付",
  "转账",
  "下单",
  "删除",
  "发送",
  "发布",
]

function containsHighRiskIntent(values: readonly string[]): string | null {
  const joined = values.join(" ").toLowerCase()
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (joined.includes(kw)) return kw
  }
  return null
}

const OPERATOR_SKILL_CONTENT = `# DotBot macOS Operator Guide

You have access to \`computer_*\` tools that directly control the **macOS server** hosting OpenCode.

## Golden Workflow
1. **Desktop GUI (\`computer_desktop\`)**:
   - Always observe first with \`action: "snapshot"\` (uses macOS Accessibility Tree, headless by default, never steals user focus).
   - Act on qualified \`@<snapshot_id>:eN\` refs from the latest snapshot (\`click\`, \`type\`, \`set_value\`, \`press\`, \`scroll\`).
   - Re-snapshot after UI changes to verify state; never reuse stale refs.
   - Fall back to \`computer_screenshot\` + \`mouse_click_xy\` (headed physical coordinates) ONLY for custom canvas/non-accessible controls.
2. **Signed-in Browser (\`computer_browser\`)**:
   - Automatically connects to the host's running Microsoft Edge / Chrome when remote debugging (\`DevToolsActivePort\`) is enabled.
   - Always open new URLs with \`action: "open"\` rather than overwriting or closing the user's existing tabs.
3. **Human Takeover (\`computer_request_takeover\`) — NEVER ask for passwords in chat**:
   - Whenever you hit a login wall, QR code, 2FA, Passkey, CAPTCHA, or payment verification:
     1. First call \`computer_screenshot\` so the user immediately sees the QR code / prompt inline in OpenCode Web.
     2. Then call \`computer_request_takeover\` with a clear \`reason\`.
   - The user can either operate the Mac live via the signed Web Console URL or reply in chat / click Resume when finished.
4. **Safety**:
   - Never submit payments, send external messages/emails/posts, or delete user data without explicit user confirmation.
`

export default Plugin.define({
  id: "dotbot",
  async setup(ctx) {
    const options = resolveOptions(ctx.options as Record<string, unknown> | undefined)
    const isMac = process.platform === "darwin"

    const awake = new KeepAwakeController(isMac ? options.keepAwake : "off")
    const takeovers = new TakeoverManager(() => awake.acquire())
    const webConsole = new WebTakeoverConsole(options, takeovers)
    const browser = new MacBrowserController(options.reuseHostBrowser)
    const routines = new RoutineScheduler(ctx, () => awake.acquire(), options.routinePollMs)

    if (isMac) {
      await webConsole.start()
      routines.start()
    }

    // 1. Cross-network RPC registration (usable by @opencode/client, TUI, Desktop, or external scripts)
    const rpcReg = await ctx.rpc.register(DotBotRpc, {
      status: async (_input, callCtx) => {
        const desktop = await getMacDesktopStatus(callCtx.signal)
        const routineList = await routines.list()
        return {
          platform: desktop.platform,
          supported: desktop.supported,
          accessibility: desktop.accessibility,
          screenRecording: desktop.screenRecording,
          keepAwakeActive: awake.isActive,
          browserMode: browser.modeDescription,
          consoleUrls: webConsole.getUrls(),
          activeTakeovers: takeovers.size,
          routineCount: routineList.length,
        }
      },
      frame: async (rawInput, callCtx) => {
        const input = (rawInput ?? {}) as {
          windowId?: string
          app?: string
          maxDimension?: number
          quality?: number
        }
        const captured = await captureScreenJpeg({
          windowId: input.windowId,
          app: input.app,
          maxDimension: input.maxDimension ?? options.maxImageDimension,
          quality: input.quality ?? options.jpegQuality,
          signal: callCtx.signal,
        })
        return {
          jpegBase64: captured.jpegBuffer.toString("base64"),
          imageWidth: captured.imageWidth,
          imageHeight: captured.imageHeight,
          logicalX: captured.logicalX,
          logicalY: captured.logicalY,
          logicalWidth: captured.logicalWidth,
          logicalHeight: captured.logicalHeight,
          timestamp: captured.timestamp,
        }
      },
      sendInput: async (rawInput, callCtx) => {
        const input = rawInput as {
          kind: "click" | "double_click" | "right_click" | "scroll" | "type" | "key"
          x?: number
          y?: number
          deltaY?: number
          text?: string
          key?: string
          app?: string
        }
        return injectRemoteInput(input, callCtx.signal)
      },
      listTakeovers: async () => ({
        items: takeovers.list(),
      }),
      resolveTakeover: async (rawInput) => {
        const input = (rawInput ?? {}) as { sessionID?: string; note?: string }
        const resolved = takeovers.resolveBySession(input.sessionID, input.note)
        return { resolved: resolved.length }
      },
    })

    const unsubReq = takeovers.onRequested((item) => {
      void rpcReg.events.emit("takeoverRequested", {
        id: item.id,
        sessionID: item.sessionID,
        reason: item.reason,
        consoleUrls: webConsole.getUrls(item.sessionID),
      })
    })
    const unsubRes = takeovers.onResolved((item, note) => {
      void rpcReg.events.emit("takeoverResolved", {
        id: item.id,
        sessionID: item.sessionID,
        ...(note ? { note } : {}),
      })
    })

    // 2. Permission guardrail hook: escalate high-risk GUI/Browser mutations to interactive Web approval
    const permHookReg = await ctx.permission.hook("evaluate", (event) => {
      if (!event.action.startsWith("dotbot.")) return
      const matchedKeyword = containsHighRiskIntent([
        ...event.resources,
        JSON.stringify(event.metadata ?? {}),
      ])
      if (matchedKeyword && event.effect === "allow") {
        event.effect = "ask"
        event.message = `DotBot 检测到敏感操作关键词「${matchedKeyword}」，请确认是否允许在 Mac 上执行。`
      }
    })

    // 3. Prompt admission hook: if a session is waiting for Human Takeover and the user replies in OpenCode Web/Mobile chat,
    //    automatically wake up the suspended takeover with the user's message!
    const promptHookReg = await ctx.session.hook("prompt", (event) => {
      const hasPending = takeovers.list().some((t) => t.sessionID === event.sessionID)
      if (hasPending) {
        takeovers.resolveBySession(event.sessionID, event.prompt.text)
      }
    })

    // 4. Context hook: inform the model about host Mac capabilities & Web Console availability
    const contextHookReg = await ctx.session.hook("context", (event) => {
      if (!isMac) return
      const urls = webConsole.getUrls(event.sessionID)
      const urlHint = urls.length > 0 ? `Live Mac Web Console URLs: ${urls.join(" | ")}` : "Web Console disabled"
      event.system.push({
        type: "text",
        text: `[DotBot macOS Host Active] You can operate this Mac mini's desktop GUI (\`computer_desktop\`), signed-in browser (\`computer_browser\`), screenshots (\`computer_screenshot\`), 24/7 routines (\`computer_routine\`), and human takeover (\`computer_request_takeover\`). ${urlHint}`,
      } as any)
    })

    // 5. Embedded Operator Skill
    const skillReg = await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make("dotbot-macos-operator"),
        name: Skill.Name.make("DotBot macOS Operator"),
        description:
          "Operate the macOS host desktop GUI, signed-in browser, screenshots, human takeover (2FA, QR login, Passkey), and 24/7 background routines.",
        path: Skill.Info.fields.path.make(join(ctx.location.directory, ".opencode/skills/dotbot-macos-operator/SKILL.md")),
        content: OPERATOR_SKILL_CONTENT,
      })
    })

    // 6. Slash Commands (available across OpenCode Web, Mobile Beta, Desktop, and TUI)
    const cmdReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "dotbot",
        description: "查看 Mac 宿主机状态、无障碍/录屏权限及远程实时画面控制台链接",
        execute: async ({ sessionID }) => {
          const desktop = await getMacDesktopStatus()
          const urls = webConsole.getUrls(sessionID)
          const routineList = await routines.list()
          const lines = [
            `### DotBot macOS 宿主机状态`,
            `- **平台**: \`${desktop.platform}\` (${desktop.supported ? "已启用" : "当前仅支持 macOS"})`,
            `- **辅助功能权限 (Accessibility)**: \`${desktop.accessibility}\``,
            `- **屏幕录制权限 (Screen Recording)**: \`${desktop.screenRecording}\``,
            `- **防休眠 (caffeinate)**: \`${awake.isActive ? "运行中" : `待命 (${options.keepAwake})`}\``,
            `- **浏览器模式**: \`${browser.modeDescription}\``,
            `- **挂起中的人工接管**: \`${takeovers.size}\` 个`,
            `- **24/7 后台例程**: \`${routineList.length}\` 个`,
            urls.length > 0
              ? `- **Web / 手机端实时远程桌面链接**（含免密安全令牌）:\n${urls.map((u) => `  - ${u}`).join("\n")}`
              : `- **Web 控制台**: 未启用`,
          ]
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
        },
      })

      editor.add({
        name: "screen",
        description: "截取当前 Mac 屏幕并获取 Web / 手机端实时远程操控链接",
        execute: async ({ sessionID, delivery }) => {
          const urls = webConsole.getUrls(sessionID)
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `请立即调用 computer_screenshot 截取当前 Mac 主屏幕，并把以下远程实时操控台链接展示给我：\n${urls.join("\n")}`,
          })
        },
      })

      editor.add({
        name: "takeover",
        description: "查看或结束人工接管（用法: /takeover 或 /takeover done [说明]）",
        execute: async ({ sessionID, prompt }) => {
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
            await ctx.session.synthetic({ sessionID, text: body })
            return
          }
          const note = arg.replace(/^done\s*/i, "").trim() || "User confirmed via /takeover"
          const resolved = takeovers.resolveBySession(sessionID, note)
          if (resolved.length === 0) {
            // Also allow resolving any session's pending takeover if invoked from another tab
            const anyResolved = takeovers.resolveBySession(undefined, note)
            await ctx.session.synthetic({
              sessionID,
              text: anyResolved.length > 0 ? `已恢复 ${anyResolved.length} 个挂起的人工接管任务。` : "当前没有挂起的人工接管任务。",
            })
          }
        },
      })

      editor.add({
        name: "routine",
        description: "查看或立即触发 24/7 常驻例程（用法: /routine 或 /routine run <id>）",
        execute: async ({ sessionID, prompt }) => {
          const arg = (prompt.text ?? "").trim()
          const runMatch = arg.match(/^run\s+(\S+)/i)
          if (runMatch) {
            const out = await routines.triggerNow(runMatch[1])
            await ctx.session.synthetic({
              sessionID,
              text: out.ok
                ? `已触发后台例程 \`${runMatch[1]}\`，运行会话：\`${out.sessionID}\``
                : `触发失败：${out.error}`,
            })
            return
          }
          const list = await routines.list()
          if (list.length === 0) {
            await ctx.session.synthetic({
              sessionID,
              text: "当前暂无 24/7 常驻例程。你可以直接用自然语言告诉我（例如：「每天早上 9 点帮我巡检微信和邮件摘要」），我会调用 `computer_routine` 创建。",
            })
            return
          }
          const rows = list.map(
            (r) =>
              `- \`${r.id}\` **${r.name}** [${r.enabled ? "启用" : "暂停"}] · 周期: ${
                r.everyMinutes ? `每 ${r.everyMinutes} 分钟` : `每日 ${r.dailyAt}`
              } · 下次执行: ${new Date(r.nextRunAt).toLocaleString()}`,
          )
          await ctx.session.synthetic({ sessionID, text: `### 24/7 常驻例程列表\n${rows.join("\n")}` })
        },
      })
    })

    // 7. Server-side Computer Use, Takeover & Routine Tools
    const toolReg = await ctx.tool.transform((editor) => {
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
        execute: async (rawInput, toolCtx) => {
          const input = (rawInput ?? {}) as { includeWindows?: boolean }
          const [desktop, routineList, windows] = await Promise.all([
            getMacDesktopStatus(toolCtx.signal),
            routines.list(),
            input.includeWindows ? listWindows(undefined, toolCtx.signal) : Promise.resolve(undefined),
          ])
          return {
            content: JSON.stringify(
              {
                ...desktop,
                keepAwakeActive: awake.isActive,
                browserMode: browser.modeDescription,
                consoleUrls: webConsole.getUrls(toolCtx.sessionID),
                activeTakeovers: takeovers.list(),
                routinesCount: routineList.length,
                ...(windows ? { windows } : {}),
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
        execute: async (rawInput, toolCtx) => {
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
            keepFile: true,
            signal: toolCtx.signal,
          })
          return {
            content: [
              {
                type: "text",
                text: `Captured macOS screenshot (${frame.imageWidth}x${frame.imageHeight}px). Logical coordinate bounds: origin=(${frame.logicalX}, ${frame.logicalY}), size=${frame.logicalWidth}x${frame.logicalHeight}. Map visual positions proportionally into [origin, origin + size] when using mouse_click_xy.`,
              },
              {
                type: "file",
                uri: pathToFileURL(frame.jpegPath).href,
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
            headed: { type: "boolean", description: "Use physical foreground input when semantic headless action is unsupported" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (rawInput, toolCtx) => {
          if (!isMac) {
            return { content: "computer_desktop currently requires a macOS OpenCode Server." }
          }
          const input = rawInput as {
            action: string
            app?: string
            ref?: string
            rootRef?: string
            skeleton?: boolean
            interactiveOnly?: boolean
            text?: string
            role?: string
            direction?: "up" | "down" | "left" | "right"
            amount?: number
            x?: number
            y?: number
            headed?: boolean
          }

          const readOnlyActions = new Set(["snapshot", "find", "list_windows", "list_apps", "list_notifications", "wait"])
          const needsHeaded =
            Boolean(input.headed) || input.action === "double_click" || input.action === "mouse_click_xy"

          if (!readOnlyActions.has(input.action)) {
            const targetResource = input.app || input.ref || "macos-desktop"
            await ctx.permission.assert({
              sessionID: toolCtx.sessionID,
              agent: toolCtx.agent,
              source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
              action: needsHeaded ? "dotbot.desktop.headed" : "dotbot.desktop.act",
              resources: [targetResource],
              save: [targetResource],
              metadata: {
                desktopAction: input.action,
                text: input.text,
                headed: needsHeaded,
              },
            })
          }

          let args: string[] = []
          switch (input.action) {
            case "snapshot": {
              args = ["snapshot", "--compact"]
              if (input.interactiveOnly !== false) args.push("-i")
              if (input.skeleton) args.push("--skeleton")
              if (input.rootRef) args.push("--root", input.rootRef)
              if (input.app) args.push("--app", input.app)
              break
            }
            case "find": {
              args = ["find"]
              if (input.app) args.push("--app", input.app)
              if (input.role) args.push("--role", input.role)
              if (input.text) args.push("--text", input.text)
              break
            }
            case "list_windows": {
              args = ["list-windows"]
              if (input.app) args.push("--app", input.app)
              break
            }
            case "list_apps": {
              args = ["list-apps"]
              if (input.app) args.push("--app", input.app)
              break
            }
            case "list_notifications": {
              args = ["list-notifications"]
              break
            }
            case "click": {
              if (!input.ref) return { content: "Error: `ref` is required for click." }
              args = ["click", input.ref]
              break
            }
            case "double_click": {
              if (!input.ref) return { content: "Error: `ref` is required for double_click." }
              args = ["double-click", input.ref]
              break
            }
            case "right_click": {
              if (!input.ref) return { content: "Error: `ref` is required for right_click." }
              args = ["right-click", input.ref]
              break
            }
            case "type": {
              if (!input.ref || typeof input.text !== "string") {
                return { content: "Error: both `ref` and `text` are required for type." }
              }
              args = ["type", input.ref, input.text]
              break
            }
            case "set_value": {
              if (!input.ref || typeof input.text !== "string") {
                return { content: "Error: both `ref` and `text` are required for set_value." }
              }
              args = ["set-value", input.ref, input.text]
              break
            }
            case "press": {
              if (!input.text) return { content: "Error: `text` (key combo like 'return' or 'cmd+k') is required for press." }
              args = ["press"]
              if (input.app) args.push("--app", input.app)
              args.push(input.text)
              break
            }
            case "scroll": {
              if (!input.ref) return { content: "Error: `ref` is required for scroll." }
              args = ["scroll", input.ref, "--direction", input.direction ?? "down"]
              if (typeof input.amount === "number") args.push("--amount", String(input.amount))
              break
            }
            case "launch": {
              if (!input.app) return { content: "Error: `app` is required for launch." }
              args = ["launch", "--activate", input.app]
              break
            }
            case "focus_window": {
              args = ["focus-window"]
              if (input.app) args.push("--app", input.app)
              break
            }
            case "mouse_click_xy": {
              if (typeof input.x !== "number" || typeof input.y !== "number") {
                return { content: "Error: numeric `x` and `y` are required for mouse_click_xy." }
              }
              args = ["mouse-click", `--xy=${Math.round(input.x)},${Math.round(input.y)}`]
              break
            }
            case "wait": {
              const ms = typeof input.amount === "number" ? Math.min(30_000, Math.max(100, Math.round(input.amount))) : 1000
              args = ["wait", String(ms)]
              break
            }
            default:
              return { content: `Unsupported action: ${input.action}` }
          }

          const res = await runAgentDesktop(args, {
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
        execute: async (rawInput, toolCtx) => {
          if (!isMac) {
            return { content: "computer_browser currently requires a macOS OpenCode Server." }
          }
          const input = rawInput as { action: string; target?: string; value?: string }
          const readOnly = new Set(["snapshot", "read", "wait"])

          if (!readOnly.has(input.action)) {
            const resource = input.target || "host-browser"
            await ctx.permission.assert({
              sessionID: toolCtx.sessionID,
              agent: toolCtx.agent,
              source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
              action: "dotbot.browser.act",
              resources: [resource],
              save: [resource],
              metadata: { browserAction: input.action, target: input.target, value: input.value },
            })
          }

          let args: string[] = []
          switch (input.action) {
            case "open":
              if (!input.target) return { content: "Error: `target` URL is required for open." }
              args = ["open", input.target]
              break
            case "snapshot":
              args = ["snapshot"]
              break
            case "read":
              args = input.target ? ["read", input.target] : ["read"]
              break
            case "click":
              if (!input.target) return { content: "Error: `target` (@ref or selector) is required for click." }
              args = ["click", input.target]
              break
            case "fill":
              if (!input.target || typeof input.value !== "string") {
                return { content: "Error: `target` and `value` are required for fill." }
              }
              args = ["fill", input.target, input.value]
              break
            case "type":
              if (!input.target || typeof input.value !== "string") {
                return { content: "Error: `target` and `value` are required for type." }
              }
              args = ["type", input.target, input.value]
              break
            case "press":
              if (!input.target) return { content: "Error: `target` key name is required for press." }
              args = ["press", input.target]
              break
            case "scroll":
              args = ["scroll", input.target || "down"]
              if (input.value) args.push(input.value)
              break
            case "wait":
              args = ["wait", input.target || "1000"]
              break
            case "eval":
              if (!input.target) return { content: "Error: `target` JS expression is required for eval." }
              args = ["eval", input.target]
              break
            default:
              return { content: `Unsupported browser action: ${input.action}` }
          }

          const out = await browser.run(args, { signal: toolCtx.signal })
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
        execute: async (rawInput, toolCtx) => {
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
          "Create, list, enable/disable, run immediately, or delete 24/7 background routines (GPT Dots / Grok Bot style persistent tasks that keep running on the Mac server when clients disconnect).",
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
        execute: async (rawInput) => {
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
            if (!input.everyMinutes && !input.dailyAt) {
              return { content: "Error: specify either `everyMinutes` or `dailyAt` ('HH:MM')." }
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
    })

    return async () => {
      unsubReq()
      unsubRes()
      routines.dispose()
      takeovers.dispose()
      awake.dispose()
      await Promise.allSettled([
        webConsole.dispose(),
        toolReg.dispose(),
        cmdReg.dispose(),
        skillReg.dispose(),
        contextHookReg.dispose(),
        promptHookReg.dispose(),
        permHookReg.dispose(),
        rpcReg.dispose(),
      ])
    }
  },
})
