import test from "node:test"
import assert from "node:assert/strict"
import {
  compareVersions,
  formatDoctorReport,
  parseVersion,
  startupWarnings,
  type DependencyCheck,
  type DiagnosticsReport,
} from "../src/diagnostics.ts"

function report(overrides: Partial<DiagnosticsReport>): DiagnosticsReport {
  return {
    platform: "darwin",
    isMac: true,
    dependencies: [],
    permissions: null,
    stream: { backend: "native" },
    ...overrides,
  }
}

test("parseVersion extracts semver from CLI version output", () => {
  assert.equal(parseVersion("agent-desktop 1.1.0"), "1.1.0")
  assert.equal(parseVersion("agent-browser 0.41.1"), "0.41.1")
  assert.equal(parseVersion("v2.0\n"), "2.0.0")
  assert.equal(parseVersion("no digits here"), null)
})

test("compareVersions orders versions correctly", () => {
  assert.ok(compareVersions("1.1.0", "1.0.9") > 0)
  assert.ok(compareVersions("0.41.1", "0.41.0") > 0)
  assert.ok(compareVersions("0.9.0", "0.41.0") < 0)
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0)
})

test("startupWarnings reports missing CLI, stale version, and unbuilt sidecar", () => {
  const deps: readonly DependencyCheck[] = [
    { name: "agent-desktop", installed: false, minimumVersion: "1.1.0", installHint: "npm install -g agent-desktop" },
    { name: "agent-browser", installed: true, version: "0.30.0", versionOk: false, minimumVersion: "0.41.1", installHint: "npm install -g agent-browser" },
  ]
  const warnings = startupWarnings(report({ dependencies: deps, stream: { backend: null, reason: "未构建" } }))
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /agent-desktop.*CLI 未安装/)
  assert.match(warnings[1], /低于已验证版本 0\.41\.1/)
  assert.match(warnings[2], /build:native/)
})

test("startupWarnings is empty when everything is healthy", () => {
  const deps: readonly DependencyCheck[] = [
    { name: "agent-desktop", installed: true, version: "1.1.0", versionOk: true },
    { name: "agent-browser", installed: true, version: "0.41.1", versionOk: true },
  ]
  assert.deepEqual(startupWarnings(report({ dependencies: deps })), [])
})

test("formatDoctorReport renders missing dependencies with fix hints", () => {
  const deps: readonly DependencyCheck[] = [
    { name: "agent-desktop", installed: false, minimumVersion: "1.1.0", installHint: "npm install -g agent-desktop" },
  ]
  const text = formatDoctorReport(report({ dependencies: deps, stream: { backend: null, reason: "未构建" } }))
  assert.match(text, /agent-desktop.*✖ 未安装/)
  assert.match(text, /npm install -g agent-desktop/)
  assert.match(text, /直播后端.*✖ 不可用/)
})

test("formatDoctorReport short-circuits on non-mac platforms", () => {
  const text = formatDoctorReport(report({ platform: "linux", isMac: false, stream: { backend: "ffmpeg" } }))
  assert.match(text, /linux/)
  assert.match(text, /仅支持 macOS/)
  assert.match(text, /直播后端.*⚠ FFmpeg/)
})

test("startupWarnings and doctor surface the ffmpeg backend tradeoff", () => {
  const r = report({ stream: { backend: "ffmpeg" } })
  const warnings = startupWarnings(r)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /FFmpeg 直播.*键鼠注入/)
  assert.match(formatDoctorReport(r), /直播后端.*⚠ FFmpeg/)
})
