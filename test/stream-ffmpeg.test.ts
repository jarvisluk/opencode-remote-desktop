import test from "node:test"
import assert from "node:assert/strict"
import {
  buildFfmpegArgs,
  defaultInputArgs,
  pickStreamBackend,
} from "../src/stream/ffmpeg.ts"

test("defaultInputArgs per platform", () => {
  const win = defaultInputArgs("win32", 30)
  assert.ok(win.includes("gdigrab") && win.includes("desktop"))
  const linux = defaultInputArgs("linux", 30)
  assert.ok(linux.includes("x11grab") && linux.includes(":0.0"))
  const mac = defaultInputArgs("darwin", 30)
  assert.ok(mac.includes("avfoundation"))
})

test("buildFfmpegArgs uses platform defaults and correct encoder settings", () => {
  const args = buildFfmpegArgs({ fps: 30, bitrate: 2_000_000, maxDimension: 1280, platform: "linux" })
  const input = args.slice(0, args.indexOf("-vf"))
  assert.ok(input.includes("x11grab") && input.includes(":0.0"))
  assert.ok(args.includes("-framerate") && args.includes("30"))
  // encoder: baseline, zerolatency, GOP = fps*2
  assert.ok(args.includes("-c:v") && args.includes("libx264"))
  assert.ok(args.includes("-profile:v") && args.includes("baseline"))
  assert.ok(args.includes("-tune") && args.includes("zerolatency"))
  const g = args.indexOf("-g")
  assert.equal(args[g + 1], "60")
  const bv = args.indexOf("-b:v")
  assert.equal(args[bv + 1], "2000000")
  // scale caps the longest edge
  const vf = args[args.indexOf("-vf") + 1]
  assert.match(vf, /scale=/)
  assert.match(vf, /1280/)
  // raw pipe
  assert.equal(args[args.length - 1], "pipe:1")
  assert.ok(args.includes("-f") && args.includes("h264"))
  assert.ok(args.includes("-nostdin"))
})

test("ffmpegInputArgs override replaces the platform default", () => {
  const args = buildFfmpegArgs({
    fps: 30,
    bitrate: 2_000_000,
    maxDimension: 1280,
    platform: "win32",
    inputArgs: ["-f", "lavfi", "-i", "testsrc"],
  })
  const input = args.slice(0, args.indexOf("-vf"))
  assert.match(input.join(" "), /lavfi.*testsrc/)
  assert.ok(!input.includes("gdigrab"))
})

test("pickStreamBackend auto prefers native on macOS", () => {
  const r = pickStreamBackend({
    preference: "auto",
    platform: "darwin",
    nativeBinariesAvailable: true,
    ffmpegPath: "/usr/bin/ffmpeg",
  })
  assert.equal(r.backend, "native")
})

test("pickStreamBackend auto falls back to ffmpeg", () => {
  const r = pickStreamBackend({
    preference: "auto",
    platform: "darwin",
    nativeBinariesAvailable: false,
    ffmpegPath: "/usr/bin/ffmpeg",
  })
  assert.equal(r.backend, "ffmpeg")
  assert.equal(r.ffmpegPath, "/usr/bin/ffmpeg")
})

test("pickStreamBackend auto uses ffmpeg on linux even with native binaries", () => {
  const r = pickStreamBackend({
    preference: "auto",
    platform: "linux",
    nativeBinariesAvailable: true,
    ffmpegPath: "/usr/bin/ffmpeg",
  })
  assert.equal(r.backend, "ffmpeg")
})

test("pickStreamBackend auto reports why nothing is available", () => {
  const r = pickStreamBackend({
    preference: "auto",
    platform: "linux",
    nativeBinariesAvailable: false,
    ffmpegPath: null,
  })
  assert.equal(r.backend, null)
  assert.match(r.reason ?? "", /ffmpeg/)
})

test("pickStreamBackend honors explicit preferences", () => {
  assert.equal(
    pickStreamBackend({ preference: "ffmpeg", platform: "darwin", nativeBinariesAvailable: true, ffmpegPath: "/opt/ffmpeg" }).backend,
    "ffmpeg",
  )
  assert.equal(
    pickStreamBackend({ preference: "native", platform: "linux", nativeBinariesAvailable: false, ffmpegPath: "/usr/bin/ffmpeg" }).backend,
    null,
  )
  assert.equal(
    pickStreamBackend({ preference: "ffmpeg", platform: "linux", nativeBinariesAvailable: false, ffmpegPath: null }).backend,
    null,
  )
})
