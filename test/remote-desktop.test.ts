import test from "node:test"
import assert from "node:assert/strict"
import { injectRemoteInput } from "../src/macos/desktop.ts"

test("injectRemoteInput handles zero scroll delta gracefully", async () => {
  const res = await injectRemoteInput({ kind: "scroll", x: 100, y: 100, deltaY: 0 })
  assert.equal(res.ok, true)
  assert.equal(res.detail, "No-op scroll")
})
