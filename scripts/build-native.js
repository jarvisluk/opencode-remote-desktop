// Builds the unified Rust host binary into dist/bin for the current platform:
//   bot-host-<platform>-<arch>[.exe]
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const crateDir = path.join(root, "native/bot-host")
const outDir = path.join(root, "dist/bin")
const { platform, arch } = process
const ext = platform === "win32" ? ".exe" : ""
mkdirSync(outDir, { recursive: true })

const targetTriple = process.env.CARGO_BUILD_TARGET?.trim()
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
