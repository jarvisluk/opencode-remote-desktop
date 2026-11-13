import { createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import h from "solid-js/h"
import { BotRpc } from "../rpc.ts"

/**
 * WebRTC live view: H.264 video track + "input" DataChannel. Signaling goes through the
 * plugin RPC, so it works wherever the OpenCode server itself is reachable (LAN, OpenTunnel, ...).
 * Calls `onUnavailable` when WebRTC cannot be established so the caller can fall back to JPEG polling.
 */
export function LiveStreamView(props: { session: any; onUnavailable: (reason: string) => void }): JSX.Element {
  const [status, setStatus] = createSignal("Connecting…")
  const [connected, setConnected] = createSignal(false)
  const [takeover, setTakeover] = createSignal("")

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
      let rtt = 0
      let kind = ""
      stats.forEach((r: any) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          const kbps = Math.round(((r.bytesReceived - lastBytes) * 8) / 1000)
          const fps = (r.framesDecoded ?? 0) - lastFrames
          lastBytes = r.bytesReceived
          lastFrames = r.framesDecoded ?? 0
          kind = `${fps} fps · ${kbps} kbps`
        }
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
          rtt = Math.round((r.currentRoundTripTime ?? 0) * 1000)
        }
      })
      if (connected()) setStatus(`Live · ${kind} · ${rtt}ms`)
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

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
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

  onMount(() => {
    void connect().catch((err) => giveUp(err?.message ?? String(err)))
    void checkTakeovers()
    takeoverTimer = setInterval(checkTakeovers, 3000)
  })
  onCleanup(teardown)

  return h("div", {
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
    h("div", { style: { padding: "4px 10px", color: "rgba(255,255,255,0.6)", "font-size": "11px" } }, status),
    h("video", {
      ref: (el: HTMLVideoElement) => { video = el },
      autoplay: true,
      muted: true,
      playsInline: true,
      tabIndex: 0,
      onMouseDown: onMouse("down"),
      onMouseUp: onMouse("up"),
      onMouseMove: onMouse("move"),
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
      onWheel,
      onKeyDown: onKey("keydown"),
      onKeyUp: onKey("keyup"),
      onPaste,
      style: { flex: "1 1 0%", width: "100%", "min-height": "0", "object-fit": "contain", outline: "none", cursor: "default" },
    }),
  ]) as unknown as JSX.Element
}
