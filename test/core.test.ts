import test from "node:test"
import assert from "node:assert/strict"
import { resolveOptions } from "../src/options.ts"
import { computeNextRunAt } from "../src/routines/scheduler.ts"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { KeepAwakeController } from "../src/macos/awake.ts"
import { buildMacOSPath, resolveBinary } from "../src/macos/exec.ts"
import { getMacDesktopStatus } from "../src/macos/desktop.ts"
import { registerBotTools } from "../src/tools.ts"

test("options resolver applies sensible defaults", () => {
  const opts = resolveOptions(undefined)
  assert.equal(opts.consoleUrl, "https://bot-console.pages.dev")
  assert.equal(opts.serverUrl, undefined)
  assert.equal(opts.keepAwake, "active")
  assert.equal(opts.reuseHostBrowser, true)
  assert.equal(opts.maxImageDimension, 1440)
  assert.equal(opts.jpegQuality, 72)
  assert.equal(opts.routinePollMs, 30000)
})

test("options resolver sanitizes bounded numbers and strings", () => {
  const opts = resolveOptions({
    consoleUrl: "https://console.example.com/",
    keepAwake: "always",
    reuseHostBrowser: false,
    maxImageDimension: 8000,
    jpegQuality: 5,
    routinePollMs: 1000,
    serverUrl: "https://tunnel.example.com///",
  })
  assert.equal(opts.consoleUrl, "https://console.example.com")
  assert.equal(opts.keepAwake, "always")
  assert.equal(opts.reuseHostBrowser, false)
  assert.equal(opts.maxImageDimension, 3840) // capped
  assert.equal(opts.jpegQuality, 20) // bounded min
  assert.equal(opts.routinePollMs, 30000) // bounded min
  assert.equal(opts.serverUrl, "https://tunnel.example.com")
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
  assert.ok(["granted", "denied", "prompt", "unknown", "missing_agent_desktop"].includes(status.accessibility))
})

test("takeover manager supports non-blocking request, source tracking, and superseding", () => {
  let awakeCount = 0
  const manager = new TakeoverManager(() => {
    awakeCount += 1
    return () => {
      awakeCount -= 1
    }
  })

  const events: Array<{ type: string; id: string; source?: string; note?: string }> = []
  manager.onRequested((item) => events.push({ type: "req", id: item.id }))
  manager.onResolved((item, note, source) => events.push({ type: "res", id: item.id, source, note }))

  const first = manager.request({ sessionID: "ses_abc", reason: "Sign in to Colab", app: "Microsoft Edge" })
  assert.equal(manager.size, 1)
  assert.equal(awakeCount, 1)
  assert.equal(manager.getBySession("ses_abc")?.id, first.id)

  const second = manager.request({ sessionID: "ses_abc", reason: "Confirm 2FA" })
  assert.equal(manager.size, 1)
  assert.equal(awakeCount, 1)
  assert.equal(manager.getBySession("ses_abc")?.id, second.id)

  const resolved = manager.resolveBySession("ses_abc", "Done in Live Screen", { source: "ui" })
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].id, second.id)
  assert.equal(manager.size, 0)
  assert.equal(awakeCount, 0)
  assert.equal(manager.getBySession("ses_abc"), undefined)

  assert.deepEqual(events, [
    { type: "req", id: first.id },
    { type: "res", id: first.id, source: "superseded", note: "Superseded by newer takeover request" },
    { type: "req", id: second.id },
    { type: "res", id: second.id, source: "ui", note: "Done in Live Screen" },
  ])

  manager.dispose()
})

test("computer_request_takeover yields turn immediately and blocks desktop/browser tools while pending", async () => {
  const registered = new Map<string, any>()
  const editor = {
    namespace() {},
    add(def: any) {
      registered.set(def.name, def)
    },
  } as any

  const manager = new TakeoverManager(() => () => {})
  const opts = resolveOptions({ serverUrl: "https://srv.example.com" })
  registerBotTools(editor, {
    options: opts,
    isMac: true,
    awake: { isHeld: () => false } as any,
    takeovers: manager,
    browser: { inspect: async () => ({ mode: "cdp" }), run: async () => ({ ok: true }) } as any,
    routines: { list: () => [] } as any,
    permissionAssert: async () => {},
  })

  const toolCtx = {
    sessionID: "ses_1",
    messageID: "msg_1",
    agent: "build",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
  } as any

  // computer_status should not leak raw token URLs
  const statusResult = await registered.get("status").execute({}, toolCtx)
  assert.equal(statusResult.content.includes("secret-token"), false)
  const parsedStatus = JSON.parse(statusResult.content)
  assert.equal(parsedStatus.liveScreenAvailable, true)
  assert.equal(parsedStatus.webConsoleEnabled, true)

  // computer_request_takeover returns immediately without blocking
  const takeoverResult = await registered
    .get("request_takeover")
    .execute({ reason: "请在右侧 Live Screen 登录指定 Google 账号" }, toolCtx)
  assert.match(takeoverResult.content, /Human takeover requested/)
  assert.match(takeoverResult.content, /Live Screen/)
  assert.equal(manager.getBySession("ses_1")?.reason, "请在右侧 Live Screen 登录指定 Google 账号")

  // desktop & browser automation are blocked while takeover is pending on this session
  const desktopBlocked = await registered.get("desktop").execute({ action: "snapshot" }, toolCtx)
  assert.match(desktopBlocked.content, /Action blocked: human takeover/)

  const browserBlocked = await registered.get("browser").execute({ action: "snapshot" }, toolCtx)
  assert.match(browserBlocked.content, /Action blocked: human takeover/)

  // Once resolved, browser tool is no longer blocked by takeover
  manager.resolveBySession("ses_1", "Done", { source: "ui" })
  const browserUnblocked = await registered.get("browser").execute({ action: "snapshot" }, toolCtx)
  assert.equal(browserUnblocked.content.includes("Action blocked: human takeover"), false)

  manager.dispose()
})

test("console link carries server and session but no credentials; viewer registry tracks panels", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { consoleLink, detectTunnelUrl } = await import("../src/console/link.ts")
  const { ViewerRegistry } = await import("../src/takeover/viewers.ts")

  const url = new URL(consoleLink(resolveOptions({ serverUrl: "https://srv.example.com" }), "ses_1")!)
  assert.equal(url.origin, "https://bot-console.pages.dev")
  const hash = new URLSearchParams(url.hash.slice(1))
  assert.equal(hash.get("server"), "https://srv.example.com")
  assert.equal(hash.get("session"), "ses_1")
  assert.equal(url.search, "")
  assert.equal(consoleLink(resolveOptions({ consoleUrl: "", serverUrl: "https://srv.example.com" })), undefined)

  const root = mkdtempSync(join(tmpdir(), "bot-tunnel-"))
  const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") }
  assert.equal(detectTunnelUrl(env), undefined)
  mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  mkdirSync(join(env.XDG_DATA_HOME, "opentunnel", "default"), { recursive: true })
  writeFileSync(join(env.XDG_CONFIG_HOME, "opencode", "service.json"), JSON.stringify({ password: "x", remote: { route: "abc" } }))
  writeFileSync(join(env.XDG_DATA_HOME, "opentunnel", "default", "tunnel.json"), JSON.stringify({ hostname: "h.opentunnel.xyz" }))
  assert.equal(detectTunnelUrl(env), "https://abc.h.opentunnel.xyz")

  const v = new ViewerRegistry()
  assert.equal(v.isUnknown(), true)
  v.beat({ clientId: "m", platform: "web", mobile: true })
  assert.equal(v.hasPanelViewer(), false)
  v.beat({ clientId: "d", platform: "desktop", mobile: false })
  assert.equal(v.hasPanelViewer(), true)
  assert.equal(v.hasPanelViewer(Date.now() + 60_000), false)
})
