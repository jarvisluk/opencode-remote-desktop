import test from "node:test"
import assert from "node:assert/strict"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { ScreenLock, isGuiToolCall } from "../src/takeover/screen-lock.ts"

function setup() {
  let now = 1_000
  const takeovers = new TakeoverManager(() => () => {})
  const lock = new ScreenLock(takeovers, 20_000, () => now)
  return { takeovers, lock, advance: (ms: number) => (now += ms) }
}

test("isGuiToolCall recognizes screen-driving tools and wrappers", () => {
  assert.equal(isGuiToolCall("computer_desktop", {}), true)
  assert.equal(isGuiToolCall("computer.browser", {}), true)
  assert.equal(isGuiToolCall("playwright_browser_click", {}), true)
  assert.equal(isGuiToolCall("chrome-devtools_click", {}), true)
  assert.equal(isGuiToolCall("execute", { code: "await tools.browse.execute({ code: 'x' })" }), true)
  assert.equal(isGuiToolCall("execute", { code: `await tools["browse"].execute({})` }), true)
  assert.equal(isGuiToolCall("execute", { code: "tools.computer.desktop({ action: 'click' })" }), true)
  assert.equal(isGuiToolCall("execute", { code: "tools.magpie.call_tool({ name: 'playwright__browser_click' })" }), true)
  assert.equal(isGuiToolCall("shell", { command: "agent-desktop click @e3" }), true)

  assert.equal(isGuiToolCall("computer_screenshot", {}), false)
  assert.equal(isGuiToolCall("computer_request_takeover", {}), false)
  assert.equal(isGuiToolCall("execute", { code: "tools.computer.request_takeover({ reason: 'x' })" }), false)
  assert.equal(isGuiToolCall("execute", { code: "tools.browser.click({ tabID, ref })" }), false)
  assert.equal(isGuiToolCall("shell", { command: "git status" }), false)
  assert.equal(isGuiToolCall("read", { path: "agent-desktop.md" }), false)
})

test("agent owns the screen while a GUI call runs and for the grace window after", () => {
  const { lock, advance } = setup()
  assert.equal(lock.state().owner, "idle")
  lock.begin("ses_a", "call_1", "computer_desktop")
  assert.equal(lock.state().owner, "agent")
  assert.deepEqual(lock.state().sessionIDs, ["ses_a"])
  assert.equal(lock.inputAllowed(), false)
  advance(60_000)
  assert.equal(lock.state().owner, "agent", "a running call holds the lock past the grace window")
  lock.end("ses_a", "call_1")
  advance(19_000)
  assert.equal(lock.state().owner, "agent")
  advance(2_000)
  assert.equal(lock.state().owner, "idle")
  assert.equal(lock.inputAllowed(), true)
  lock.dispose()
})

test("release and takeover requests hand the screen back", () => {
  const { takeovers, lock } = setup()
  lock.begin("ses_a", "call_1", "computer_desktop")
  lock.release("ses_a")
  assert.equal(lock.state().owner, "idle")

  lock.begin("ses_a", "call_2", "computer_desktop")
  const item = takeovers.request({ sessionID: "ses_a", reason: "sign in" })
  const state = lock.state()
  assert.equal(state.owner, "human")
  assert.equal(state.takeoverId, item.id)
  assert.equal(lock.inputAllowed(), true)

  takeovers.resolveBySession("ses_a", undefined, { source: "ui" })
  assert.equal(lock.state().owner, "idle", "requesting a takeover drops the agent's lease")
  lock.dispose()
})

test("onChange fires once per ownership change", () => {
  const { takeovers, lock } = setup()
  const seen: string[] = []
  lock.onChange((s) => seen.push(s.owner))
  lock.begin("ses_a", "c1", "computer_desktop")
  lock.begin("ses_a", "c2", "computer_desktop")
  lock.end("ses_a", "c1")
  takeovers.request({ sessionID: "ses_a", reason: "x" })
  takeovers.resolveBySession("ses_a")
  assert.deepEqual(seen, ["agent", "human", "idle"])
  lock.dispose()
})
