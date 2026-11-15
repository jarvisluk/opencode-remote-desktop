import { join } from "node:path"
import { Plugin, Skill } from "@opencode/plugin"
import { resolveOptions } from "./options.ts"
import { BotRpc } from "./rpc.ts"
import { hostClient } from "./host/client.ts"
import { KeepAwakeController } from "./macos/awake.ts"
import {
  captureScreenJpeg,
  disposeDesktopHelpers,
  injectRemoteInput,
  listWindows,
  runAgentDesktop,
  type RemoteInputKind,
} from "./macos/desktop.ts"
import { MacBrowserController } from "./macos/browser.ts"
import { TakeoverManager } from "./takeover/manager.ts"
import { SCREEN_BUSY_DETAIL, ScreenLock, isGuiToolCall } from "./takeover/screen-lock.ts"
import { SecretManager } from "./secrets.ts"
import { consoleLink } from "./console/link.ts"
import { ViewerRegistry, type ViewerBeat } from "./takeover/viewers.ts"
import { acquireShared } from "./shared.ts"
import { StreamSidecar } from "./stream/sidecar.ts"
import { RoutineScheduler } from "./routines/scheduler.ts"
import { collectBotStatus } from "./status.ts"
import { collectDiagnostics, startupWarnings } from "./diagnostics.ts"
import { registerBotTools } from "./tools.ts"
import { registerBotCommands } from "./commands.ts"
import { resolveLocale } from "./i18n/locale.ts"
import { tServer } from "./i18n/server.ts"

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

// The keychain items written by `/usr/bin/security` are readable by any `security` call from the same user, so reads get a prompt.
const KEYCHAIN_READ = /\b(find-generic-password|find-internet-password|dump-keychain)\b/

export function readsKeychain(values: readonly string[]): boolean {
  return KEYCHAIN_READ.test(values.join(" "))
}

const OPERATOR_SKILL_CONTENT = `# Bot macOS Operator Guide

You have access to fallback \`computer_*\` tools that wrap \`agent-desktop\` / \`agent-browser\` on the **macOS server** hosting OpenCode.

## Tool Priority Rules
- **Lower priority than dedicated tools / skills**: When native browser tools (\`browser\`, \`browse\`), MCP browser/desktop servers, or dedicated skills (\`agent-desktop\`, \`agent-browser\`) are available, **prefer those first**.
- Only use \`computer_desktop\` / \`computer_browser\` when dedicated tools cannot reach the remote host or when explicitly requested.
- Use \`computer_screenshot\` for host screen capture, \`computer_request_takeover\` when human intervention (login, account switch, QR scan, 2FA, Passkey, CAPTCHA, or payment confirmation) is needed on the remote screen, and \`computer_routine\` for 24/7 host routines.

When calling \`computer_request_takeover\`:
- OpenCode Desktop automatically opens the built-in **Live Screen** side panel and displays a takeover banner with a resume button.
- End your turn immediately after calling \`computer_request_takeover\` and briefly tell the user what to complete in **Live Screen** (or reply in chat when done).
- Do NOT paste standalone Web Console URLs unless the user explicitly asks for an external browser/mobile link (they can run \`/bot\` anytime).

When a login needs a password or other secret you do not have:
- Call \`computer_secret_request\` with a short \`name\` and a \`reason\` naming the site/app and account. It shows an input card to the user and waits; the value goes into the macOS Keychain and you never see it.
- Then focus the field and call \`computer_secret_type\` with the same \`name\` and the field's ref. Never ask the user to paste a secret into the chat, and never try to read the Keychain yourself.

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
    const locale = resolveLocale(options.locale)

    const shared = acquireShared(() => {
      const awake = new KeepAwakeController(hostClient.available() || isMac ? options.keepAwake : "off")
      const takeovers = new TakeoverManager(() => awake.acquire())
      const secrets = new SecretManager(() => awake.acquire())
      const browser = new MacBrowserController(options.reuseHostBrowser)
      const streamOptions = {
        iceServers: options.iceServers,
        fps: options.streamFps,
        bitrate: options.streamBitrate,
        maxDimension: options.streamMaxDimension,
        backend: options.streamBackend,
        ffmpegInputArgs: options.ffmpegInputArgs,
      }
      const streamProbe = StreamSidecar.probe({ ...streamOptions, locale })
      const stream = streamProbe.backend ? new StreamSidecar(streamOptions) : null
      const screen = new ScreenLock(takeovers)
      const unsubScreen = screen.onChange((state) => {
        void stream?.setInput(state.owner !== "agent").catch(() => {})
      })
      const viewers = new ViewerRegistry()
      return {
        value: { awake, takeovers, secrets, browser, streamProbe, stream, screen, viewers },
        dispose: () => {
          unsubScreen()
          screen.dispose()
          secrets.dispose()
          stream?.dispose()
          disposeDesktopHelpers()
          takeovers.dispose()
          awake.dispose()
        },
      }
    })
    const { awake, takeovers, secrets, browser, streamProbe, stream, screen, viewers } = shared.value
    const routines = new RoutineScheduler(ctx, () => awake.acquire(), options.routinePollMs)
    // Interrupts every session driving the screen and hands it to the person through a regular takeover,
    // so the existing resume button tells the agent to re-check the screen.
    const forceTakeover = async (sessionID?: string) => {
      const state = screen.state()
      if (state.owner === "human") return { interrupted: 0, ...(state.takeoverId ? { takeoverId: state.takeoverId } : {}) }
      const targets = state.owner === "agent" ? state.sessionIDs : []
      const results = await Promise.allSettled(
        targets.map((id) => ctx.session.interrupt({ sessionID: id as any, resume: false })),
      )
      screen.release()
      const owner = targets[0] ?? sessionID
      const item = owner ? takeovers.request({ sessionID: owner, reason: tServer(locale, "takeover.forcedReason") }) : undefined
      return {
        interrupted: results.filter((r) => r.status === "fulfilled").length,
        ...(item ? { takeoverId: item.id } : {}),
      }
    }
    if (!stream) {
      console.warn(
        tServer(locale, "startup.streamUnavailable", {
          reason: streamProbe.reason ?? tServer(locale, "diag.unknownReason"),
        }),
      )
    } else if (streamProbe.backend === "ffmpeg") {
      console.warn(tServer(locale, "startup.streamFfmpeg"))
    }

    // Dependency probe: surface missing CLIs / unavailable stream backend at startup
    // instead of first tool failure. Works on every platform (no-ops are cheap).
    try {
      for (const warning of startupWarnings(
        await collectDiagnostics(undefined, { backend: options.streamBackend, locale }),
        locale,
      )) {
        console.warn(warning)
      }
    } catch {
      // Diagnostics must never block plugin startup.
    }

    if (isMac) {
      routines.start()
    }

    // 1. Cross-network RPC registration (usable by @opencode/client, TUI, Desktop, or external scripts)
    const rpcReg = await ctx.rpc.register(BotRpc, {
      status: async (_input, callCtx) => {
        const summary = await collectBotStatus({
          awake,
          browser,
          options,
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
          streamAvailable: Boolean(stream),
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
        if (!screen.inputAllowed()) return { ok: false, detail: SCREEN_BUSY_DETAIL }
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
        const res = await runAgentDesktop(args, { timeoutMs: 8_000, signal: callCtx.signal })
        return { ok: res.ok }
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
      viewerHeartbeat: async (rawInput) => {
        viewers.beat(rawInput as ViewerBeat)
        return { ok: true }
      },
      resolveTakeover: async (rawInput) => {
        const input = rawInput as { sessionID?: string; note?: string }
        const resolved = takeovers.resolveBySession(input.sessionID, input.note, { source: "ui" })
        return { resolved: resolved.length }
      },
      screenState: async () => screen.state(),
      forceTakeover: async (rawInput) => forceTakeover((rawInput as { sessionID?: string } | undefined)?.sessionID),
      listSecretRequests: async () => {
        return { items: secrets.list() }
      },
      secretSubmit: async (rawInput) => {
        const input = rawInput as { id: string; value: string }
        return { ok: await secrets.submit(input.id, input.value) }
      },
      secretCancel: async (rawInput) => {
        return { ok: secrets.cancel({ id: (rawInput as { id: string }).id }) > 0 }
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

    const chatResumedTakeovers = new Map<string, { id: string; reason: string }>()

    const unsubReq = takeovers.onRequested((item) => {
      chatResumedTakeovers.delete(item.sessionID)
      const url = consoleLink(options, item.sessionID)
      void rpcReg.events.emit("takeoverRequested", {
        id: item.id,
        sessionID: item.sessionID,
        reason: item.reason,
        ...(url ? { consoleUrl: url } : {}),
      })
    })
    const unsubRes = takeovers.onResolved((item, note, source) => {
      void rpcReg.events.emit("takeoverResolved", {
        id: item.id,
        sessionID: item.sessionID,
        ...(note ? { note } : {}),
      })
      if ((source === "ui" || source === "command") && shared.once(`resume:${item.id}`)) {
        void ctx.session
          .synthetic({
            sessionID: item.sessionID as any,
            description: tServer(locale, "takeover.resumedDescription"),
            text: `Human completed takeover (${item.id}: "${item.reason}")${note ? ` — ${note}` : ""}. Take a fresh snapshot or screenshot to verify the updated UI state before continuing.`,
            delivery: "queue",
            resume: true,
          })
          .catch((err) => {
            console.error("[bot] Failed to schedule session resume after takeover:", err)
          })
      }
    })

    const unsubSecretReq = secrets.onRequested((item) => {
      void rpcReg.events.emit("secretRequested", {
        id: item.id,
        sessionID: item.sessionID,
        name: item.name,
        reason: item.reason,
      })
      const url = consoleLink(options, item.sessionID)
      if (url && viewers.needsLink(item.sessionID) && shared.once(`secret-link:${item.id}`)) {
        void ctx.session
          .synthetic({
            sessionID: item.sessionID as any,
            description: tServer(locale, "secret.linkDescription"),
            text: tServer(locale, "secret.linkText", { reason: item.reason, url }),
            resume: false,
          })
          .catch(() => {})
      }
    })
    const unsubSecretRes = secrets.onResolved((item, outcome) => {
      void rpcReg.events.emit("secretResolved", { id: item.id, sessionID: item.sessionID, outcome })
    })

    // 2. Permission guardrail hook: escalate high-risk GUI/Browser mutations to interactive Web approval
    const permHookReg = await ctx.permission.hook("evaluate", (event) => {
      if (!event.action.startsWith("bot.")) {
        if (event.effect === "allow" && readsKeychain([...event.resources, JSON.stringify(event.metadata ?? {})])) {
          event.effect = "ask"
          event.message = tServer(locale, "permission.keychainRead")
        }
        return
      }
      // Secret names like "github.password" would otherwise trip the keyword check depending only on their name.
      if (event.action === "bot.secret.type") return
      const matchedKeyword = containsHighRiskIntent([
        ...event.resources,
        JSON.stringify(event.metadata ?? {}),
      ])
      if (matchedKeyword && event.effect === "allow") {
        event.effect = "ask"
        event.message = tServer(locale, "permission.highRisk", { keyword: matchedKeyword })
      }
    })

    // 3. Prompt admission hook: if a session is waiting for Human Takeover and the user replies in chat,
    //    clear the takeover banner and attach a one-shot context hint so the model checks whether the user finished or asked a question.
    const promptHookReg = await ctx.session.hook("prompt", (event) => {
      secrets.cancel({ sessionID: event.sessionID }, "The user replied in chat instead of entering the secret")
      const pending = takeovers.getBySession(event.sessionID)
      if (pending) {
        chatResumedTakeovers.set(event.sessionID, { id: pending.id, reason: pending.reason })
        takeovers.resolveBySession(event.sessionID, event.prompt.text, { source: "chat" })
      }
    })

    // 3b. Screen ownership: GUI tool calls mark the session as driving the screen; while a person holds it,
    //     any GUI tool call fails instead of fighting them for the mouse.
    const toolBeforeReg = await ctx.tool.hook("execute.before", (event) => {
      if (!isGuiToolCall(event.tool, event.input)) return
      const state = screen.state()
      if (state.owner === "human") {
        throw new Error(
          `Action blocked: human takeover (${state.takeoverId}: "${state.reason}") is in progress on the host screen. Stop calling tools and end your turn now; the session resumes when the user is done.`,
        )
      }
      screen.begin(event.sessionID, event.id, event.tool)
    })
    const toolAfterReg = await ctx.tool.hook("execute.after", (event) => {
      screen.end(event.sessionID, event.id)
    })
    const idleHookReg = await ctx.session.hook("experimental.idle", (event) => {
      screen.release(event.sessionID)
    })

    // 4. Context hook: inform the model about host Mac capabilities & Live Screen takeover workflow (WITHOUT secret tokens)
    const contextHookReg = await ctx.session.hook("context", (event) => {
      if (isMac) {
        const consoleState = options.consoleUrl ? "Web / mobile console link available via /bot-link." : ""
        event.system.push({
          type: "text",
          text: `[Bot macOS Host Active] Fallback host tools (\`computer_*\` inside \`execute\` as \`tools.computer.*\`) are available for remote takeover (\`computer_request_takeover\`), 24/7 routines (\`computer_routine\`), host screen/GUI fallback, and Keychain-backed secret entry (\`computer_secret_request\` then \`computer_secret_type\`; never ask for passwords in chat). Prefer dedicated browser/desktop tools or skills (\`browser\`, \`browse\`, \`agent-desktop\`, \`agent-browser\`) over \`computer_desktop\` / \`computer_browser\` whenever available. Calling \`computer_request_takeover\` automatically opens the built-in Live Screen panel with a resume button and yields the turn—explain what the user should do and paste the console link only when the tool result gives you one (the user has no Live Screen panel). [Controllers] ${viewers.describe(event.sessionID)} ${consoleState}`.trim(),
        } as any)
      }
      const resumed = chatResumedTakeovers.get(event.sessionID)
      if (resumed) {
        chatResumedTakeovers.delete(event.sessionID)
        event.system.push({
          type: "text",
          text: `[Bot Takeover Update] Pending takeover ${resumed.id} ("${resumed.reason}") ended because the user sent a chat message. Check the user's message: if they confirmed completion, take a fresh screenshot or snapshot to verify and continue; if they asked a question or have not finished yet, answer them and call \`computer_request_takeover\` again if they still need screen control.`,
        } as any)
      }
    })

    // 5. Embedded Operator Skill
    const skillReg = await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make("bot-macos-operator"),
        name: Skill.Name.make("Bot macOS Operator"),
        description:
          "Fallback operator guide for the remote macOS host (Web Console human takeover, 24/7 background routines, and fallback `computer_*` wrappers when primary `agent-desktop` / `agent-browser` / browser tools are not applicable).",
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
        takeovers,
        routines,
        syntheticSessionMessage: async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID: sessionID as any, text, resume: false })
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
        secrets,
        viewers,
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
      unsubSecretReq()
      unsubSecretRes()
      routines.dispose()
      shared.release()
      await Promise.allSettled([
        toolReg.dispose(),
        cmdReg.dispose(),
        skillReg.dispose(),
        contextHookReg.dispose(),
        promptHookReg.dispose(),
        toolBeforeReg.dispose(),
        toolAfterReg.dispose(),
        idleHookReg.dispose(),
        permHookReg.dispose(),
        rpcReg.dispose(),
      ])
    }
  },
})
