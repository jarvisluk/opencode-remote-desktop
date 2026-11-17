import test from "node:test"
import assert from "node:assert/strict"
import { SecretManager, deleteSecret, isValidSecretName, readSecret, saveSecret } from "../src/secrets.ts"
import { readsKeychain } from "../src/index.ts"
import { registerBotTools } from "../src/tools.ts"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { resolveOptions } from "../src/options.ts"
import { renderConsoleHtml } from "../src/console/page.ts"

test("secret names are restricted to characters safe on a `security -i` line", () => {
  assert.equal(isValidSecretName("github.password"), true)
  assert.equal(isValidSecretName("a_b-C.9"), true)
  for (const bad of ["", "a b", "x;rm", "a\nb", "a\"b", "x".repeat(65), undefined]) {
    assert.equal(isValidSecretName(bad), false, String(bad))
  }
})

test("SecretManager stores on submit, never lists values, and releases keep-awake", async () => {
  const saved: Array<[string, string]> = []
  let held = 0
  const manager = new SecretManager(() => (held++, () => held--), async (name, value) => {
    saved.push([name, value])
  })
  const events: string[] = []
  manager.onRequested((i) => events.push(`req:${i.name}`))
  manager.onResolved((i, outcome) => events.push(`${outcome}:${i.name}`))

  const { item, promise } = manager.request({ sessionID: "ses_1", name: "gh", reason: "GitHub" })
  assert.equal(held, 1)
  assert.deepEqual(Object.keys(manager.list()[0]).sort(), ["createdAt", "id", "name", "reason", "sessionID"])
  assert.equal(manager.getBySession("ses_1")?.id, item.id)

  assert.equal(await manager.submit(item.id, "hunter2"), true)
  await promise
  assert.deepEqual(saved, [["gh", "hunter2"]])
  assert.equal(manager.list().length, 0)
  assert.equal(held, 0)
  assert.deepEqual(events, ["req:gh", "saved:gh"])
  assert.equal(await manager.submit(item.id, "again"), false)
})

test("SecretManager keeps the request open when the keychain write fails", async () => {
  let fail = true
  const manager = new SecretManager(() => () => {}, async () => {
    if (fail) throw new Error("Keychain is locked")
  })
  const { item, promise } = manager.request({ sessionID: "ses_1", name: "gh", reason: "GitHub" })
  await assert.rejects(manager.submit(item.id, "x"), /locked/)
  await assert.rejects(manager.submit(item.id, ""), /Empty/)
  assert.equal(manager.list().length, 1)
  fail = false
  assert.equal(await manager.submit(item.id, "x"), true)
  await promise
})

test("SecretManager rejects on cancel, abort, timeout and supersede", async () => {
  const manager = new SecretManager(() => () => {}, async () => {}, 20)

  const a = manager.request({ sessionID: "ses_1", name: "a", reason: "r" })
  assert.equal(manager.cancel({ id: a.item.id }), 1)
  await assert.rejects(a.promise, /Cancelled by the user/)

  const ctrl = new AbortController()
  const b = manager.request({ sessionID: "ses_1", name: "b", reason: "r", signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(b.promise, /Session stopped/)

  const c = manager.request({ sessionID: "ses_1", name: "c", reason: "r" })
  await assert.rejects(c.promise, /Timed out/)

  const d = manager.request({ sessionID: "ses_2", name: "d", reason: "r" })
  const e = manager.request({ sessionID: "ses_2", name: "e", reason: "r" })
  await assert.rejects(d.promise, /Superseded/)
  assert.equal(manager.getBySession("ses_2")?.id, e.item.id)
  manager.dispose()
  await assert.rejects(e.promise, /Plugin unloaded/)

  assert.throws(() => manager.request({ sessionID: "ses_3", name: "bad name", reason: "r" }), /Invalid secret name/)
})

function setup(overrides: { readSecret?: (name: string) => Promise<string | null>; runDesktop?: any; viewers?: any } = {}) {
  const registered = new Map<string, any>()
  const editor = { namespace() {}, add: (def: any) => registered.set(def.name, def) } as any
  const permissions: any[] = []
  const secrets = new SecretManager(() => () => {}, async () => {})
  registerBotTools(editor, {
    options: resolveOptions({}),
    isMac: true,
    awake: { isHeld: () => false } as any,
    takeovers: new TakeoverManager(() => () => {}),
    secrets,
    browser: {} as any,
    routines: {} as any,
    permissionAssert: async (p) => {
      permissions.push(p)
    },
    ...overrides,
  })
  const toolCtx = { sessionID: "ses_1", messageID: "msg_1", agent: "build", id: "call_1", signal: new AbortController().signal } as any
  return { registered, permissions, secrets, toolCtx }
}

test("computer_secret_request waits for the user and never returns the value", async () => {
  const { registered, secrets, toolCtx } = setup()
  const pending = registered.get("secret_request").execute({ name: "gh", reason: "GitHub" }, toolCtx)
  const [req] = secrets.list()
  assert.equal(req.name, "gh")
  await secrets.submit(req.id, "hunter2")
  const out = await pending
  assert.match(out.content, /Secret saved/)
  assert.equal(out.content.includes("hunter2"), false)

  const cancelled = registered.get("secret_request").execute({ name: "gh", reason: "GitHub" }, toolCtx)
  secrets.cancel({ sessionID: "ses_1" })
  assert.match((await cancelled).content, /ended without a value/)

  assert.match((await registered.get("secret_request").execute({ name: "a b", reason: "x" }, toolCtx)).content, /must match/)
})

test("computer_secret_request is disabled on the local host without blocking", async () => {
  const { ViewerRegistry } = await import("../src/takeover/viewers.ts")
  const viewers = new ViewerRegistry()
  viewers.beat({ clientId: "d", platform: "desktop", mobile: false, sessionID: "ses_1", panel: false })
  const { registered, secrets, toolCtx } = setup({ viewers })
  const out = await registered.get("secret_request").execute({ name: "gh", reason: "GitHub" }, toolCtx)
  assert.match(out.content, /disabled on the local host/)
  assert.equal(secrets.list().length, 0, "no pending secret request is registered")
})

test("computer_secret_type keeps the value out of permissions and results", async () => {
  const calls: string[][] = []
  const { registered, permissions, toolCtx } = setup({
    readSecret: async (name) => (name === "gh" ? "hunter2" : null),
    runDesktop: async (args: string[]) => {
      calls.push(args)
      return { ok: true, raw: `typed "${args[2]}"`, parsed: null }
    },
  })
  const out = await registered.get("secret_type").execute({ name: "gh", ref: "@s1:e5", app: "Safari" }, toolCtx)
  assert.deepEqual(calls, [["type", "@s1:e5", "hunter2"]])
  assert.match(out.content, /Typed secret "gh"/)
  assert.equal(out.content.includes("hunter2"), false)
  assert.equal(permissions.length, 1)
  assert.equal(permissions[0].action, "bot.secret.type")
  assert.equal(JSON.stringify(permissions[0]).includes("hunter2"), false)

  const missing = await registered.get("secret_type").execute({ name: "nope", ref: "@s1:e5" }, toolCtx)
  assert.match(missing.content, /not stored/)
  assert.equal(calls.length, 1)
})

test("keychain reads by other tools are detected for a permission prompt", () => {
  assert.equal(readsKeychain(["security find-generic-password -s opencode-bot -a gh -w"]), true)
  assert.equal(readsKeychain(['{"command":"security dump-keychain"}']), true)
  assert.equal(readsKeychain(["security add-generic-password -s x"]), false)
  assert.equal(readsKeychain(["npm test"]), false)
})

test("web console ships the secret entry form", () => {
  const html = renderConsoleHtml("zh")
  assert.match(html, /id="secretForm"/)
  assert.match(html, /id="secretInput" type="password"/)
  assert.match(html, /listSecretRequests/)
})

test(
  "keychain round trip (macOS, OPENCODE_BOT_KEYCHAIN_TEST=1)",
  { skip: process.platform !== "darwin" || process.env.OPENCODE_BOT_KEYCHAIN_TEST !== "1" },
  async () => {
    const name = `test.${process.pid}`
    const value = `p@ss wörd "$; ${Date.now()}`
    try {
      await saveSecret(name, value)
      assert.equal(await readSecret(name), value)
      await saveSecret(name, "updated")
      assert.equal(await readSecret(name), "updated")
    } finally {
      await deleteSecret(name)
    }
    assert.equal(await readSecret(name), null)
  },
)
