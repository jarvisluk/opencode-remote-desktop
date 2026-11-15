// Prepares per-platform npm package directories under dist/npm-packages/host-<os>-<arch>
// from binaries in dist/bin/ (or --from <dir>).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

const TARGETS = [
  { platform: "darwin", arch: "arm64", ext: "" },
  { platform: "darwin", arch: "x64", ext: "" },
  { platform: "win32", arch: "x64", ext: ".exe" },
  { platform: "win32", arch: "arm64", ext: ".exe" },
  { platform: "linux", arch: "x64", ext: "" },
  { platform: "linux", arch: "arm64", ext: "" },
]

const fromArgIdx = process.argv.indexOf("--from")
const srcDir = fromArgIdx >= 0 && process.argv[fromArgIdx + 1]
  ? path.resolve(process.argv[fromArgIdx + 1])
  : path.join(root, "dist/bin")

const outBase = path.join(root, "dist/npm-packages")
rmSync(outBase, { recursive: true, force: true })
mkdirSync(outBase, { recursive: true })

let prepared = 0
for (const { platform, arch, ext } of TARGETS) {
  const srcBin = path.join(srcDir, `bot-host-${platform}-${arch}${ext}`)
  if (!existsSync(srcBin)) continue

  const pkgDir = path.join(outBase, `host-${platform}-${arch}`)
  const binDir = path.join(pkgDir, "bin")
  mkdirSync(binDir, { recursive: true })

  const destBin = path.join(binDir, `bot-host${ext}`)
  copyFileSync(srcBin, destBin)
  if (platform !== "win32") {
    chmodSync(destBin, 0o755)
  }

  const pkgName = `@opencode-bot/host-${platform}-${arch}`
  const manifest = {
    name: pkgName,
    version: rootPkg.version,
    description: `Prebuilt bot-host native binary for ${platform}-${arch} (opencode-remote-desktop).`,
    license: rootPkg.license ?? "MIT",
    repository: rootPkg.repository,
    os: [platform],
    cpu: [arch],
    files: ["bin", "README.md"],
    exports: {
      "./package.json": "./package.json",
    },
    publishConfig: rootPkg.publishConfig ?? { access: "public" },
  }
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  writeFileSync(
    path.join(pkgDir, "README.md"),
    `# ${pkgName}\n\nPlatform binary package for [opencode-remote-desktop](https://github.com/jarvisluk/opencode-remote-desktop).\n`,
  )
  prepared++
  console.log(`Prepared ${pkgName} (${path.relative(root, pkgDir)})`)
}

if (prepared === 0) {
  throw new Error(`No bot-host binaries found in ${srcDir}`)
}
