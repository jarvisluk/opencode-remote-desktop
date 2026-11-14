import assert from "node:assert/strict"
import test from "node:test"
import { acquireShared } from "../src/shared.ts"

test("plugin instances in one process share host state", () => {
  let created = 0
  let disposed = 0
  const make = () => ({ value: { n: ++created }, dispose: () => disposed++ })
  const a = acquireShared(make)
  const b = acquireShared(make)
  assert.equal(a.value, b.value)
  assert.equal(created, 1)
  assert.equal(a.once("resume:tk_1"), true)
  assert.equal(b.once("resume:tk_1"), false)
  a.release()
  assert.equal(disposed, 0)
  b.release()
  assert.equal(disposed, 1)
  const c = acquireShared(make)
  assert.equal(created, 2)
  c.release()
})
