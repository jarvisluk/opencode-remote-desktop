import test from "node:test"
import assert from "node:assert/strict"
import { resolveOptions } from "../src/options.ts"
import { KeepAwakeController } from "../src/macos/awake.ts"
import { injectRemoteInput } from "../src/macos/desktop.ts"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { filterHostAddress, WebTakeoverConsole } from "../src/takeover/web-console.ts"

test("filterHostAddress filters virtual interfaces, fake-ip, link-local, and .0/.255", () => {
  assert.equal(filterHostAddress("en0", "192.168.31.86"), true)
  assert.equal(filterHostAddress("utun4", "100.108.57.99"), true)
  assert.equal(filterHostAddress("awdl0", "192.168.1.10"), false)
  assert.equal(filterHostAddress("llw0", "192.168.1.11"), false)
  assert.equal(filterHostAddress("anpi0", "192.168.1.12"), false)
  assert.equal(filterHostAddress("bridge100", "192.168.97.0"), false)
  assert.equal(filterHostAddress("vmenet0", "192.168.105.1"), false)
  assert.equal(filterHostAddress("utun3", "198.18.0.1"), false)
  assert.equal(filterHostAddress("utun3", "198.19.0.5"), false)
  assert.equal(filterHostAddress("en1", "169.254.10.20"), false)
  assert.equal(filterHostAddress("en2", "192.168.107.0"), false)
  assert.equal(filterHostAddress("en2", "192.168.107.255"), false)
})

test("injectRemoteInput handles zero scroll delta gracefully", async () => {
  const res = await injectRemoteInput({ kind: "scroll", x: 100, y: 100, deltaY: 0 })
  assert.equal(res.ok, true)
  assert.equal(res.detail, "No-op scroll")
})

test("WebTakeoverConsole exposes WebRTC offer/close and streamAvailable", async () => {
  const opts = resolveOptions({ consoleHost: "127.0.0.1", consolePort: 0 })
  const awake = new KeepAwakeController("off")
  const takeovers = new TakeoverManager(() => awake.acquire())
  const closed: string[] = []
  const fakeStream = {
    offer: async (sdp: string) => ({ session: "s_test", sdp: `ans:${sdp}` }),
    close: async (session: string) => {
      closed.push(session)
    },
  } as any

  const consoleSrv = new WebTakeoverConsole(opts, takeovers, fakeStream)
  await consoleSrv.start()
  try {
    const urls = consoleSrv.getUrls()
    assert.ok(urls.length >= 1)
    const parsed = new URL(urls[0]!)
    const token = parsed.searchParams.get("token")!
    const base = `${parsed.origin}`

    const stateRes = await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`)
    assert.equal(stateRes.status, 200)
    const state = (await stateRes.json()) as { streamAvailable: boolean }
    assert.equal(state.streamAvailable, true)

    const offerRes = await fetch(`${base}/api/stream/offer?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\n" }),
    })
    assert.equal(offerRes.status, 200)
    const offer = (await offerRes.json()) as { session: string; sdp: string }
    assert.equal(offer.session, "s_test")
    assert.equal(offer.sdp, "ans:v=0\r\n")

    const closeRes = await fetch(`${base}/api/stream/close?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "s_test" }),
    })
    assert.equal(closeRes.status, 200)
    assert.deepEqual(closed, ["s_test"])
  } finally {
    await consoleSrv.dispose()
    takeovers.dispose()
    awake.dispose()
  }
})
