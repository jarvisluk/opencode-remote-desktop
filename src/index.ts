import { join } from "node:path"
import { Plugin, Skill } from "@opencode/plugin"
import { resolveOptions } from "./options.ts"
import { BotRpc } from "./rpc.ts"
import { KeepAwakeController } from "./macos/awake.ts"
import {
  captureScreenJpeg,
  injectRemoteInput,
  listWindows,
  type RemoteInputKind,
} from "./macos/desktop.ts"
import { MacBrowserController } from "./macos/browser.ts"
import { TakeoverManager } from "./takeover/manager.ts"
import { WebTakeoverConsole } from "./takeover/web-console.ts"
import { StreamSidecar } from "./stream/sidecar.ts"
import { RoutineScheduler } from "./routines/scheduler.ts"
import { collectBotStatus } from "./status.ts"
import { collectDiagnostics, startupWarnings } from "./diagnostics.ts"
import { registerBotTools } from "./tools.ts"
import { registerBotCommands } from "./commands.ts"

// Match keywords on word boundaries for Latin words, or literal substring for Chinese characters
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

export function containsHighRiskIntent(values: readonly string[]): string | null {
  const joined = values.join(" ").toLowerCase()
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (/^[\u4e00-\u9fa5]+$/.test(kw)) {
      if (joined.includes(kw)) return kw
    } else {
      const regex = new RegExp(`\\b${kw}\\b`, "i")
      if (regex.test(joined)) return kw
    }
  }
  return null
}

const OPERATOR_SKILL_CONTENT = `# Bot macOS Operator Guide

You have access to \`computer_*\` tools that directly control the **macOS server** hosting OpenCode.
Use \`computer_screenshot\` to inspect what's on screen, \`computer_desktop\` to interact via accessibility tree,
\`computer_browser\` to automate the signed-in desktop browser, and \`computer_request_takeover\` when you need the human user
to log in with QR code, 2FA, Passkey, or solve a CAPTCHA.

Keep actions safe, concise, and confirm after mutations.
`

export default Plugin.define({
  id: "bot",
  async setup(ctx) {
    const options = resolveOptions(ctx.options as Record<string, unknown> | undefined)
    // Desktop only loads GUI parts of plugins on its own server, so a controller must load the
    // plugin too; with host: false it serves the sidebar without exposing this machine.
    if (!options.host) return async () => {}
    const isMac = process.platform === "darwin"

    const awake = new KeepAwakeController(isMac ? options.keepAwake : "off")
    const takeovers = new TakeoverManager(() => awake.acquire())
    const webConsole = new WebTakeoverConsole(options, takeovers)
    const browser = new MacBrowserController(options.reuseHostBrowser)
    const routines = new RoutineScheduler(ctx, () => awake.acquire(), options.routinePollMs)
    const streamOptions = {
      iceServers: options.iceServers,
      fps: options.streamFps,
      bitrate: options.streamBitrate,
      maxDimension: options.streamMaxDimension,
      backend: options.streamBackend,
      ffmpegInputArgs: options.ffmpegInputArgs,
    }
    const streamProbe = StreamSidecar.probe(streamOptions)
    const stream = streamProbe.backend ? new StreamSidecar(streamOptions) : null
    if (!stream) {
      console.warn(`[bot] 实时直播不可用：${streamProbe.reason ?? "未知原因"}；实时画面将降级为 JPEG 轮询`)
    } else if (streamProbe.backend === "ffmpeg") {
      console.warn("[bot] 直播使用 FFmpeg 后端：观看可用，接管期间键鼠注入将走 agent-desktop 降级路径")
    }

    // Dependency probe: surface missing CLIs / unavailable stream backend at startup
    // instead of first tool failure. Works on every platform (no-ops are cheap).
    try {
      for (const warning of startupWarnings(await collectDiagnostics(undefined, { backend: options.streamBackend }))) console.warn(warning)
    } catch {
      // Diagnostics must never block plugin startup.
    }

    if (isMac) {
      try {
        await webConsole.start()
      } catch (err) {
        console.error("[bot] Failed to start WebTakeoverConsole, disabling web console feature:", err)
      }
      routines.start()
    }

    // 1. Cross-network RPC registration (usable by @opencode/client, TUI, Desktop, or external scripts)
    const rpcReg = await ctx.rpc.register(BotRpc, {
      status: async (_input, callCtx) => {
        const summary = await collectBotStatus({
          awake,
          browser,
          webConsole,
          takeovers,
          routines,
          signal: callCtx.signal,
        })
        return {
          platform: summary.desktop.platform,
          supported: summary.desktop.supported,
          accessibility: summary.desktop.accessibility,
          screenRecording: summary.desktop.screenRecording,
          keepAwakeActive: summary.keepAwakeActive,
          browserMode: summary.browserMode,
          consoleUrls: summary.consoleUrls as string[],
          activeTakeovers: summary.activeTakeovers.length,
          routineCount: summary.routines.length,
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
          kind: RemoteInputKind
          x?: number
          y?: number
          deltaY?: number
          text?: string
          key?: string
          app?: string
        }
        return injectRemoteInput(input, callCtx.signal)
      },
      listWindows: async (rawInput, callCtx) => {
        const input = (rawInput ?? {}) as { app?: string }
        const windows = await listWindows(input.app, callCtx.signal)
        return {
          windows: windows.map((w) => ({
            id: w.id,
            appName: w.appName,
            title: w.title,
            isFocused: w.isFocused,
            visible: w.visible,
          })),
        }
      },
      focusWindow: async (rawInput, callCtx) => {
        const input = (rawInput ?? {}) as { windowId?: string; app?: string }
        const args = ["focus-window"]
        if (input.windowId) args.push("--window-id", input.windowId)
        else if (input.app) args.push("--app", input.app)
        else return { ok: false }
        const res = await injectRemoteInput({ kind: "key", key: "", app: input.app }, callCtx.signal).catch(() => null)
        return { ok: res ? res.ok : true }
      },
      listTakeovers: async () => {
        return {
          items: takeovers.list().map((t) => ({
            id: t.id,
            sessionID: t.sessionID,
            reason: t.reason,
            app: t.app,
            createdAt: t.createdAt,
          })),
        }
      },
      resolveTakeover: async (rawInput) => {
        const input = rawInput as { sessionID?: string; note?: string }
        const resolved = takeovers.resolveBySession(input.sessionID, input.note)
        return { resolved: resolved.length }
      },
      streamOffer: async (rawInput) => {
        const { sdp } = rawInput as { sdp: string }
        if (!stream) throw new Error("Live stream helpers are not built for this platform (run npm run build:native)")
        return stream.offer(sdp)
      },
      streamClose: async (rawInput) => {
        await stream?.close((rawInput as { session: string }).session)
        return { ok: true }
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
      if (!event.action.startsWith("bot.")) return
      const matchedKeyword = containsHighRiskIntent([
        ...event.resources,
        JSON.stringify(event.metadata ?? {}),
      ])
      if (matchedKeyword && event.effect === "allow") {
        event.effect = "ask"
        event.message = `Bot 检测到敏感操作关键词「${matchedKeyword}」，请确认是否允许在 Mac 上执行。`
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

    // 4. Context hook: inform the model about host Mac capabilities & Web Console availability (WITHOUT secret tokens)
    const contextHookReg = await ctx.session.hook("context", (event) => {
      if (!isMac) return
      const consoleState = options.consoleEnabled ? "Web Console available (run /bot to get access link)" : "Web Console disabled"
      event.system.push({
        type: "text",
        text: `[Bot macOS Host Active] You can operate this Mac mini's desktop GUI (\`computer_desktop\`), signed-in browser (\`computer_browser\`), screenshots (\`computer_screenshot\`), 24/7 routines (\`computer_routine\`), and human takeover (\`computer_request_takeover\`). ${consoleState}`,
      } as any)
    })

    // 5. Embedded Operator Skill
    const skillReg = await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make("bot-macos-operator"),
        name: Skill.Name.make("Bot macOS Operator"),
        description:
          "Operate the macOS host desktop GUI, signed-in browser, screenshots, human takeover (2FA, QR login, Passkey), and 24/7 background routines.",
        path: Skill.Info.fields.path.make(join(ctx.location.directory, ".opencode/skills/bot-macos-operator/SKILL.md")),
        content: OPERATOR_SKILL_CONTENT,
      })
    })

    // 6. Slash Commands (available across OpenCode Web, Mobile Beta, Desktop, and TUI)
    const cmdReg = await ctx.command.transform((editor) => {
      registerBotCommands(editor, {
        options,
        awake,
        browser,
        webConsole,
        takeovers,
        routines,
        syntheticSessionMessage: async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID, text })
        },
        promptSession: async (params) => {
          await ctx.session.prompt(params)
        },
      })
    })

    // 7. Server-side Computer Use, Takeover & Routine Tools
    const toolReg = await ctx.tool.transform((editor) => {
      registerBotTools(editor, {
        options,
        isMac,
        awake,
        takeovers,
        webConsole,
        browser,
        routines,
        permissionAssert: async (params) => {
          await ctx.permission.assert(params)
        },
      })
    })

    return async () => {
      unsubReq()
      unsubRes()
      routines.dispose()
      stream?.dispose()
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
