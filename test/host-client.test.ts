import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import {
  BotHostClient,
  downloadHostBinary,
  getCachedHostBinaryPath,
  hostAssetName,
  parseSha256Sums,
  resolveHostBinary,
} from "../src/host/client.ts"
import { StreamSidecar } from "../src/stream/sidecar.ts"

describe("BotHostClient", () => {
  it("formats per-platform release asset names and cache paths", () => {
    assert.equal(hostAssetName("darwin", "arm64"), "bot-host-darwin-arm64")
    assert.equal(hostAssetName("win32", "x64"), "bot-host-win32-x64.exe")
    assert.equal(hostAssetName("linux", "x64"), "bot-host-linux-x64")
    const cached = getCachedHostBinaryPath("linux", "x64", "0.2.0")
    assert.match(cached, /opencode-remote-desktop[\\/]+v0\.2\.0[\\/]+bot-host-linux-x64$/)
  })

  it("parses SHA256SUMS.txt and downloads + verifies host binary", async () => {
    const payload = Buffer.from("#!/bin/sh\necho ok\n", "utf8")
    const digest = createHash("sha256").update(payload).digest("hex")
    const sums = parseSha256Sums(`${digest}  bot-host-linux-x64\n${"0".repeat(64)} *./bot-host-darwin-arm64\n`)
    assert.equal(sums.get("bot-host-linux-x64"), digest)
    assert.equal(sums.get("bot-host-darwin-arm64"), "0".repeat(64))

    let badHash = false
    const server = http.createServer((req, res) => {
      if (req.url === "/SHA256SUMS.txt") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`${badHash ? "f".repeat(64) : digest}  bot-host-linux-x64\n`)
        return
      }
      if (req.url === "/bot-host-linux-x64") {
        res.writeHead(200, { "content-type": "application/octet-stream" })
        res.end(payload)
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address()
    assert.ok(addr && typeof addr === "object")
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bot-host-dl-"))
    try {
      const dest = path.join(tmpDir, "bot-host-linux-x64")
      const out = await downloadHostBinary({
        platform: "linux",
        arch: "x64",
        version: "0.2.0",
        baseUrl,
        destPath: dest,
      })
      assert.equal(out, dest)
      assert.deepEqual(readFileSync(dest), payload)

      badHash = true
      await assert.rejects(
        () =>
          downloadHostBinary({
            platform: "linux",
            arch: "x64",
            version: "0.2.0",
            baseUrl,
            destPath: path.join(tmpDir, "bad-bin"),
          }),
        /SHA-256 mismatch/,
      )
    } finally {
      server.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
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
