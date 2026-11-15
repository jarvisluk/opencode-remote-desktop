// Builds the unified Rust host binary into dist/bin for the current platform:
//   bot-host-<platform>-<arch>[.exe]
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const crateDir = path.join(root, "native/bot-host")
const outDir = path.join(root, "dist/bin")
const { platform: hostPlatform, arch: hostArch } = process
const targetTriple = process.env.CARGO_BUILD_TARGET?.trim()

function resolveTarget(triple) {
  switch (triple) {
    case "aarch64-apple-darwin":
      return { platform: "darwin", arch: "arm64", ext: "" }
    case "x86_64-apple-darwin":
      return { platform: "darwin", arch: "x64", ext: "" }
    case "x86_64-pc-windows-msvc":
      return { platform: "win32", arch: "x64", ext: ".exe" }
    case "aarch64-pc-windows-msvc":
      return { platform: "win32", arch: "arm64", ext: ".exe" }
    case "x86_64-unknown-linux-gnu":
      return { platform: "linux", arch: "x64", ext: "" }
    case "aarch64-unknown-linux-gnu":
      return { platform: "linux", arch: "arm64", ext: "" }
    default:
      return { platform: hostPlatform, arch: hostArch, ext: hostPlatform === "win32" ? ".exe" : "" }
  }
}

const { platform, arch, ext } = resolveTarget(targetTriple)
mkdirSync(outDir, { recursive: true })

const args = ["build", "--release"]
if (targetTriple) {
  args.push("--target", targetTriple)
}

console.log(`$ cargo ${args.join(" ")}`)
execFileSync("cargo", args, { cwd: crateDir, stdio: "inherit" })

const targetDir = targetTriple
  ? path.join(crateDir, "target", targetTriple, "release")
  : path.join(crateDir, "target", "release")
const built = path.join(targetDir, `bot-host${ext}`)
if (!existsSync(built)) {
  throw new Error(`Expected release binary not found at ${built}`)
}

const dest = path.join(outDir, `bot-host-${platform}-${arch}${ext}`)
const tmpDest = `${dest}.tmp-${process.pid}`
copyFileSync(built, tmpDest)
if (platform !== "win32") {
  chmodSync(tmpDest, 0o755)
}
rmSync(dest, { force: true })
renameSync(tmpDest, dest)
console.log(`Built ${path.relative(root, dest)}`)
