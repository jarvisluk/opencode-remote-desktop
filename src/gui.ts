import { Plugin } from "@opencode/plugin/gui"
import { Command, MenuItem, Panel } from "@opencode/plugin/gui"
import type { MountedSession, PanelProps, PanelTab, Ui } from "@opencode/plugin/gui"
import { createSignal, onMount, onCleanup, createEffect } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import { BotRpc } from "./rpc.ts"
import type { RemoteInputKind } from "./input-types.ts"
import { LiveStreamView, channelOf } from "./stream/view.ts"
import { T, details, floating, iconButton, isFullscreenKey, rootStyle, statusCard, takeoverCard, windowFill, type Tone } from "./ui.ts"

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

export function LiveScreenView(props: { session: any; ui: Ui; reason?: string; onRetryStream?: () => void }): JSX.Element {
  const ui = props.ui
  const [frame, setFrame] = createSignal<LiveFrameState | null>(null)
  const [streaming, setStreaming] = createSignal(true)
  // Measured frames per second; screenshot polling runs as fast as each round trip allows.
  const [fps, setFps] = createSignal(0)
  const [rtt, setRtt] = createSignal(0)
  const [error, setError] = createSignal("")
  const [selectedWindowId, setSelectedWindowId] = createSignal("")
  const [windows, setWindows] = createSignal<WindowItem[]>([])
  const [typing, setTyping] = createSignal(false)
  const [typeText, setTypeText] = createSignal("")
  const [takeoverReason, setTakeoverReason] = createSignal("")
  const [showLink, setShowLink] = createSignal(false)
  const [focused, setFocused] = createSignal(false)

  let imageRef: HTMLImageElement | null = null
  let rootRef: HTMLDivElement | undefined
  let isRequestInProgress = false
  let lastFrameAt = 0

  const getClientRpc = () => {
    try {
      const client = props.session?.server?.client
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
    if (!rpc) return setError("服务器已断开")
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
        setError("")
      }
    } catch (err: any) {
      setError(err?.message || "截图失败")
    } finally {
      isRequestInProgress = false
    }
  }

  const checkTakeovers = async () => {
    try {
      const list = await getClientRpc()?.listTakeovers({})
      const mine = list?.items.find((i: any) => !props.session?.id || i.sessionID === props.session.id)
      setTakeoverReason(mine ? mine.reason || "需要手动操作" : "")
    } catch {}
  }

  const resumeAI = async () => {
    try {
      await getClientRpc()?.resolveTakeover({ sessionID: props.session?.id, note: "User completed action in Live Screen" })
      setTakeoverReason("")
    } catch (e: any) {
      setError(`恢复失败：${e?.message}`)
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
    if (!rpc) return
    try {
      const selectedWin = windows().find((w) => w.id === selectedWindowId())
      await rpc.sendInput({ ...input, app: selectedWin?.appName || undefined })
      setTimeout(fetchNextFrame, 150)
    } catch (e: any) {
      setError(`输入失败：${e?.message}`)
    }
  }

  const pointer = (kind: RemoteInputKind) => (e: MouseEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (coords) void sendRemoteInput({ kind, ...coords })
  }

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    void sendRemoteInput({ kind: "scroll", x: coords?.x, y: coords?.y, deltaY: e.deltaY > 0 ? -4 : 4 })
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

  onMount(() => {
    void refreshWindows()
    void checkTakeovers()
    void fetchNextFrame()
    const takeoverTimer = setInterval(checkTakeovers, 3000)
    onCleanup(() => {
      clearInterval(takeoverTimer)
    })
  })

  createEffect(() => {
    if (!streaming()) return
    // Each frame is a full screenshot round trip over RPC, so poll back-to-back instead of at a fixed rate.
    let stop = false
    lastFrameAt = 0
    const loop = async () => {
      while (!stop) {
        await fetchNextFrame()
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    void loop()
    onCleanup(() => { stop = true })
  })

  const server = () => props.session?.server
  const fill = windowFill(() => rootRef)
  const tone = (): Tone => (error() ? "danger" : !frame() ? "muted" : "warning")
  const summary = () => error() ? `截图 · ${error()}` : !frame() ? "截图连接中" : !streaming() ? "截图 · 已暂停" : `截图 · ${fps()} fps · ${rtt()} ms`

  const windowOptions = () => [
    { value: "", label: "整个屏幕" },
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
        cursor: "crosshair", "user-select": "none", outline: focused() ? `2px solid ${T.focus}` : "none", "outline-offset": "-2px",
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
      : h(ui.Loader, {})),
    statusCard({
      tone,
      summary,
      open: showLink,
      toggle: () => setShowLink(!showLink()),
      body: () => details([
        { title: "通道", rows: [
          { label: "服务器", value: () => `${server()?.name ?? "—"} · ${server()?.url ?? ""}` },
          { label: "信令", value: () => `${channelOf(server())} · ${server()?.connected ? "已连接" : "断开"}${server()?.compatible === false ? " · 版本不兼容" : ""}` },
        ] },
        { title: "画面", rows: [
          { label: "模式", value: () => `截图轮询 · ${fps()} fps` },
          { label: "原因", value: () => props.reason ? `WebRTC 不可用：${props.reason}` : "—" },
          { label: "往返", value: () => `${rtt()} ms` },
          { label: "分辨率", value: () => frame() ? `${frame()!.imageWidth}×${frame()!.imageHeight}` : "—" },
        ] },
        { title: "输入", rows: [{ label: "键鼠", value: () => "agent-desktop 逐条注入" }] },
      ]),
    }),
    () => takeoverReason() ? takeoverCard(ui, takeoverReason, () => void resumeAI()) : null,
    h("div", { style: floating("bottom-right", { display: "flex", "flex-direction": "column", "align-items": "flex-end", gap: T.sp(1), padding: T.sp(1) }) }, [
      () => typing() ? h("div", { style: { width: "280px", "max-width": "100%" } }, h(ui.TextInput, {
        label: "输入文字",
        placeholder: "输入文字后回车，发往当前焦点窗口",
        value: typeText,
        onInput: (value: string) => setTypeText(value),
        onSubmit: (value: string) => submitText(value),
        autofocus: true,
      })) : null,
      h("div", { style: { display: "flex", "align-items": "center", gap: T.sp(0.5) } }, [
        h(ui.Select, {
          label: "画面范围",
          options: windowOptions,
          value: selectedWindowId,
          onChange: (value: string) => void handleWindowSelect(value),
          placement: "top-end",
        }),
        iconButton(ui, { icon: "monitor", label: "重新连接 WebRTC", onClick: (_e) => props.onRetryStream?.() }),
        iconButton(ui, { icon: "outline-rotate-clockwise", label: "刷新窗口列表", onClick: (_e) => void refreshWindows() }),
        iconButton(ui, { icon: "outline-eye", label: "暂停 / 继续刷新", onClick: (_e) => setStreaming(!streaming()), pressed: streaming }),
        iconButton(ui, { icon: "keyboard", label: "输入文字（支持输入法）", onClick: (_e) => setTyping(!typing()), pressed: typing }),
        iconButton(ui, { icon: "expand", label: "铺满窗口（⌃⌘F 全屏）", onClick: (_e) => fill.toggle(), pressed: fill.on }),
      ]),
    ]),
  ])

  return typeof element === "function" ? (element as any)() : (element as any)
}

export default Plugin.define({
  setup(ctx) {
    const PANEL_ID = "screen"
    const TAB_KEY = `${ctx.id}:${PANEL_ID}`
    // Live Screen only makes sense when the app drives another machine (e.g. over OpenTunnel), not its own desktop.
    const remote = (session?: MountedSession) => session?.server.local === false

    // 1. Add Side Panel
    ctx.add(Panel, {
      id: PANEL_ID,
      region: "side",
      wide: true,
      width: 580,
      mobile: {
        title: "Live Screen",
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
            title: "Live Screen",
            closable: "hover",
            tabbable: true,
          },
        ]
      },
      render(props: PanelProps): JSX.Element {
        // Prefer the WebRTC stream; fall back to JPEG polling over RPC when no direct route exists.
        const [fallback, setFallback] = createSignal("")
        return h("div", { style: { height: "100%", width: "100%" } }, () =>
          fallback()
            ? LiveScreenView({ session: props.session, ui: ctx.ui, reason: fallback(), onRetryStream: () => setFallback("") })
            : LiveStreamView({
                session: props.session,
                ui: ctx.ui,
                onUnavailable: (reason) => {
                  console.warn("[bot-gui] WebRTC unavailable, falling back to JPEG:", reason)
                  setFallback(reason)
                },
              }),
        ) as unknown as JSX.Element
      },
    })

    // 2. Add Launcher into Side Panel '+' Menu
    ctx.add(MenuItem, () => remote(ctx.sessions.current()) ? {
      menu: "session.panel" as const,
      id: "screen",
      title: "Live Screen",
      icon: "monitor" as const,
      keybind: `${ctx.id}.toggle`,
      description: "Remote Desktop",
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
      title: "Live Screen: Toggle Remote Desktop Tab",
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
