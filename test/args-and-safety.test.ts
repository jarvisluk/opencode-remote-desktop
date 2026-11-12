import test from "node:test"
import assert from "node:assert/strict"
import { buildDesktopArgs, buildBrowserArgs } from "../src/args-builder.ts"
import { containsHighRiskIntent } from "../src/index.ts"
import { parseDailyAt } from "../src/routines/scheduler.ts"

test("buildDesktopArgs formats actions correctly", () => {
  const snap = buildDesktopArgs({ action: "snapshot", interactiveOnly: true, app: "Finder" })
  assert.deepEqual(snap.args, ["snapshot", "--compact", "-i", "--app", "Finder"])

  const click = buildDesktopArgs({ action: "click", ref: "@w1:e2" })
  assert.deepEqual(click.args, ["click", "@w1:e2"])

  const clickErr = buildDesktopArgs({ action: "click" })
  assert.ok(clickErr.error)

  const mouseClick = buildDesktopArgs({ action: "mouse_click_xy", x: 100.4, y: 200.7 })
  assert.deepEqual(mouseClick.args, ["mouse-click", "--xy=100,201"])

  const focusWin = buildDesktopArgs({ action: "focus_window", windowId: "w_123" })
  assert.deepEqual(focusWin.args, ["focus-window", "--window-id", "w_123"])
})

test("buildBrowserArgs formats actions correctly", () => {
  const open = buildBrowserArgs({ action: "open", target: "https://example.com" })
  assert.deepEqual(open.args, ["open", "https://example.com"])

  const openErr = buildBrowserArgs({ action: "open" })
  assert.ok(openErr.error)

  const fill = buildBrowserArgs({ action: "fill", target: "#search", value: "hello" })
  assert.deepEqual(fill.args, ["fill", "#search", "hello"])
})

test("containsHighRiskIntent matches word boundaries and Chinese words without false positives", () => {
  // Should NOT trigger false positives on substrings like payload (pay), sender (send)
  assert.equal(containsHighRiskIntent(["payload data received"]), null)
  assert.equal(containsHighRiskIntent(["sender address"]), null)
  assert.equal(containsHighRiskIntent(["press delete key"]), "delete")
  assert.equal(containsHighRiskIntent(["please pay the bill"]), "pay")
  assert.equal(containsHighRiskIntent(["帮我付款"]), "付款")
})

test("parseDailyAt parses valid 24h HH:MM", () => {
  assert.deepEqual(parseDailyAt("09:30"), { hour: 9, minute: 30 })
  assert.deepEqual(parseDailyAt("00:00"), { hour: 0, minute: 0 })
  assert.deepEqual(parseDailyAt("23:59"), { hour: 23, minute: 59 })
  assert.equal(parseDailyAt("24:00"), null)
  assert.equal(parseDailyAt("9:30"), null)
  assert.equal(parseDailyAt("invalid"), null)
})

test("tool result image uri validation rejects file:// protocol", () => {
  const compileCheck = (messages: any[]) => {
    if (
      messages
        .flatMap((p) =>
          p.content.flatMap((m: any) => {
            if (m.type === "media") {
              const u = m.media.source
              return u.type === "url" ? [u.url] : u.type === "ref" ? [u.id] : []
            }
            if (m.type !== "tool-result" || m.result.type !== "content") return []
            return m.result.value.flatMap((u: any) => (u.type === "file" ? [u.uri] : []))
          }),
        )
        .some((p: string) => /^\s*file:/i.test(p))
    ) {
      throw new Error("Local file references must be read with Media.file(path) before sending")
    }
  }

  // data: URI should pass
  assert.doesNotThrow(() => {
    compileCheck([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "screenshot",
            result: {
              type: "content",
              value: [
                {
                  type: "file",
                  uri: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
                  mime: "image/jpeg",
                  name: "macos-screen.jpg",
                },
              ],
            },
          },
        ],
      },
    ])
  })

  // file: URI must throw
  assert.throws(
    () => {
      compileCheck([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_1",
              name: "screenshot",
              result: {
                type: "content",
                value: [
                  {
                    type: "file",
                    uri: "file:///var/folders/screen.jpg",
                    mime: "image/jpeg",
                  },
                ],
              },
            },
          ],
        },
      ])
    },
    /Local file references must be read with Media.file\(path\) before sending/,
  )
})

