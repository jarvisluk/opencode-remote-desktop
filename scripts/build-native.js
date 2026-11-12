// Builds the native live-stream helpers into dist/bin for the current platform.
//   dotbot-stream-<platform>-<arch>   Go + pion/webrtc (cross-platform)
//   dotbot-capture-<platform>-<arch>  platform capture/encode/input backend (macOS: Swift)
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "dist/bin")
const { platform, arch } = process
const ext = platform === "win32" ? ".exe" : ""
mkdirSync(out, { recursive: true })

const run = (cmd, args, cwd, env) => {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } })
}

run("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", path.join(out, `dotbot-stream-${platform}-${arch}${ext}`), "."],
  path.join(root, "native/stream"), { CGO_ENABLED: "0" })

if (platform === "darwin") {
  const target = arch === "arm64" ? "arm64-apple-macos13" : "x86_64-apple-macos13"
  run("swiftc", ["-O", "-target", target, "main.swift", "-o", path.join(out, `dotbot-capture-${platform}-${arch}`)],
    path.join(root, "native/capture-macos"))
} else {
  console.warn(`No capture backend for ${platform} yet; the panel will fall back to JPEG polling.`)
}
