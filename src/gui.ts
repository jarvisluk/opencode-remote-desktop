import { Plugin } from "@opencode/plugin/gui"
import { Command, MenuItem, Panel } from "@opencode/plugin/gui"
import type { PanelProps, PanelTab } from "@opencode/plugin/gui"
import { createSignal, onMount, onCleanup, createEffect } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import { DotBotRpc } from "./rpc.ts"
import type { RemoteInputKind } from "./input-types.ts"

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

export function LiveScreenView(props: { session: any }): JSX.Element {
  const [frame, setFrame] = createSignal<LiveFrameState | null>(null)
  const [streaming, setStreaming] = createSignal<boolean>(true)
  const [fps, setFps] = createSignal<number>(2) // default 2 fps for smooth low-overhead live preview
  const [selectedWindowId, setSelectedWindowId] = createSignal<string>("")
  const [windows, setWindows] = createSignal<WindowItem[]>([])
  const [typeText, setTypeText] = createSignal<string>("")
  const [statusText, setStatusText] = createSignal<string>("Connecting to remote screen...")
  const [takeoverActive, setTakeoverActive] = createSignal<boolean>(false)
  const [takeoverReason, setTakeoverReason] = createSignal<string>("")

  let imageRef: HTMLImageElement | null = null
  let isRequestInProgress = false

  const getClientRpc = () => {
    try {
      const client = props.session?.server?.client
      if (client && typeof client.rpc === "function") {
        return client.rpc(DotBotRpc)
      }
    } catch (e) {
      console.error("[dotbot-gui] Failed to get session server RPC client:", e)
    }
    return null
  }

  const refreshWindows = async () => {
    const rpc = getClientRpc()
    if (!rpc) return
    try {
      const res = await rpc.listWindows({})
      if (res?.windows) {
        setWindows(res.windows)
      }
    } catch (e) {
      console.warn("[dotbot-gui] Failed to list windows:", e)
    }
  }

  const fetchNextFrame = async () => {
    if (isRequestInProgress || !streaming()) return
    const rpc = getClientRpc()
    if (!rpc) {
      setStatusText("Remote server disconnected")
      return
    }

    isRequestInProgress = true
    const startTime = Date.now()
    try {
      const winId = selectedWindowId() || undefined
      const res = await rpc.frame({
        windowId: winId,
      })
      const rtt = Date.now() - startTime
      if (res && res.jpegBase64) {
        setFrame(res as LiveFrameState)
        setStatusText(`Live · ${rtt}ms RTT`)
      }
    } catch (err: any) {
      setStatusText(`Frame error: ${err?.message || "unknown"}`)
    } finally {
      isRequestInProgress = false
    }
  }

  const checkTakeovers = async () => {
    const rpc = getClientRpc()
    if (!rpc) return
    try {
      const list = await rpc.listTakeovers({})
      const currentSessionId = props.session?.id
      const myTakeovers = list.items.filter((item: any) => !currentSessionId || item.sessionID === currentSessionId)
      if (myTakeovers.length > 0) {
        setTakeoverActive(true)
        setTakeoverReason(myTakeovers[0].reason)
      } else {
        setTakeoverActive(false)
        setTakeoverReason("")
      }
    } catch (e) {
      // ignore
    }
  }

  const resumeAI = async () => {
    const rpc = getClientRpc()
    if (!rpc) return
    try {
      setStatusText("Resuming AI agent...")
      await rpc.resolveTakeover({
        sessionID: props.session?.id,
        note: "User manually completed action in Live Screen side-panel",
      })
      setTakeoverActive(false)
      setStatusText("AI agent resumed")
    } catch (e: any) {
      setStatusText(`Resume error: ${e?.message}`)
    }
  }

  // Pointer coordinate transformation
  const getLogicalCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!imageRef || !frame()) return null
    const rect = imageRef.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const f = frame()!
    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height

    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null

    const targetX = f.logicalX + relX * f.logicalWidth
    const targetY = f.logicalY + relY * f.logicalHeight
    return { x: targetX, y: targetY }
  }

  const sendRemoteInput = async (input: {
    kind: RemoteInputKind
    x?: number
    y?: number
    deltaY?: number
    text?: string
    key?: string
    app?: string
  }) => {
    const rpc = getClientRpc()
    if (!rpc) return
    try {
      const selectedWin = windows().find((w) => w.id === selectedWindowId())
      const res = await rpc.sendInput({
        ...input,
        app: selectedWin?.appName || undefined,
      })
      if (res && res.detail) {
        setStatusText(res.detail)
      }
      setTimeout(fetchNextFrame, 150)
    } catch (e: any) {
      setStatusText(`Input error: ${e?.message}`)
    }
  }

  const handleImageClick = (e: MouseEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (!coords) return
    void sendRemoteInput({
      kind: "click",
      x: coords.x,
      y: coords.y,
    })
  }

  const handleImageDblClick = (e: MouseEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (!coords) return
    void sendRemoteInput({
      kind: "double_click",
      x: coords.x,
      y: coords.y,
    })
  }

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    if (!coords) return
    void sendRemoteInput({
      kind: "right_click",
      x: coords.x,
      y: coords.y,
    })
  }

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const coords = getLogicalCoordinates(e.clientX, e.clientY)
    const dy = e.deltaY > 0 ? -4 : 4
    void sendRemoteInput({
      kind: "scroll",
      x: coords?.x,
      y: coords?.y,
      deltaY: dy,
    })
  }

  const handleKeySend = (keyCombo: string) => {
    void sendRemoteInput({
      kind: "key",
      key: keyCombo,
    })
  }

  const handleTextSubmit = (e: Event) => {
    e.preventDefault()
    const txt = typeText().trim()
    if (!txt) return
    void sendRemoteInput({
      kind: "type",
      text: txt,
    })
    setTypeText("")
  }

  const handleWindowSelect = async (winId: string) => {
    setSelectedWindowId(winId)
    const rpc = getClientRpc()
    if (rpc && winId) {
      try {
        await rpc.focusWindow({ windowId: winId })
        setTimeout(fetchNextFrame, 200)
      } catch (e) {
        // ignore
      }
    }
  }

  onMount(() => {
    void refreshWindows()
    void checkTakeovers()
    void fetchNextFrame()

    // Subscribe to takeover events if supported by client RPC
    const rpc = getClientRpc()
    let cleanupSubscription: (() => void) | undefined
    if (rpc?.events && typeof rpc.events.on === "function") {
      try {
        const unsubReq = rpc.events.on("takeoverRequested", (ev: any) => {
          const currentSessionId = props.session?.id
          if (!currentSessionId || ev.sessionID === currentSessionId) {
            setTakeoverActive(true)
            setTakeoverReason(ev.reason || "需要手动操作")
          }
        })
        const unsubRes = rpc.events.on("takeoverResolved", (ev: any) => {
          const currentSessionId = props.session?.id
          if (!currentSessionId || ev.sessionID === currentSessionId) {
            setTakeoverActive(false)
            setTakeoverReason("")
          }
        })
        cleanupSubscription = () => {
          unsubReq?.()
          unsubRes?.()
        }
      } catch {
        // Fallback handled by initial check
      }
    }

    onCleanup(() => {
      cleanupSubscription?.()
    })
  })

  // Single effect with cleanup for streaming loop
  createEffect(() => {
    const curFps = fps()
    const isStreaming = streaming()
    if (!isStreaming) return

    const interval = Math.max(150, Math.round(1000 / curFps))
    const timer = setInterval(() => {
      void fetchNextFrame()
    }, interval)

    onCleanup(() => {
      clearInterval(timer)
    })
  })

  const element = h("div", {
    style: {
      display: "flex",
      "flex-direction": "column",
      height: "100%",
      width: "100%",
      overflow: "hidden",
      background: "var(--opencode-bg, #0d1117)",
      color: "var(--opencode-fg, #e6edf3)",
      "font-family": "system-ui, -apple-system, sans-serif",
      "font-size": "12px",
    },
  }, [
    // Top Bar: Takeover Banner if active
    () => takeoverActive() ? h("div", {
      style: {
        background: "#b91c1c",
        color: "#ffffff",
        padding: "8px 12px",
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "8px",
        "font-weight": "600",
        "box-shadow": "0 2px 8px rgba(0,0,0,0.3)",
      },
    }, [
      h("span", { style: { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" } },
        () => `⚠️ 人类接管中: ${takeoverReason() || "需要手动操作"}`
      ),
      h("button", {
        onClick: resumeAI,
        style: {
          background: "#ffffff",
          color: "#b91c1c",
          border: "none",
          "border-radius": "4px",
          padding: "4px 10px",
          "font-size": "11px",
          "font-weight": "bold",
          cursor: "pointer",
        },
      }, "完成并恢复 AI"),
    ]) : null,

    // Header Toolbar
    h("div", {
      style: {
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        padding: "6px 10px",
        background: "rgba(255, 255, 255, 0.04)",
        "border-bottom": "1px solid rgba(255, 255, 255, 0.08)",
        gap: "6px",
        "flex-wrap": "wrap",
      },
    }, [
      // Left tools: Window select & refresh
      h("div", { style: { display: "flex", "align-items": "center", gap: "6px" } }, [
        h("select", {
          value: selectedWindowId,
          onChange: (e: any) => handleWindowSelect(e.target.value),
          style: {
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            color: "inherit",
            "border-radius": "4px",
            padding: "3px 6px",
            "font-size": "11px",
            "max-width": "160px",
          },
        }, [
          h("option", { value: "" }, "整个屏幕 (Display)"),
          () => windows().map((w) =>
            h("option", { value: w.id }, `${w.appName}: ${w.title.slice(0, 20)}`)
          ),
        ]),
        h("button", {
          onClick: refreshWindows,
          title: "刷新窗口列表",
          style: {
            background: "transparent",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "inherit",
            "border-radius": "4px",
            padding: "3px 6px",
            cursor: "pointer",
            "font-size": "11px",
          },
        }, "⟳ 窗口"),
      ]),

      // Middle status & FPS
      h("div", {
        style: {
          display: "flex",
          "align-items": "center",
          gap: "8px",
          color: "rgba(255, 255, 255, 0.6)",
          "font-size": "11px",
        },
      }, [
        h("span", {}, statusText),
        h("select", {
          value: fps,
          onChange: (e: any) => setFps(Number(e.target.value)),
          title: "帧率控制",
          style: {
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            color: "inherit",
            "border-radius": "4px",
            padding: "2px 4px",
            "font-size": "10px",
          },
        }, [
          h("option", { value: 1 }, "1 FPS (省流)"),
          h("option", { value: 2 }, "2 FPS (平衡)"),
          h("option", { value: 4 }, "4 FPS (流畅)"),
        ]),
      ]),

      // Right: Pause / Stream toggle & manual snap
      h("div", { style: { display: "flex", "align-items": "center", gap: "6px" } }, [
        h("button", {
          onClick: () => setStreaming(!streaming()),
          style: {
            background: () => streaming() ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
            border: () => streaming() ? "1px solid #22c55e" : "1px solid #ef4444",
            color: () => streaming() ? "#4ade80" : "#f87171",
            "border-radius": "4px",
            padding: "3px 8px",
            cursor: "pointer",
            "font-size": "11px",
          },
        }, () => streaming() ? "● 实时中" : "⏸ 已暂停"),
        h("button", {
          onClick: fetchNextFrame,
          title: "立即截取一帧",
          style: {
            background: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "inherit",
            "border-radius": "4px",
            padding: "3px 6px",
            cursor: "pointer",
            "font-size": "11px",
          },
        }, "刷新帧"),
      ]),
    ]),

    // Main Canvas / Image View
    h("div", {
      style: {
        flex: "1 1 0%",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        position: "relative",
        background: "#05070a",
        overflow: "hidden",
        padding: "4px",
        cursor: "crosshair",
        "user-select": "none",
      },
      onContextMenu: handleContextMenu,
      onWheel: handleWheel,
    }, [
      () => frame()?.jpegBase64 ? h("img", {
        ref: (el: HTMLImageElement) => { imageRef = el },
        src: () => `data:image/jpeg;base64,${frame()!.jpegBase64}`,
        onClick: handleImageClick,
        onDblClick: handleImageDblClick,
        style: {
          "max-width": "100%",
          "max-height": "100%",
          "object-fit": "contain",
          "box-shadow": "0 4px 20px rgba(0,0,0,0.5)",
          "border-radius": "4px",
          display: "block",
        },
      }) : h("div", {
        style: {
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "10px",
          color: "rgba(255, 255, 255, 0.4)",
        },
      }, [
        h("div", { style: { "font-size": "24px" } }, "🖥️"),
        h("div", {}, "等待远程桌面画面..."),
      ]),
    ]),

    // Bottom Action Bar: Key shortcuts & Quick text input
    h("div", {
      style: {
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        padding: "8px 10px",
        background: "rgba(255, 255, 255, 0.03)",
        "border-top": "1px solid rgba(255, 255, 255, 0.08)",
      },
    }, [
      // Quick Keys row
      h("div", {
        style: {
          display: "flex",
          "align-items": "center",
          gap: "4px",
          "flex-wrap": "wrap",
        },
      }, [
        h("span", { style: { color: "rgba(255, 255, 255, 0.5)", "font-size": "10px", "margin-right": "2px" } }, "快捷键:"),
        ...[
          { label: "Return", key: "return" },
          { label: "Esc", key: "escape" },
          { label: "Tab", key: "tab" },
          { label: "Space", key: "space" },
          { label: "Cmd+C", key: "cmd+c" },
          { label: "Cmd+V", key: "cmd+v" },
          { label: "Cmd+A", key: "cmd+a" },
          { label: "Cmd+W", key: "cmd+w" },
          { label: "↑", key: "up" },
          { label: "↓", key: "down" },
          { label: "←", key: "left" },
          { label: "→", key: "right" },
        ].map((k) =>
          h("button", {
            onClick: () => handleKeySend(k.key),
            style: {
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              color: "inherit",
              "border-radius": "3px",
              padding: "2px 6px",
              "font-size": "10px",
              cursor: "pointer",
            },
          }, k.label)
        ),
      ]),

      // Direct Text Typing Row
      h("form", {
        onSubmit: handleTextSubmit,
        style: {
          display: "flex",
          gap: "6px",
        },
      }, [
        h("input", {
          type: "text",
          placeholder: "输入文字并按发送 (注入当前焦点窗口)...",
          value: typeText,
          onInput: (e: any) => setTypeText(e.target.value),
          style: {
            flex: "1",
            background: "rgba(255, 255, 255, 0.06)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            "border-radius": "4px",
            padding: "4px 8px",
            color: "inherit",
            "font-size": "11px",
            outline: "none",
          },
        }),
        h("button", {
          type: "submit",
          style: {
            background: "#2563eb",
            border: "none",
            color: "#ffffff",
            "border-radius": "4px",
            padding: "4px 12px",
            "font-size": "11px",
            "font-weight": "500",
            cursor: "pointer",
          },
        }, "键入文本"),
      ]),
    ]),
  ])

  return typeof element === "function" ? (element as any)() : (element as any)
}

export default Plugin.define({
  setup(ctx) {
    const PANEL_ID = "screen"
    const TAB_KEY = `${ctx.id}:${PANEL_ID}`

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
        if (!input.open.includes(PANEL_ID)) {
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
        return LiveScreenView({
          session: props.session,
        })
      },
    })

    // 2. Add Launcher into Side Panel '+' Menu
    ctx.add(MenuItem, () => ({
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
    }))

    // 3. Add Command for Palette, Keybind & Slash Command
    ctx.add(Command, () => ({
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
    }))
  },
})
