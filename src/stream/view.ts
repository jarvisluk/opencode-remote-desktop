import { createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import type { Ui } from "@opencode/plugin/gui"
import { BotRpc } from "../rpc.ts"
import { T, details, floating, iconButton, isFullscreenKey, rootStyle, statusCard, takeoverCard, windowFill, type Tone } from "../ui.ts"

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

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4

/**
 * WebRTC live view: H.264 video track + "input" DataChannel. Signaling goes through the
 * plugin RPC, so it works wherever the OpenCode server itself is reachable (LAN, OpenTunnel, ...).
 * Calls `onUnavailable` when WebRTC cannot be established so the caller can fall back to JPEG polling.
 */
export function LiveStreamView(props: { session: any; ui: Ui; onUnavailable: (reason: string) => void }): JSX.Element {
  const [status, setStatus] = createSignal("connecting")
  const [connected, setConnected] = createSignal(false)
  const [takeover, setTakeover] = createSignal("")
  // null = fit to panel; otherwise remote pixels per CSS pixel.
  const [zoom, setZoom] = createSignal<number | null>(null)
  const [dims, setDims] = createSignal({ w: 0, h: 0 })
  const [box, setBox] = createSignal({ w: 0, h: 0 })
  const [showLink, setShowLink] = createSignal(false)
  const [link, setLink] = createSignal<LinkStats | null>(null)
  const [connectMs, setConnectMs] = createSignal(0)
  const [focused, setFocused] = createSignal(false)

  let root: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let video: HTMLVideoElement | undefined
  let pc: RTCPeerConnection | undefined
  let dc: RTCDataChannel | undefined
  let session: string | undefined
  let statsTimer: ReturnType<typeof setInterval> | undefined
  let takeoverTimer: ReturnType<typeof setInterval> | undefined
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let moveTimer: ReturnType<typeof setTimeout> | undefined
  let wheelRaf: number | undefined
  let disposed = false
  let lastMove = 0
  let pendingMove: Record<string, unknown> | null = null
  let pendingWheel = { dx: 0, dy: 0 }
  let cachedRect: DOMRect | null = null
  let rectDirty = true

  const invalidateRect = () => {
    rectDirty = true
  }

  const rpc = () => props.session?.server?.client?.rpc(BotRpc)

  // ICE between two machines occasionally fails once (e.g. proxy TUN adapters, a sleeping NIC), so retry before
  // dropping to screenshot polling.
  const MAX_ATTEMPTS = 3
  let attempt = 0

  const giveUp = (reason: string) => {
    if (disposed) return
    teardown()
    props.onUnavailable(reason)
  }

  const clearInputTimers = () => {
    clearTimeout(moveTimer)
    moveTimer = undefined
    pendingMove = null
    if (wheelRaf !== undefined) {
      cancelAnimationFrame(wheelRaf)
      wheelRaf = undefined
    }
    pendingWheel = { dx: 0, dy: 0 }
  }

  const retryOrGiveUp = (reason: string) => {
    if (disposed) return
    if (attempt >= MAX_ATTEMPTS) return giveUp(reason)
    clearInterval(statsTimer)
    clearTimeout(connectTimer)
    clearInputTimers()
    pc?.close()
    if (session) void rpc()?.streamClose({ session }).catch(() => {})
    session = undefined
    setConnected(false)
    setStatus("reconnecting")
    setTimeout(() => void connect().catch((err) => giveUp(err?.message ?? String(err))), 600)
  }

  const teardown = () => {
    disposed = true
    clearInterval(statsTimer)
    clearInterval(takeoverTimer)
    clearTimeout(connectTimer)
    clearInputTimers()
    pc?.close()
    if (session) void rpc()?.streamClose({ session }).catch(() => {})
  }

  const connect = async () => {
    if (disposed) return
    const client = rpc()
    if (!client) return giveUp("server disconnected")
    if (typeof RTCPeerConnection === "undefined") return giveUp("WebRTC unsupported")

    const mine = ++attempt
    const current = () => !disposed && mine === attempt
    const started = performance.now()
    pc = new RTCPeerConnection()
    const peer = pc
    peer.addTransceiver("video", { direction: "recvonly" })
    dc = peer.createDataChannel("input", { ordered: true })
    peer.ontrack = (e) => {
      const rx = e.receiver as any
      if (rx) {
        if ("playoutDelayHint" in rx) rx.playoutDelayHint = 0
        if ("jitterBufferTarget" in rx) rx.jitterBufferTarget = 0
      }
      if (video) {
        video.srcObject = e.streams[0] ?? new MediaStream([e.track])
        void video.play().catch(() => {})
      }
    }
    peer.onconnectionstatechange = () => {
      if (!current()) return
      const s = peer.connectionState
      if (s === "connected") {
        clearTimeout(connectTimer)
        setConnected(true)
        setConnectMs(Math.round(performance.now() - started))
        setStatus("live")
      } else if (s === "failed") {
        retryOrGiveUp(`WebRTC connection failed after ${MAX_ATTEMPTS} attempts (no direct route)`)
      } else if (s === "disconnected") {
        setStatus("reconnecting")
      }
    }

    await peer.setLocalDescription(await peer.createOffer())
    // Non-trickle: wait briefly for local candidates so one RPC round trip is enough.
    await new Promise<void>((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        peer.removeEventListener("icegatheringstatechange", onState)
        clearTimeout(timer)
        resolve()
      }
      const onState = () => {
        if (peer.iceGatheringState === "complete") finish()
      }
      peer.addEventListener("icegatheringstatechange", onState)
      timer = setTimeout(finish, 400)
    })
    if (!current()) return

    const offerSdp = peer.localDescription?.sdp ?? ""
    if (!/^a=candidate:/m.test(offerSdp)) {
      return giveUp("WebRTC local candidates unavailable")
    }

    try {
      const answer = await client.streamOffer({ sdp: offerSdp })
      session = answer.session
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    } catch (err: any) {
      return giveUp(err?.message ?? "signaling failed")
    }

    clearTimeout(connectTimer)
    connectTimer = setTimeout(() => current() && !connected() && retryOrGiveUp("WebRTC connect timeout"), 10_000)

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
      if (pc.connectionState === "connected") setStatus("live")
    }, 1000)
  }

  const send = (msg: Record<string, unknown>, ephemeral = false) => {
    if (dc?.readyState !== "open") return
    if (ephemeral && dc.bufferedAmount > 65_536) return
    dc.send(JSON.stringify(msg))
  }

  const getVideoRect = () => {
    if (!video) return null
    if (rectDirty || !cachedRect) {
      cachedRect = video.getBoundingClientRect()
      rectDirty = false
    }
    return cachedRect
  }

  const pos = (e: MouseEvent) => {
    if (!video || !video.videoWidth) return null
    // object-fit: contain -> compute the drawn video rect inside the element.
    const r = getVideoRect()
    if (!r || r.width <= 0 || r.height <= 0) return null
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
      const msg = { t, ...p, b: e.button, ...mods(e) }
      const now = performance.now()
      const elapsed = now - lastMove
      if (elapsed >= 16) {
        clearTimeout(moveTimer)
        moveTimer = undefined
        pendingMove = null
        lastMove = now
        send(msg, true)
      } else {
        // Trailing-edge coalesce so the cursor's final resting position is never lost.
        pendingMove = msg
        if (!moveTimer) {
          moveTimer = setTimeout(() => {
            moveTimer = undefined
            if (pendingMove) {
              lastMove = performance.now()
              send(pendingMove, true)
              pendingMove = null
            }
          }, 16 - elapsed)
        }
      }
      return
    }
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).focus()
    if (pendingMove) {
      clearTimeout(moveTimer)
      moveTimer = undefined
      pendingMove = null
    }
    send({ t, ...p, b: e.button, ...mods(e) })
  }

  // Scale the fit view would use, so zoom steps start from what the user currently sees.
  const fitScale = () => {
    const { w, h: vh } = dims()
    const b = box()
    if (!w || !b.w) return 1
    return Math.min(b.w / w, b.h / vh)
  }

  const zoomTo = (next: number, anchor?: { clientX: number; clientY: number }) => {
    const prev = zoom() ?? fitScale()
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    setZoom(z)
    invalidateRect()
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
    pendingWheel.dx += e.deltaX * scale
    pendingWheel.dy += e.deltaY * scale
    if (wheelRaf === undefined) {
      wheelRaf = requestAnimationFrame(() => {
        wheelRaf = undefined
        if (pendingWheel.dx || pendingWheel.dy) {
          send({ t: "wheel", dx: pendingWheel.dx, dy: pendingWheel.dy }, true)
          pendingWheel = { dx: 0, dy: 0 }
        }
      })
    }
  }

  const onKey = (t: "keydown" | "keyup") => (e: KeyboardEvent) => {
    if (e.isComposing || isFullscreenKey(e)) return
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

  onMount(() => {
    void connect().catch((err) => giveUp(err?.message ?? String(err)))
    void checkTakeovers()
    takeoverTimer = setInterval(checkTakeovers, 3000)
  })
  onCleanup(() => {
    teardown()
  })

  const server = () => props.session?.server
  const ui = props.ui
  const fill = windowFill(() => root)

  const tone = (): Tone => (!connected() ? "muted" : status() === "reconnecting" ? "warning" : link()?.route === "TURN 中继" ? "warning" : "success")
  const summary = () => {
    if (status() === "reconnecting") return "WebRTC 重连中"
    if (!connected()) return "WebRTC 连接中"
    const s = link()
    return s ? `WebRTC · ${s.route} · ${s.fps ? `${s.fps} fps` : "画面静止"} · ${s.rtt} ms` : "WebRTC"
  }

  const videoStyle = () => {
    const z = zoom()
    const { w, h: vh } = dims()
    const base = { "object-fit": "contain", display: "block", cursor: "default", outline: focused() ? `2px solid ${T.focus}` : "none", "outline-offset": "-2px" }
    if (z === null || !w) return { ...base, width: "100%", height: "100%" }
    return { ...base, width: `${Math.round(w * z)}px`, height: `${Math.round(vh * z)}px`, "max-width": "none", flex: "none", margin: "auto" }
  }

  const zoomLabel = () => `${Math.round((zoom() ?? fitScale()) * 100)}%`

  return h("div", { ref: (el: HTMLDivElement) => { root = el }, style: rootStyle() }, [
    h("div", {
      ref: (el: HTMLDivElement) => {
        viewport = el
        const ro = new ResizeObserver(() => {
          setBox({ w: el.clientWidth, h: el.clientHeight })
          invalidateRect()
        })
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      },
      onScroll: invalidateRect,
      style: () => ({ position: "absolute", inset: "0", display: "flex", overflow: zoom() === null ? "hidden" : "auto" }),
    }, h("video", {
      ref: (el: HTMLVideoElement) => {
        video = el
        const ro = new ResizeObserver(invalidateRect)
        ro.observe(el)
        onCleanup(() => ro.disconnect())
      },
      autoplay: true,
      muted: true,
      playsInline: true,
      tabIndex: 0,
      "data-bot-screen": "",
      onResize: () => {
        invalidateRect()
        if (video) setDims({ w: video.videoWidth, h: video.videoHeight })
      },
      onLoadedMetadata: () => {
        invalidateRect()
        if (video) setDims({ w: video.videoWidth, h: video.videoHeight })
      },
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
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
    () => connected() ? null : h("div", {
      style: { position: "absolute", inset: "0", display: "flex", "align-items": "center", "justify-content": "center", "pointer-events": "none" },
    }, h(ui.Loader, {})),
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
          { label: "模式", value: () => connected() ? `WebRTC H.264 · 建连 ${connectMs()} ms` : "WebRTC 协商中" },
          { label: "路径", value: () => link()?.route ?? "—" },
          { label: "本端", value: () => link()?.local ?? "—" },
          { label: "远端", value: () => link()?.remote ?? "—" },
          { label: "延迟", value: () => link() ? `${link()!.rtt} ms · 抖动 ${link()!.jitterMs} ms` : "—" },
          { label: "流量", value: () => link() ? `${link()!.fps} fps · ${link()!.kbps} kbps · 丢包 ${link()!.lossPct}%` : "—" },
          { label: "分辨率", value: () => link() ? `${link()!.size} · ${link()!.decoder}` : "—" },
        ] },
        { title: "输入", rows: [
          { label: "键鼠", value: () => (link() && dc?.readyState === "open" ? "DataChannel 原生事件" : "未就绪") },
        ] },
      ]),
    }),
    () => takeover() ? takeoverCard(ui, takeover, async () => {
      await rpc()?.resolveTakeover({ sessionID: props.session?.id, note: "User completed action in Live Screen" })
      setTakeover("")
    }) : null,
    h("div", { style: floating("bottom-right", { display: "flex", "align-items": "center", gap: T.sp(0.5), padding: T.sp(1) }) }, [
      iconButton(ui, { icon: "collapse", label: "适应面板", onClick: (_e) => { setZoom(null); invalidateRect() } }),
      iconButton(ui, { icon: "outline-magnifier-minus", label: "缩小（也可双指捏合）", onClick: (_e) => zoomTo((zoom() ?? fitScale()) / 1.25) }),
      h("span", {
        title: "原始像素 1:1",
        onClick: () => zoomTo(1),
        style: { "min-width": "40px", "text-align": "center", color: T.muted, "font-variant-numeric": "tabular-nums", cursor: "pointer" },
      }, zoomLabel),
      iconButton(ui, { icon: "outline-magnifier-plus", label: "放大（也可双指捏合）", onClick: (_e) => zoomTo((zoom() ?? fitScale()) * 1.25) }),
      iconButton(ui, { icon: "expand", label: "铺满窗口（⌃⌘F 全屏）", onClick: (_e) => fill.toggle(), pressed: fill.on }),
    ]),
  ]) as unknown as JSX.Element
}
