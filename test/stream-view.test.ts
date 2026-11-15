import test from "node:test"
import assert from "node:assert/strict"
import { channelOf } from "../src/stream/view.ts"
import { createIdleWatcher, type SleepReason } from "../src/stream/idle.ts"
import { explainScreenError } from "../src/ui.ts"
import { createGuiTranslator } from "../src/i18n/gui.ts"

test("channelOf classifies the server connection path in Chinese, English, and Traditional Chinese", () => {
  const tZh = createGuiTranslator("zh")
  assert.equal(channelOf(undefined, tZh), "未连接")
  assert.equal(channelOf({ url: "http://127.0.0.1:4096", local: true }, tZh), "本机")
  assert.equal(channelOf({ url: "https://6779032f4b19e8a0.c6qo6aw3zmf2.opentunnel.xyz", local: false }, tZh), "OpenTunnel")
  assert.equal(channelOf({ url: "http://100.103.254.44:4096", local: false }, tZh), "Tailscale")
  assert.equal(channelOf({ url: "https://mini.tail1234.ts.net", local: false }, tZh), "Tailscale")
  assert.equal(channelOf({ url: "http://192.168.31.6:4096", local: false }, tZh), "局域网")
  assert.equal(channelOf({ url: "http://172.20.0.5:4096", local: false }, tZh), "局域网")
  assert.equal(channelOf({ url: "https://example.com", local: false }, tZh), "公网")
  assert.equal(channelOf({ url: "not a url", local: false }, tZh), "未知")

  const tEn = createGuiTranslator("en")
  assert.equal(channelOf(undefined, tEn), "Disconnected")
  assert.equal(channelOf({ url: "http://127.0.0.1:4096", local: true }, tEn), "Local")
  assert.equal(channelOf({ url: "http://192.168.31.6:4096", local: false }, tEn), "LAN")
  assert.equal(channelOf({ url: "https://example.com", local: false }, tEn), "Public")
  assert.equal(channelOf({ url: "not a url", local: false }, tEn), "Unknown")

  const tZht = createGuiTranslator("zht")
  assert.equal(channelOf(undefined, tZht), "未連線")
  assert.equal(channelOf({ url: "http://192.168.31.6:4096", local: false }, tZht), "區域網路")
})

test("explainScreenError translates raw RPC and WebRTC errors into clear diagnostics", () => {
  const rpcErr = explainScreenError("RPC is unavailable: bot", createGuiTranslator("zh"))
  assert.equal(rpcErr.serviceUnavailable, true)
  assert.match(rpcErr.summary, /bot 插件/)
  assert.ok(rpcErr.hint && rpcErr.hint.includes("bot"))

  const rpcErrEn = explainScreenError("RPC is unavailable: bot", createGuiTranslator("en"))
  assert.equal(rpcErrEn.serviceUnavailable, true)
  assert.match(rpcErrEn.summary, /Remote bot plugin/)

  const nativeErr = explainScreenError("native stream binary missing: /path/screencapture-stream (run `npm run build:native`)")
  assert.equal(nativeErr.serviceUnavailable, undefined)
  assert.match(nativeErr.summary, /build:native/)
  assert.ok(nativeErr.hint)

  const routeErr = explainScreenError("WebRTC no direct route")
  assert.match(routeErr.summary, /WebRTC 直连失败/)
  assert.ok(routeErr.hint)

  const permErr = explainScreenError("Screen Recording permission denied")
  assert.match(permErr.summary, /屏幕录制权限/)
  assert.ok(permErr.hint)
})

function createFakeTarget() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener(type: string, fn: () => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
  }
}

test("createIdleWatcher sleeps on idle, skips when busy, and wakes on visibility restore", async () => {
  const target = createFakeTarget()
  const doc = { ...createFakeTarget(), hidden: false }
  const events: string[] = []
  let busy = true

  const watcher = createIdleWatcher({
    idleTimeoutMs: 30,
    hiddenTimeoutMs: 20,
    isBusy: () => busy,
    target,
    doc,
    onSleep: (reason: SleepReason) => events.push(`sleep:${reason}`),
    onWake: (from: SleepReason) => events.push(`wake:${from}`),
  })

  // Still busy after first timeout -> should stay awake
  await new Promise((r) => setTimeout(r, 45))
  assert.deepEqual(events, [])
  assert.equal(watcher.sleeping, null)

  // Clear busy -> next idle timeout puts it to sleep
  busy = false
  await new Promise((r) => setTimeout(r, 45))
  assert.deepEqual(events, ["sleep:idle"])
  assert.equal(watcher.sleeping, "idle")

  // Visibility restore does not auto-wake an idle sleep
  doc.hidden = false
  doc.emit("visibilitychange")
  assert.equal(watcher.sleeping, "idle")

  // Manual wake resumes
  watcher.wake()
  assert.deepEqual(events, ["sleep:idle", "wake:idle"])
  assert.equal(watcher.sleeping, null)

  // Hidden sleep auto-wakes when document becomes visible again
  doc.hidden = true
  doc.emit("visibilitychange")
  await new Promise((r) => setTimeout(r, 35))
  assert.equal(watcher.sleeping, "hidden")

  doc.hidden = false
  doc.emit("visibilitychange")
  assert.equal(watcher.sleeping, null)
  assert.deepEqual(events, ["sleep:idle", "wake:idle", "sleep:hidden", "wake:hidden"])

  watcher.dispose()
})
