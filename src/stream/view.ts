import { createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import { BotRpc } from "../rpc.ts"

/** Which network path the OpenCode server connection uses, judged from its URL. */
export function channelOf(server: { url?: string; local?: boolean } | undefined): string {
  if (!server) return "未连接"
  if (server.local) return "本机"
  let host = ""
  try {
    host = new URL(server.url ?? "").hostname
  } catch {
    return "未知"
  }
  if (host.endsWith(".opentunnel.xyz")) return "OpenTunnel"
  if (host.endsWith(".ts.net") || isTailscaleIp(host)) return "Tailscale"
  if (isPrivateIp(host) || host.endsWith(".local")) return "局域网"
  return "公网"
}

function octets(host: string): number[] | null {
  const parts = host.split(".").map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null
}

function isTailscaleIp(host: string): boolean {
  const o = octets(host)
  return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

function isPrivateIp(host: string): boolean {
  const o = octets(host)
  return !!o && (o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31))
}

export function toggleFullscreen(el: HTMLElement | undefined) {
  if (!el) return
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void el.requestFullscreen().catch(() => {})
}

const ROUTE: Record<string, string> = { host: "直连", srflx: "NAT 穿透", prflx: "NAT 穿透", relay: "TURN 中继" }

interface LinkStats {
  route: string
  local: string
  remote: string
  rtt: number
  fps: number
  kbps: number
  lossPct: number
  jitterMs: number
  size: string
  decoder: string
}

export const btn = (active = false) => ({
  background: active ? "rgba(37,99,235,0.35)" : "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "inherit",
  "border-radius": "4px",
  padding: "2px 7px",
  "font-size": "11px",
  cursor: "pointer",
})

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4

/**
 * WebRTC live view: H.264 video track + "input" DataChannel. Signaling goes through the
 * plugin RPC, so it works wherever the OpenCode server itself is reachable (LAN, OpenTunnel, ...).
 * Calls `onUnavailable` when WebRTC cannot be established so the caller can fall back to JPEG polling.
 */
export function LiveStreamView(props: { session: any; onUnavailable: (reason: string) => void }): JSX.Element {
  const [status, setStatus] = createSignal("Connecting…")
  const [connected, setConnected] = createSignal(false)
  const [takeover, setTakeover] = createSignal("")
  // null = fit to panel; otherwise remote pixels per CSS pixel.
  const [zoom, setZoom] = createSignal<number | null>(null)
  const [dims, setDims] = createSignal({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = createSignal(false)
  const [showLink, setShowLink] = createSignal(false)
  const [link, setLink] = createSignal<LinkStats | null>(null)
  const [connectMs, setConnectMs] = createSignal(0)

  let root: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let video: HTMLVideoElement | undefined
  let pc: RTCPeerConnection | undefined
  let dc: RTCDataChannel | undefined
  let session: string | undefined
  let statsTimer: ReturnType<typeof setInterval> | undefined
  let takeoverTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let lastMove = 0

  const rpc = () => props.session?.server?.client?.rpc(BotRpc)

  const giveUp = (reason: string) => {
    if (disposed) return
    teardown()
    props.onUnavailable(reason)
  }

  const teardown = () => {
    disposed = true
    clearInterval(statsTimer)
    clearInterval(takeoverTimer)
    pc?.close()
    if (session) void rpc()?.streamClose({ session }).catch(() => {})
  }

  const connect = async () => {
    const client = rpc()
    if (!client) return giveUp("server disconnected")
    if (typeof RTCPeerConnection === "undefined") return giveUp("WebRTC unsupported")

    const started = performance.now()
    pc = new RTCPeerConnection()
    pc.addTransceiver("video", { direction: "recvonly" })
    dc = pc.createDataChannel("input", { ordered: true })
    pc.ontrack = (e) => {
      if (video) {
        video.srcObject = e.streams[0] ?? new MediaStream([e.track])
        void video.play().catch(() => {})
      }
    }
    pc.onconnectionstatechange = () => {
      const s = pc!.connectionState
      if (s === "connected") {
        setConnected(true)
        setConnectMs(Math.round(performance.now() - started))
        setStatus("Live · WebRTC")
      } else if (s === "failed") {
        giveUp("WebRTC connection failed (no direct route)")
      } else if (s === "disconnected") {
        setStatus("Reconnecting…")
      }
    }

    await pc.setLocalDescription(await pc.createOffer())
    // Non-trickle: wait briefly for local candidates so one RPC round trip is enough.
    await new Promise<void>((resolve) => {
      if (pc!.iceGatheringState === "complete") return resolve()
      const done = () => pc!.iceGatheringState === "complete" && resolve()
      pc!.addEventListener("icegatheringstatechange", done)
      setTimeout(resolve, 2000)
    })
    if (disposed) return

    try {
      const answer = await client.streamOffer({ sdp: pc.localDescription!.sdp })
      session = answer.session
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    } catch (err: any) {
      return giveUp(err?.message ?? "signaling failed")
    }

    setTimeout(() => !connected() && giveUp("WebRTC connect timeout"), 10_000)

    let lastBytes = 0
    let lastFrames = 0
    statsTimer = setInterval(async () => {
      if (!pc) return
      const stats = await pc.getStats()
      const byId = new Map<string, any>()
      stats.forEach((r: any) => byId.set(r.id, r))
      let inbound: any
      let pair: any
      stats.forEach((r: any) => {
        if (r.type === "inbound-rtp" && r.kind === "video") inbound = r
        if (r.type === "transport" && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId)
      })
      if (!pair) stats.forEach((r: any) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r })
      const lc = pair && byId.get(pair.localCandidateId)
      const rc = pair && byId.get(pair.remoteCandidateId)
      const fps = inbound ? (inbound.framesDecoded ?? 0) - lastFrames : 0
      const kbps = inbound ? Math.round(((inbound.bytesReceived - lastBytes) * 8) / 1000) : 0
      if (inbound) {
        lastBytes = inbound.bytesReceived
        lastFrames = inbound.framesDecoded ?? 0
      }
      const lost = inbound?.packetsLost ?? 0
      const recv = inbound?.packetsReceived ?? 0
      const addr = (c: any) => c ? `${c.address ?? c.ip ?? "?"}:${c.port} ${c.protocol ?? ""} (${c.candidateType})` : "—"
      const s: LinkStats = {
        route: ROUTE[rc?.candidateType] ?? ROUTE[lc?.candidateType] ?? "—",
        local: addr(lc),
        remote: addr(rc),
        rtt: Math.round((pair?.currentRoundTripTime ?? 0) * 1000),
        fps,
        kbps,
        lossPct: recv + lost > 0 ? Math.round((lost / (recv + lost)) * 1000) / 10 : 0,
        jitterMs: Math.round((inbound?.jitter ?? 0) * 1000),
        size: inbound?.frameWidth ? `${inbound.frameWidth}×${inbound.frameHeight}` : "—",
        decoder: inbound?.decoderImplementation ?? "—",
      }
      setLink(s)
      if (connected()) setStatus(`Live · ${s.route} · ${s.fps} fps · ${s.kbps} kbps · ${s.rtt}ms`)
    }, 1000)
  }

  const send = (msg: Record<string, unknown>) => {
    if (dc?.readyState === "open") dc.send(JSON.stringify(msg))
  }

  const pos = (e: MouseEvent) => {
    if (!video || !video.videoWidth) return null
    // object-fit: contain -> compute the drawn video rect inside the element.
    const r = video.getBoundingClientRect()
    const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight)
    const w = video.videoWidth * scale
    const hgt = video.videoHeight * scale
    const x = (e.clientX - r.left - (r.width - w) / 2) / w
    const y = (e.clientY - r.top - (r.height - hgt) / 2) / hgt
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
  }

  const mods = (e: MouseEvent | KeyboardEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })

  const onMouse = (t: "down" | "up" | "move") => (e: MouseEvent) => {
    const p = pos(e)
    if (!p) return
    if (t === "move") {
      const now = performance.now()
      if (now - lastMove < 16) return
      lastMove = now
    } else {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).focus()
    }
    send({ t, ...p, b: e.button, ...mods(e) })
  }

  // Scale the fit view would use, so zoom steps start from what the user currently sees.
  const fitScale = () => {
    const { w, h: vh } = dims()
    if (!viewport || !w) return 1
    return Math.min(viewport.clientWidth / w, viewport.clientHeight / vh)
  }

  const zoomTo = (next: number, anchor?: { clientX: number; clientY: number }) => {
    const prev = zoom() ?? fitScale()
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    setZoom(z)
    if (!viewport) return
    // Keep the point under the cursor (or the centre) fixed while zooming.
    const r = viewport.getBoundingClientRect()
    const ax = anchor ? anchor.clientX - r.left : r.width / 2
    const ay = anchor ? anchor.clientY - r.top : r.height / 2
    const ratio = z / prev
    viewport.scrollLeft = (viewport.scrollLeft + ax) * ratio - ax
    viewport.scrollTop = (viewport.scrollTop + ay) * ratio - ay
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    // Trackpad pinch arrives as ctrl+wheel: zoom locally instead of sending it to the remote.
    if (e.ctrlKey) return zoomTo((zoom() ?? fitScale()) * Math.exp(-e.deltaY / 100), e)
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    send({ t: "wheel", dx: e.deltaX * scale, dy: e.deltaY * scale })
  }

  const onKey = (t: "keydown" | "keyup") => (e: KeyboardEvent) => {
    if (e.isComposing) return
    e.preventDefault()
    // Printable keys without shortcut modifiers go as text so the remote keyboard layout doesn't matter.
    if (t === "keydown" && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      send({ t: "text", s: e.key })
      return
    }
    if (t === "keyup" && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return
    send({ t, code: e.code, ...mods(e) })
  }

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain")
    if (text) {
      e.preventDefault()
      send({ t: "text", s: text })
    }
  }

  const checkTakeovers = async () => {
    try {
      const list = await rpc()?.listTakeovers({})
      const mine = list?.items.find((i: any) => !props.session?.id || i.sessionID === props.session.id)
      setTakeover(mine?.reason ?? "")
    } catch {}
  }

  const onFullscreenChange = () => setFullscreen(document.fullscreenElement === root)

  onMount(() => {
    void connect().catch((err) => giveUp(err?.message ?? String(err)))
    void checkTakeovers()
    takeoverTimer = setInterval(checkTakeovers, 3000)
    document.addEventListener("fullscreenchange", onFullscreenChange)
  })
  onCleanup(() => {
    document.removeEventListener("fullscreenchange", onFullscreenChange)
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {})
    teardown()
  })

  const server = () => props.session?.server
  const row = (label: string, value: () => string) =>
    h("div", { style: { display: "contents" } }, [
      h("span", { style: { color: "rgba(255,255,255,0.5)" } }, label),
      h("span", { style: { "word-break": "break-all" } }, value),
    ])

  const videoStyle = () => {
    const z = zoom()
    const { w, h: vh } = dims()
    if (z === null || !w) return { width: "100%", height: "100%", "object-fit": "contain", outline: "none", cursor: "default", display: "block" }
    return { width: `${Math.round(w * z)}px`, height: `${Math.round(vh * z)}px`, "max-width": "none", flex: "none", margin: "auto", "object-fit": "contain", outline: "none", cursor: "default", display: "block" }
  }

  return h("div", {
    ref: (el: HTMLDivElement) => { root = el },
    style: { display: "flex", "flex-direction": "column", height: "100%", width: "100%", background: "#05070a", color: "#e6edf3", "font-size": "12px" },
  }, [
    () => takeover() ? h("div", {
      style: { background: "#b91c1c", color: "#fff", padding: "6px 10px", display: "flex", "justify-content": "space-between", gap: "8px", "align-items": "center" },
    }, [
      h("span", {}, () => `⚠️ 人类接管中: ${takeover()}`),
      h("button", {
        onClick: async () => {
          await rpc()?.resolveTakeover({ sessionID: props.session?.id, note: "User completed action in Live Screen" })
          setTakeover("")
        },
        style: { background: "#fff", color: "#b91c1c", border: "none", "border-radius": "4px", padding: "3px 8px", cursor: "pointer" },
      }, "完成并恢复 AI"),
    ]) : null,
    h("div", {
      style: { display: "flex", "align-items": "center", gap: "4px", padding: "4px 8px", "flex-wrap": "wrap", "border-bottom": "1px solid rgba(255,255,255,0.08)" },
    }, [
      h("span", { style: { flex: "1", color: "rgba(255,255,255,0.6)", "font-size": "11px", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" } }, status),
      h("button", { title: "适应面板", onClick: () => setZoom(null), style: () => btn(zoom() === null) }, "适应"),
      h("button", { title: "原始像素 1:1", onClick: () => zoomTo(1), style: () => btn(zoom() === 1) }, "1:1"),
      h("button", { title: "缩小（也可双指捏合）", onClick: () => zoomTo((zoom() ?? fitScale()) / 1.25), style: btn() }, "−"),
      h("span", { style: { "min-width": "38px", "text-align": "center", "font-size": "11px" } }, () => `${Math.round((zoom() ?? fitScale()) * 100)}%`),
      h("button", { title: "放大（也可双指捏合）", onClick: () => zoomTo((zoom() ?? fitScale()) * 1.25), style: btn() }, "+"),
      h("button", { title: "链路信息", onClick: () => setShowLink(!showLink()), style: () => btn(showLink()) }, "ⓘ 链路"),
      h("button", { title: "全屏（Esc 退出）", onClick: () => toggleFullscreen(root), style: () => btn(fullscreen()) }, () => fullscreen() ? "退出全屏" : "⛶ 全屏"),
    ]),
    () => showLink() ? h("div", {
      style: { display: "grid", "grid-template-columns": "auto 1fr", gap: "2px 10px", padding: "6px 10px", "font-size": "11px", background: "rgba(255,255,255,0.04)", "border-bottom": "1px solid rgba(255,255,255,0.08)" },
    }, [
      row("服务器", () => `${server()?.name ?? "—"} · ${server()?.url ?? ""}`),
      row("信令通道", () => `${channelOf(server())} · ${server()?.connected ? "已连接" : "断开"}${server()?.compatible === false ? " · 版本不兼容" : ""}`),
      row("画面模式", () => connected() ? `WebRTC H.264 · 建连 ${connectMs()}ms` : "WebRTC 协商中"),
      row("媒体路径", () => link()?.route ?? "—"),
      row("本端候选", () => link()?.local ?? "—"),
      row("远端候选", () => link()?.remote ?? "—"),
      row("往返延迟", () => link() ? `${link()!.rtt} ms · 抖动 ${link()!.jitterMs} ms` : "—"),
      row("帧率/码率", () => link() ? `${link()!.fps} fps · ${link()!.kbps} kbps · 丢包 ${link()!.lossPct}%` : "—"),
      row("分辨率", () => link() ? `${link()!.size} · 解码 ${link()!.decoder}` : "—"),
      row("输入通道", () => dc?.readyState === "open" ? "DataChannel 原生键鼠" : "未就绪"),
    ]) : null,
    h("div", {
      ref: (el: HTMLDivElement) => { viewport = el },
      style: () => ({ flex: "1 1 0%", "min-height": "0", display: "flex", overflow: zoom() === null ? "hidden" : "auto" }),
    }, h("video", {
      ref: (el: HTMLVideoElement) => { video = el },
      autoplay: true,
      muted: true,
      playsInline: true,
      tabIndex: 0,
      onResize: () => video && setDims({ w: video.videoWidth, h: video.videoHeight }),
      onLoadedMetadata: () => video && setDims({ w: video.videoWidth, h: video.videoHeight }),
      onMouseDown: onMouse("down"),
      onMouseUp: onMouse("up"),
      onMouseMove: onMouse("move"),
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
      onWheel,
      onKeyDown: onKey("keydown"),
      onKeyUp: onKey("keyup"),
      onPaste,
      style: videoStyle,
    })),
  ]) as unknown as JSX.Element
}
