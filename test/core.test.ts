import test from "node:test"
import assert from "node:assert/strict"
import { resolveOptions } from "../src/options.ts"
import { computeNextRunAt } from "../src/routines/scheduler.ts"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { KeepAwakeController } from "../src/macos/awake.ts"
import { buildMacOSPath, resolveBinary } from "../src/macos/exec.ts"
import { getMacDesktopStatus } from "../src/macos/desktop.ts"

test("options resolver applies sensible defaults", () => {
  const opts = resolveOptions(undefined)
  assert.equal(opts.consoleHost, "0.0.0.0")
  assert.equal(opts.consolePort, 49375)
  assert.equal(opts.keepAwake, "active")
  assert.equal(opts.reuseHostBrowser, true)
  assert.equal(opts.maxImageDimension, 1440)
  assert.equal(opts.jpegQuality, 72)
  assert.equal(opts.routinePollMs, 30000)
})

test("options resolver sanitizes bounded numbers and strings", () => {
  const opts = resolveOptions({
    consoleHost: " 127.0.0.1 ",
    consolePort: 58888,
    keepAwake: "always",
    reuseHostBrowser: false,
    maxImageDimension: 8000,
    jpegQuality: 5,
    routinePollMs: 1000,
    publicBaseUrl: "https://tunnel.example.com///",
  })
  assert.equal(opts.consoleHost, "127.0.0.1")
  assert.equal(opts.consolePort, 58888)
  assert.equal(opts.keepAwake, "always")
  assert.equal(opts.reuseHostBrowser, false)
  assert.equal(opts.maxImageDimension, 3840) // capped
  assert.equal(opts.jpegQuality, 20) // bounded min
  assert.equal(opts.routinePollMs, 30000) // bounded min
  assert.equal(opts.publicBaseUrl, "https://tunnel.example.com")
})

test("routine next run calculation handles intervals and daily time", () => {
  const base = new Date("2026-11-12T10:00:00Z").getTime()
  const intervalRun = computeNextRunAt({ everyMinutes: 15 }, base)
  assert.equal(intervalRun, base + 15 * 60_000)

  const dailyRun = computeNextRunAt({ dailyAt: "15:30" }, base)
  assert.ok(dailyRun > base)
})

test("takeover manager handles suspension, event broadcast and resolution", async () => {
  let awakeAcquired = 0
  let awakeReleased = 0
  const acquire = () => {
    awakeAcquired += 1
    return () => {
      awakeReleased += 1
    }
  }

  const manager = new TakeoverManager(acquire)
  assert.equal(manager.size, 0)

  let receivedRequested = 0
  let receivedResolved = 0
  const unReq = manager.onRequested(() => {
    receivedRequested += 1
  })
  const unRes = manager.onResolved(() => {
    receivedResolved += 1
  })

  const { item, promise } = manager.waitForHuman({
    sessionID: "ses_12345",
    reason: "Scan QR code on WeChat",
    app: "WeChat",
  })

  assert.equal(manager.size, 1)
  assert.equal(item.sessionID, "ses_12345")
  assert.equal(receivedRequested, 1)
  assert.equal(awakeAcquired, 1)

  const resolved = manager.resolveBySession("ses_12345", "QR verified by user")
  assert.equal(resolved.length, 1)
  assert.equal(manager.size, 0)
  assert.equal(receivedResolved, 1)
  assert.equal(awakeReleased, 1)

  const note = await promise
  assert.equal(note, "QR verified by user")

  unReq()
  unRes()
  manager.dispose()
})

test("macos exec environment and binary resolution", async () => {
  const macPath = buildMacOSPath()
  assert.ok(macPath.includes("/usr/bin"))
  assert.ok(macPath.includes("/opt/homebrew/bin"))

  const sipsBin = resolveBinary("sips")
  assert.ok(sipsBin !== null)

  const status = await getMacDesktopStatus()
  assert.equal(status.platform, "darwin")
  assert.equal(status.supported, true)
  assert.ok(["granted", "denied", "prompt", "unknown"].includes(status.accessibility))
})
