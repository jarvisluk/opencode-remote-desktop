import test from "node:test"
import assert from "node:assert/strict"
import { channelOf } from "../src/stream/view.ts"

test("channelOf classifies the server connection path", () => {
  assert.equal(channelOf(undefined), "未连接")
  assert.equal(channelOf({ url: "http://127.0.0.1:4096", local: true }), "本机")
  assert.equal(channelOf({ url: "https://6779032f4b19e8a0.c6qo6aw3zmf2.opentunnel.xyz", local: false }), "OpenTunnel")
  assert.equal(channelOf({ url: "http://100.103.254.44:4096", local: false }), "Tailscale")
  assert.equal(channelOf({ url: "https://mini.tail1234.ts.net", local: false }), "Tailscale")
  assert.equal(channelOf({ url: "http://192.168.31.6:4096", local: false }), "局域网")
  assert.equal(channelOf({ url: "http://172.20.0.5:4096", local: false }), "局域网")
  assert.equal(channelOf({ url: "https://example.com", local: false }), "公网")
  assert.equal(channelOf({ url: "not a url", local: false }), "未知")
})
