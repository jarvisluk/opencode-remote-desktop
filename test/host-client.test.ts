import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { BotHostClient, hostPlatformPackageName, resolveHostBinary } from "../src/host/client.ts"
import { StreamSidecar } from "../src/stream/sidecar.ts"

describe("BotHostClient", () => {
  it("formats per-platform optional package names", () => {
    assert.equal(hostPlatformPackageName("darwin", "arm64"), "@opencode-bot/host-darwin-arm64")
    assert.equal(hostPlatformPackageName("win32", "x64"), "@opencode-bot/host-win32-x64")
    assert.equal(hostPlatformPackageName("linux", "x64"), "@opencode-bot/host-linux-x64")
  })

  it("communicates with the compiled bot-host binary over stdio JSON-RPC", async (t) => {
    const bin = resolveHostBinary()
    if (!bin) {
      t.skip("bot-host binary not built; run npm run build:native first")
      return
    }

    const client = new BotHostClient()
    try {
      const pong = await client.request<{ ok: boolean; version: string; platform: string }>("host.ping")
      assert.equal(pong.ok, true)
      assert.equal(typeof pong.version, "string")
      assert.ok(pong.platform.length > 0)

      const status = await client.request<{
        platform: string
        backend: string
        streamBackend: string
        displays: Array<{ id: string; width: number; height: number }>
      }>("host.status")
      assert.equal(typeof status.backend, "string")
      assert.equal(typeof status.streamBackend, "string")
      assert.ok(Array.isArray(status.displays))

      const probe = StreamSidecar.probe({ backend: "auto" })
      assert.ok(probe.backend === "native" || probe.backend === "ffmpeg")
    } finally {
      client.dispose()
    }
  })
})
