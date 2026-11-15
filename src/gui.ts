import { Plugin } from "@opencode/plugin/gui"
import { Command, MenuItem, Panel } from "@opencode/plugin/gui"
import type { MountedSession, PanelProps, PanelTab, ServerRef, ToastHandle, Ui } from "@opencode/plugin/gui"
import { createSignal, createMemo, onMount, onCleanup, createEffect, untrack } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import { BotRpc } from "./rpc.ts"
import type { RemoteInputKind } from "./input-types.ts"
import { LiveStreamView, channelOf } from "./stream/view.ts"
import { createIdleWatcher, type IdleWatcher, type SleepReason } from "./stream/idle.ts"
import { createGuiTranslator, guiCatalog, type GuiMessageKey, type GuiTranslate } from "./i18n/gui.ts"
import { T, agentCard, details, explainScreenError, floating, iconButton, isFullscreenKey, rootStyle, secretPrompt, sleepOverlay, statusCard, takeoverCard, windowFill, type Tone } from "./ui.ts"

const DEFAULT_T = createGuiTranslator("en")

const CLIENT_ID = crypto.randomUUID()
const isNarrow = () => window.matchMedia("(max-width: 767px)").matches

type ErrorState = { key?: GuiMessageKey; detail?: string } | null

interface LiveFrameState {
  jpegBase64: string
  imageWidth: number
  imageHeight: number
  logicalX: number
  logicalY: number
  logicalWidth: number
  logicalHeight: number
  timestamp: number
}

interface WindowItem {
  id: string
  appName: string
  title: string
  isFocused: boolean
  visible: boolean
}

const KEY_NAMES: Record<string, string> = {
  Enter: "return",
  Escape: "escape",
  Tab: "tab",
  " ": "space",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Home: "home",
  End: "end",
}

export function LiveScreenView(props: {
  session: any
  ui: Ui
  t?: GuiTranslate
  reason?: string
  takeoverReason?: () => string
  onResolveTakeover?: () => void
  onRetryStream?: () => void
}): JSX.Element {
  const ui = props.ui
  const t = props.t ?? DEFAULT_T
  const curSession = () => (typeof props.session === "function" ? props.session() : props.session)
  const [frame, setFrame] = createSignal<LiveFrameState | null>(null)
  const [streaming, setStreaming] = createSignal(true)
  // Measured frames per second; screenshot polling runs as fast as each round trip allows.
  const [fps, setFps] = createSignal(0)
  const [rtt, setRtt] = createSignal(0)
  const [error, setError] = createSignal<ErrorState>(null)
  const [selectedWindowId, setSelectedWindowId] = createSignal("")
  const [windows, setWindows] = createSignal<WindowItem[]>([])
  const [typing, setTyping] = createSignal(false)
  const [typeText, setTypeText] = createSignal("")
  const [takeover, setTakeover] = createSignal<{ active: boolean; reason: string }>({ active: false, reason: "" })
  const [showLink, setShowLink] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [sleeping, setSleeping] = createSignal<SleepReason | null>(null)
  const [screen, setScreen] = createSignal<{ owner: string; tool?: string; sessionIDs: string[] }>({ owner: "idle", sessionIDs: [] })
  const agentBusy = () => screen().owner === "agent"

  let imageRef: HTMLImageElement | null = null
  let rootRef: HTMLDivElement | undefined
  let isRequestInProgress = false
  let lastFrameAt = 0
  let resumeStreamingOnWake = false
  let idleWatcher: IdleWatcher | undefined

  const getClientRpc = () => {
    try {
      const client = curSession()?.server?.client
      if (client && typeof client.rpc === "function") return client.rpc(BotRpc)
    } catch (e) {
      console.error("[bot-gui] Failed to get session server RPC client:", e)
    }
    return null
  }

  const refreshWindows = async () => {
    try {
      const res = await getClientRpc()?.listWindows({})
      if (res?.windows) setWindows(res.windows)
    } catch (e) {
      console.warn("[bot-gui] Failed to list windows:", e)
    }
  }

  const fetchNextFrame = async () => {
    if (isRequestInProgress || !streaming()) return
    const rpc = getClientRpc()
    if (!rpc) return setError({ key: "jpeg.serverDisconnected" })
    isRequestInProgress = true
    const startTime = Date.now()
    try {
      const res = await rpc.frame({ windowId: selectedWindowId() || undefined })
      if (res?.jpegBase64) {
        const now = Date.now()
        if (lastFrameAt) setFps(Math.round(10_000 / (now - lastFrameAt)) / 10)
        lastFrameAt = now
        setFrame(res as LiveFrameState)
        setRtt(now - startTime)
        setError(null)
      }
    } catch (err: any) {
      setError(err?.message ? { detail: err.message } : { key: "jpeg.captureFailed" })
    } finally {
      isRequestInProgress = false
    }
  }

  const activeTakeoverReason = () =>
    props.takeoverReason
      ? props.takeoverReason()
      : takeover().active
        ? takeover().reason || t("takeover.defaultReason")
        : ""

  const checkTakeovers = async () => {
    try {
      const s = curSession()
      const list = await getClientRpc()?.listTakeovers({})
      const mine = list?.items.find((i: any) => !s?.id || i.sessionID === s.id)
      setTakeover(mine ? { active: true, reason: mine.reason || "" } : { active: false, reason: "" })
    } catch {}
  }

  const checkScreen = async () => {
    try {
      const state = await getClientRpc()?.screenState({})
      if (state) setScreen(state)
    } catch {}
  }

  const forceTakeover = async () => {
    try {
      await getClientRpc()?.forceTakeover({ sessionID: screen().sessionIDs[0] ?? curSession()?.id })
    } catch {}
    await Promise.all([checkScreen(), props.takeoverReason ? undefined : checkTakeovers()])
  }

  const resumeAI = async () => {
    try {
      await getClientRpc()?.resolveTakeover({ sessionID: curSession()?.id, note: "User completed action in Live Screen" })
      setTakeover({ active: false, reason: "" })
      props.onResolveTakeover?.()
    } catch (e: any) {
      setError({ key: "jpeg.resumeFailed", detail: e?.message ?? String(e) })
    }
  }

  const getLogicalCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const f = frame()
    if (!imageRef || !f) return null
    const rect = imageRef.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null
    return { x: f.logicalX + relX * f.logicalWidth, y: f.logicalY + relY * f.logicalHeight }
  }

  const sendRemoteInput = async (input: { kind: RemoteInputKind; x?: number; y?: number; deltaY?: number; text?: string; key?: string }) => {
    const rpc = getClientRpc()
    if (!rpc || agentBusy()) return
    try {
      const selectedWin = windows().find((w) => w.id === selectedWindowId())
      await rpc.sendInput({ ...input, app: selectedWin?.appName || undefined })
      setTimeout(fetchNextFrame, 150)
    } catch (e: any) {
      setError({ key: "jpeg.inputFailed", detail: e?.message ?? String(e) })
    }
  }

  const pointer = (kind: RemoteInputKind) => (e: MouseEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (coords) void sendRemoteInput({ kind, ...coords })
  }

  let wheelAccum = 0
  let wheelTimer: ReturnType<typeof setTimeout> | undefined
  let wheelCoords: { x: number; y: number } | undefined

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (coords) wheelCoords = coords
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    wheelAccum += -e.deltaY * scale
    if (!wheelTimer) {
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined
        const dy = Math.max(-20, Math.min(20, Math.round(wheelAccum / 24)))
        wheelAccum = 0
        if (dy !== 0) {
          void sendRemoteInput({ kind: "scroll", x: wheelCoords?.x, y: wheelCoords?.y, deltaY: dy })
        }
      }, 80)
    }
  }

  // Physical keyboard while the picture has focus: plain characters are typed, everything else is sent as a key combo.
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || isFullscreenKey(e) || ["Meta", "Control", "Alt", "Shift"].includes(e.key)) return
    e.preventDefault()
    const shortcut = e.metaKey || e.ctrlKey || e.altKey
    if (e.key.length === 1 && !shortcut) {
      void sendRemoteInput({ kind: "type", text: e.key })
      return
    }
    const name = KEY_NAMES[e.key] ?? e.key.toLowerCase()
    const combo = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", name].filter(Boolean).join("+")
    void sendRemoteInput({ kind: "key", key: combo })
  }

  // For IME and long text, which the per-key path cannot carry.
  const submitText = (value: string) => {
    const txt = value.trim()
    if (!txt) return
    void sendRemoteInput({ kind: "type", text: txt })
    setTypeText("")
  }

  const handleWindowSelect = async (winId: string) => {
    setSelectedWindowId(winId)
    if (!winId) return
    try {
      await getClientRpc()?.focusWindow({ windowId: winId })
      setTimeout(fetchNextFrame, 200)
    } catch {}
  }

  createEffect(() => {
    curSession()?.id
    if (!props.takeoverReason) void checkTakeovers()
  })

  onMount(() => {
    let alive = true
    idleWatcher = createIdleWatcher({
      isBusy: () => agentBusy() || Boolean(activeTakeoverReason()),
      onSleep: (reason) => {
        resumeStreamingOnWake = streaming()
        setSleeping(reason)
        setStreaming(false)
      },
      onWake: () => {
        setSleeping(null)
        if (resumeStreamingOnWake) setStreaming(true)
      },
    })
    void getClientRpc()?.status({}).then((s: any) => {
      if (alive && typeof s?.streamIdleTimeoutMs === "number" && typeof s?.streamHiddenTimeoutMs === "number") {
        idleWatcher?.setTimeouts(s.streamIdleTimeoutMs, s.streamHiddenTimeoutMs)
      }
    }).catch(() => {})
    void refreshWindows()
    void fetchNextFrame()
    void checkScreen()
    const screenTimer = setInterval(checkScreen, 1500)
    onCleanup(() => {
      alive = false
      clearInterval(screenTimer)
      idleWatcher?.dispose()
      idleWatcher = undefined
    })
    if (!props.takeoverReason) {
      void checkTakeovers()
      const takeoverTimer = setInterval(checkTakeovers, 3000)
      onCleanup(() => {
        clearInterval(takeoverTimer)
      })
    }
    onCleanup(() => {
      clearTimeout(wheelTimer)
    })
  })

  createEffect(() => {
    if (!streaming()) return
    // Each frame is a full screenshot round trip over RPC, so poll back-to-back with a single frame yield.
    // When in an error state, back off to 2s so we don't flood the remote server with failing RPC calls.
    let stop = false
    lastFrameAt = 0
    const loop = async () => {
      while (!stop) {
        await fetchNextFrame()
        await new Promise((r) => setTimeout(r, error() ? 2000 : 16))
      }
    }
    void loop()
    onCleanup(() => { stop = true })
  })

  const server = () => curSession()?.server
  const fill = windowFill(() => rootRef)
  const secret = secretPrompt(ui, { rpc: getClientRpc, sessionID: () => curSession()?.id, t })
  const errorText = () => {
    const err = error()
    if (!err) return ""
    return err.key ? t(err.key, { error: err.detail ?? "" }) : err.detail ?? ""
  }
  const errInfo = () => explainScreenError(errorText(), t)
  const fallbackInfo = () => explainScreenError(props.reason || "", t)
  const tone = (): Tone => (sleeping() ? "muted" : error() ? "danger" : !frame() ? "muted" : "warning")
  const summary = () =>
    sleeping()
      ? t("stream.sleepingSummary")
      : errorText()
        ? errInfo().serviceUnavailable
          ? t("jpeg.serviceUnavailableSummary", { error: errInfo().summary })
          : t("jpeg.summaryError", { error: errInfo().summary })
        : !frame()
          ? t("jpeg.summaryConnecting")
          : !streaming()
            ? t("jpeg.summaryPaused")
            : t("jpeg.summaryLive", { fps: fps(), rtt: rtt() })

  const windowOptions = () => [
    { value: "", label: t("jpeg.entireScreen") },
    ...windows().map((w) => ({ value: w.id, label: `${w.appName}: ${w.title.slice(0, 24)}` })),
  ]

  const element = h("div", { ref: (el: HTMLDivElement) => { rootRef = el }, style: rootStyle() }, [
    h("div", {
      tabIndex: 0,
      "data-bot-screen": "",
      onMouseDown: (e: MouseEvent) => (e.currentTarget as HTMLElement).focus(),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onKeyDown: handleKeyDown,
      onContextMenu: pointer("right_click"),
      onWheel: handleWheel,
      style: () => ({
        position: "absolute", inset: "0", display: "flex", "align-items": "center", "justify-content": "center",
        cursor: agentBusy() ? "not-allowed" : "crosshair", "user-select": "none", outline: agentBusy() || focused() ? `2px solid ${T.focus}` : "none", "outline-offset": "-2px",
      }),
    }, () => frame()?.jpegBase64
      ? h("img", {
          ref: (el: HTMLImageElement) => { imageRef = el },
          src: () => `data:image/jpeg;base64,${frame()!.jpegBase64}`,
          onClick: pointer("click"),
          onDblClick: pointer("double_click"),
          draggable: false,
          style: { "max-width": "100%", "max-height": "100%", "object-fit": "contain", display: "block" },
        })
      : errorText()
        ? h("div", {
            onMouseDown: (e: MouseEvent) => e.stopPropagation(),
            style: {
              display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: T.sp(2),
              "max-width": "440px", margin: T.sp(4), padding: `${T.sp(3)} ${T.sp(4)}`,
              background: T.bgLayer, "box-shadow": T.elevation, "border-radius": T.radius,
              cursor: "default", "user-select": "text",
            },
          }, [
            h("div", { style: { display: "flex", "align-items": "center", gap: T.sp(2), color: T.danger, "font-weight": "600" } }, [
              h("span", { style: { width: "8px", height: "8px", "border-radius": "50%", background: T.danger, flex: "none" } }),
              h("span", {}, () => errInfo().summary || t("jpeg.cardTitle")),
            ]),
            () => errInfo().hint
              ? h("div", { style: { color: T.muted, "line-height": "1.5" } }, () => errInfo().hint)
              : null,
            () => errInfo().raw && errInfo().raw !== errInfo().summary
              ? h("div", { style: { color: T.faint, "font-family": T.code, "word-break": "break-all" } }, () => t("jpeg.cardRawLabel", { raw: errInfo().raw }))
              : null,
            h("div", { style: { display: "flex", gap: T.sp(2), "padding-top": T.sp(1) } }, [
              h(ui.Button, {
                variant: "secondary",
                size: "small",
                onClick: (_e: MouseEvent) => {
                  setError(null)
                  props.onRetryStream?.()
                  void refreshWindows()
                  void fetchNextFrame()
                },
                children: (() => t("jpeg.cardRetry")) as any,
              }),
            ]),
          ])
        : h(ui.Loader, {})),
    sleepOverlay(ui, {
      reason: sleeping,
      onWake: () => {
        resumeStreamingOnWake = true
        idleWatcher?.wake()
      },
      t,
    }),
    statusCard({
      title: () => t("status.detailsTitle"),
      tone,
      summary,
      open: showLink,
      toggle: () => setShowLink(!showLink()),
      body: () => details([
        { title: () => t("status.group.channel"), rows: [
          { label: () => t("status.row.server"), value: () => `${server()?.name ?? "—"} · ${server()?.url ?? ""}` },
          {
            label: () => t("status.row.signaling"),
            value: () =>
              `${channelOf(server(), t)} · ${server()?.connected ? t("status.connected") : t("status.disconnected")}${
                server()?.compatible === false ? t("status.incompatible") : ""
              }`,
          },
        ] },
        { title: () => t("status.group.video"), rows: [
          {
            label: () => t("status.row.mode"),
            value: () => (errInfo().serviceUnavailable ? t("jpeg.modeServiceUnavailable") : t("jpeg.modeValue", { fps: fps() })),
          },
          {
            label: () => t("status.row.reason"),
            value: () =>
              errorText()
                ? errInfo().raw && errInfo().raw !== errInfo().summary
                  ? `${errInfo().summary} (${errInfo().raw})`
                  : errInfo().summary
                : props.reason
                  ? fallbackInfo().serviceUnavailable
                    ? fallbackInfo().summary
                    : t("jpeg.webrtcUnavailableReason", { reason: fallbackInfo().summary })
                  : "—",
          },
          { label: () => t("status.row.rtt"), value: () => `${rtt()} ms` },
          { label: () => t("status.row.resolution"), value: () => (frame() ? `${frame()!.imageWidth}×${frame()!.imageHeight}` : "—") },
        ] },
        { title: () => t("status.group.input"), rows: [{ label: () => t("status.row.pointerKeyboard"), value: () => t("jpeg.inputValue") }] },
      ]),
    }),
    () => (secret.pending() ? secret.card() : activeTakeoverReason() ? takeoverCard(ui, activeTakeoverReason, () => void resumeAI(), {
      text: () => t("takeover.cardPrefix", { reason: activeTakeoverReason() }),
      resume: () => t("takeover.cardResume"),
    }) : agentBusy() ? agentCard(
      ui,
      () => (screen().tool ? t("screen.agentOperatingTool", { tool: screen().tool! }) : t("screen.agentOperating")),
      () => void forceTakeover(),
      () => t("screen.forceTakeover"),
    ) : null),
    h("div", { style: floating("bottom-right", { display: "flex", "flex-direction": "column", "align-items": "flex-end", gap: T.sp(1), padding: T.sp(1) }) }, [
      () => typing() ? h("div", { style: { width: "280px", "max-width": "100%" } }, h(ui.TextInput, {
        label: (() => t("jpeg.textLabel")) as any,
        placeholder: (() => t("jpeg.textPlaceholder")) as any,
        value: typeText,
        onInput: (value: string) => setTypeText(value),
        onSubmit: (value: string) => submitText(value),
        autofocus: true,
      })) : null,
      h("div", { style: { display: "flex", "align-items": "center", gap: T.sp(0.5) } }, [
        h(ui.Select, {
          label: (() => t("jpeg.screenScope")) as any,
          options: windowOptions,
          value: selectedWindowId,
          onChange: (value: string) => void handleWindowSelect(value),
          placement: "top-end",
        }),
        iconButton(ui, { icon: "monitor", label: () => t("jpeg.btn.retryWebrtc"), onClick: (_e) => props.onRetryStream?.() }),
        iconButton(ui, { icon: "outline-rotate-clockwise", label: () => t("jpeg.btn.refreshWindows"), onClick: (_e) => void refreshWindows() }),
        iconButton(ui, { icon: "outline-eye", label: () => t("jpeg.btn.toggleStream"), onClick: (_e) => setStreaming(!streaming()), pressed: streaming }),
        iconButton(ui, { icon: "keyboard", label: () => t("jpeg.btn.toggleType"), onClick: (_e) => setTyping(!typing()), pressed: typing }),
        iconButton(ui, { icon: "expand", label: () => t("webrtc.btn.fullscreen"), onClick: (_e) => fill.toggle(), pressed: fill.on }),
      ]),
    ]),
  ])

  return typeof element === "function" ? (element as any)() : (element as any)
}

export default Plugin.define({
  i18n: guiCatalog,
  setup(ctx) {
    const PANEL_ID = "screen"
    const TAB_KEY = `${ctx.id}:${PANEL_ID}`
    // Live Screen only makes sense when the app drives another machine (e.g. over OpenTunnel), not its own desktop.
    // On the web the "local" server is the one serving the page, which is the host itself, seen from another device.
    const remote = (session?: { server: ServerRef }) =>
      !!session && session.server.local === false

    // Reactive map of active takeovers across connected servers, keyed by `${serverId}\n${sessionID}` (SessionRef.key).
    const [takeoversBySession, setTakeoversBySession] = createSignal<Record<string, { id: string; reason: string }>>({})
    const activeToasts = new Map<string, ToastHandle>()
    const autoOpenedTakeovers = new Set<string>()
    const watchedServers = new Map<string, () => void>()
    const beaters = new Set<() => void>()

    const makeSessionKey = (serverId: string, sessionID: string) => `${serverId}\n${sessionID}`

    const dismissToast = (key: string) => {
      const prev = activeToasts.get(key)
      if (prev) {
        prev.dismiss()
        activeToasts.delete(key)
      }
    }

    const setTakeoverEntry = (server: ServerRef, item: { id: string; sessionID: string; reason: string }, notifyUser: boolean) => {
      const key = makeSessionKey(server.id, item.sessionID)
      const rawReason = item.reason || ""
      setTakeoversBySession((prev) => {
        if (prev[key]?.id === item.id && prev[key]?.reason === rawReason) return prev
        return { ...prev, [key]: { id: item.id, reason: rawReason } }
      })

      const targetSession = ctx.sessions.list().find((s) => s.server.id === server.id && s.id === item.sessionID)
      if (targetSession && remote(targetSession) && !autoOpenedTakeovers.has(item.id)) {
        autoOpenedTakeovers.add(item.id)
        ctx.layout.open(TAB_KEY, targetSession, { tab: "open" })
      }

      if (!notifyUser) return

      const displayReason = rawReason || ctx.t("takeover.defaultReason")

      void ctx.attention
        .notify({
          id: item.id,
          title: ctx.t("takeover.waitingTitle"),
          message: displayReason,
          variant: "default",
          session: { server: server.id, id: item.sessionID },
        })
        .catch(() => {})

      dismissToast(key)
      const toast = ctx.toast.show({
        title: ctx.t("takeover.waitingTitle"),
        description: displayReason,
        variant: "default",
        persistent: true,
        actions: [
          {
            label: ctx.t("takeover.toastOpen"),
            run() {
              const target = ctx.sessions.list().find((s) => s.server.id === server.id && s.id === item.sessionID)
              ctx.tabs.open({ server: server.id, id: item.sessionID }, { focus: true })
              if (target && remote(target)) ctx.layout.open(TAB_KEY, target, { tab: "open" })
            },
          },
        ],
      })
      activeToasts.set(key, toast)
    }

    const clearTakeoverEntry = (serverId: string, sessionID: string) => {
      const key = makeSessionKey(serverId, sessionID)
      dismissToast(key)
      setTakeoversBySession((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }

    const attachServer = (server: ServerRef) => {
      if (watchedServers.has(server.id)) return
      let rpc: ReturnType<typeof server.client.rpc<typeof BotRpc>>
      try {
        rpc = server.client.rpc(BotRpc)
      } catch {
        return
      }

      let disposed = false
      const syncInitial = async () => {
        try {
          const res = (await rpc.listTakeovers({})) as { items?: Array<{ id: string; sessionID: string; reason: string }> }
          if (disposed) return
          for (const item of res.items ?? []) {
            setTakeoverEntry(server, { id: item.id, sessionID: item.sessionID, reason: item.reason }, false)
          }
        } catch {
          // Server may not have the bot plugin enabled; ignore silently.
        }
      }
      void syncInitial()

      // Tell the host which of its sessions this controller shows and whether Live Screen can open there, so it knows when to post a link.
      const beat = () => {
        const cur = ctx.sessions.current()
        const mine = cur?.server.id === server.id ? cur : undefined
        void rpc
          .viewerHeartbeat({
            clientId: CLIENT_ID,
            platform: ctx.app.platform,
            mobile: isNarrow(),
            ...(mine ? { sessionID: mine.id } : {}),
            panel: remote(mine),
          })
          .catch(() => {})
      }
      beat()
      const beatTimer = setInterval(beat, 15_000)
      beaters.add(beat)

      const unsubReq = rpc.events.on("takeoverRequested", (ev) => {
        if (disposed) return
        const data = ev.data as { id: string; sessionID: string; reason: string }
        setTakeoverEntry(server, data, true)
      })
      const unsubRes = rpc.events.on("takeoverResolved", (ev) => {
        if (disposed) return
        const data = ev.data as { id: string; sessionID: string }
        clearTakeoverEntry(server.id, data.sessionID)
      })

      // The card itself is polled by the open view; the event only brings Live Screen up and notifies the user.
      const unsubSecret = rpc.events.on("secretRequested", (ev) => {
        if (disposed) return
        const data = ev.data as { id: string; sessionID: string; reason: string }
        const targetSession = ctx.sessions.list().find((s) => s.server.id === server.id && s.id === data.sessionID)
        if (targetSession && remote(targetSession)) ctx.layout.open(TAB_KEY, targetSession, { tab: "open" })
        void ctx.attention
          .notify({
            id: data.id,
            title: ctx.t("secret.title"),
            message: data.reason,
            variant: "default",
            session: { server: server.id, id: data.sessionID },
          })
          .catch(() => {})
      })

      watchedServers.set(server.id, () => {
        disposed = true
        clearInterval(beatTimer)
        beaters.delete(beat)
        unsubReq()
        unsubRes()
        unsubSecret()
      })
    }

    const detachServer = (serverId: string) => {
      const stop = watchedServers.get(serverId)
      if (stop) {
        stop()
        watchedServers.delete(serverId)
      }
      const prefix = `${serverId}\n`
      for (const key of [...activeToasts.keys()]) {
        if (key.startsWith(prefix)) dismissToast(key)
      }
      setTakeoversBySession((prev) => {
        const keys = Object.keys(prev).filter((k) => k.startsWith(prefix))
        if (keys.length === 0) return prev
        const next = { ...prev }
        for (const k of keys) delete next[k]
        return next
      })
    }

    createEffect(() => {
      const ids = ctx.servers.list()
      const activeIds = new Set<string>()
      for (const id of ids) {
        const srv = ctx.servers.get(id)
        if (srv && srv.connected && srv.compatible !== false) {
          activeIds.add(id)
          attachServer(srv)
        }
      }
      for (const existingId of [...watchedServers.keys()]) {
        if (!activeIds.has(existingId)) detachServer(existingId)
      }
    })

    // Switching sessions changes what this controller is watching; report it right away instead of on the next tick.
    createEffect(() => {
      ctx.sessions.current()
      untrack(() => {
        for (const b of beaters) b()
      })
    })

    // If a session with a pending takeover is opened or focused after the event arrived, open Live Screen once for it.
    createEffect(() => {
      const cur = ctx.sessions.current()
      if (!cur || !remote(cur)) return
      const entry = takeoversBySession()[cur.key]
      if (entry && !autoOpenedTakeovers.has(entry.id)) {
        autoOpenedTakeovers.add(entry.id)
        ctx.layout.open(TAB_KEY, cur, { tab: "open" })
      }
    })

    onCleanup(() => {
      for (const id of [...watchedServers.keys()]) detachServer(id)
    })

    // 1. Add Side Panel
    ctx.add(Panel, {
      id: PANEL_ID,
      region: "side",
      wide: true,
      width: 580,
      mobile: {
        get title() {
          return ctx.t("panel.title")
        },
        kind: "tab",
        icon: "monitor",
        order: 10,
        cached: true,
      },
      list(input): readonly PanelTab[] {
        if (!remote(input.session) || !input.open.includes(PANEL_ID)) {
          return []
        }
        return [
          {
            id: PANEL_ID,
            get title() {
              return ctx.t("panel.title")
            },
            closable: "hover",
            tabbable: true,
          },
        ]
      },
      render(props: PanelProps): JSX.Element {
        // Prefer the WebRTC stream; fall back to JPEG polling over RPC when no direct route exists.
        const [fallback, setFallback] = createSignal("")
        const serverId = createMemo(() => props.session?.server.id)
        const sessionGetter = () => props.session
        const takeoverReason = () => {
          const s = props.session
          const entry = s ? takeoversBySession()[s.key] : undefined
          return entry ? entry.reason || ctx.t("takeover.defaultReason") : ""
        }
        const onResolveTakeover = () => {
          const s = props.session
          if (s) clearTakeoverEntry(s.server.id, s.id)
        }
        return h("div", { style: { height: "100%", width: "100%" } }, () => {
          // Re-create connection only when switching to a different remote server; same-server session switches keep the live stream open.
          serverId()
          return fallback()
            ? LiveScreenView({
                session: sessionGetter,
                ui: ctx.ui,
                t: ctx.t,
                reason: fallback(),
                takeoverReason,
                onResolveTakeover,
                onRetryStream: () => setFallback(""),
              })
            : LiveStreamView({
                session: sessionGetter,
                ui: ctx.ui,
                t: ctx.t,
                takeoverReason,
                onResolveTakeover,
                onUnavailable: (reason) => {
                  console.warn("[bot-gui] WebRTC unavailable, falling back to JPEG:", reason)
                  setFallback(reason)
                },
              })
        }) as unknown as JSX.Element
      },
    })

    // 2. Add Launcher into Side Panel '+' Menu
    ctx.add(MenuItem, () => remote(ctx.sessions.current()) ? {
      menu: "session.panel" as const,
      id: "screen",
      title: ctx.t("panel.title"),
      icon: "monitor" as const,
      keybind: `${ctx.id}.toggle`,
      description: ctx.t("menu.description"),
      run() {
        const curSession = ctx.sessions.current()
        if (curSession) {
          ctx.layout.open(TAB_KEY, curSession)
        }
      },
    } : undefined)

    // 3. Add Command for Palette, Keybind & Slash Command
    ctx.add(Command, () => remote(ctx.sessions.current()) ? {
      id: "toggle",
      title: ctx.t("command.toggle.title"),
      section: "session" as const,
      bind: "mod+shift+s",
      slash: {
        name: "screen",
      },
      run() {
        const curSession = ctx.sessions.current()
        if (curSession) {
          ctx.layout.toggle(TAB_KEY, curSession)
        }
      },
    } : undefined)
  },
})
