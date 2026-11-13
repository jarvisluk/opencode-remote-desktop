import test from "node:test"
import assert from "node:assert/strict"
import { channelOf } from "../src/stream/view.ts"
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
