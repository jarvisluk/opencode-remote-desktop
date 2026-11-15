import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_SLUG = "jarvisluk/opencode-remote-desktop"
const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
])

let cachedPkgVersion

export function getDefaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
}

export function getPackageVersion(repoRoot = getDefaultRepoRoot()) {
  if (cachedPkgVersion && repoRoot === getDefaultRepoRoot()) {
    return cachedPkgVersion
  }
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  const ver = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0"
  if (repoRoot === getDefaultRepoRoot()) {
    cachedPkgVersion = ver
  }
  return ver
}

export function isSupportedHostTarget(platform = process.platform, arch = process.arch) {
  return SUPPORTED_TARGETS.has(`${platform}-${arch}`)
}

export function hostAssetName(platform = process.platform, arch = process.arch) {
  const ext = platform === "win32" ? ".exe" : ""
  return `bot-host-${platform}-${arch}${ext}`
}

export function getReleaseBaseUrl(version = getPackageVersion()) {
  const override = process.env.OPENCODE_BOT_HOST_RELEASE_BASE?.trim()
  if (override) {
    return override.replace(/\/+$/, "")
  }
  return `https://github.com/${REPO_SLUG}/releases/download/v${version}`
}

export function getHostCacheDir(version = getPackageVersion(), platform = process.platform) {
  const override = process.env.OPENCODE_BOT_HOST_CACHE_DIR?.trim()
  if (override) {
    return path.join(override, `v${version}`)
  }
  let base = process.env.XDG_CACHE_HOME?.trim()
  if (!base) {
    if (platform === "win32") {
      base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")
    } else if (platform === "darwin") {
      base = path.join(os.homedir(), "Library", "Caches")
    } else {
      base = path.join(os.homedir(), ".cache")
    }
  }
  return path.join(base, "opencode-remote-desktop", `v${version}`)
}

export function getCachedHostBinaryPath(
  platform = process.platform,
  arch = process.arch,
  version = getPackageVersion(),
) {
  return path.join(getHostCacheDir(version, platform), hostAssetName(platform, arch))
}

export function resolveHostBinarySync(
  repoRoot = getDefaultRepoRoot(),
  platform = process.platform,
  arch = process.arch,
) {
  const envBin = process.env.OPENCODE_BOT_HOST_BIN?.trim()
  if (envBin && existsSync(envBin)) {
    return envBin
  }

  const asset = hostAssetName(platform, arch)
  const localBin = path.join(repoRoot, "dist", "bin", asset)
  if (existsSync(localBin)) {
    return localBin
  }

  const cachedBin = getCachedHostBinaryPath(platform, arch, getPackageVersion(repoRoot))
  if (existsSync(cachedBin)) {
    return cachedBin
  }

  if (platform === process.platform && arch === process.arch) {
    const ext = platform === "win32" ? ".exe" : ""
    const cargoBin = path.join(repoRoot, "native", "bot-host", "target", "release", `bot-host${ext}`)
    if (existsSync(cargoBin)) {
      return cargoBin
    }
  }

  return null
}

export function parseSha256Sums(text) {
  const map = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^([a-fA-F0-9]{64})\s+[* ]?(.+)$/)
    if (!match) continue
    const hash = match[1].toLowerCase()
    const file = path.basename(match[2].trim())
    map.set(file, hash)
  }
  return map
}

export async function downloadHostBinary(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const repoRoot = options.repoRoot ?? getDefaultRepoRoot()
  const version = options.version ?? getPackageVersion(repoRoot)

  if (!isSupportedHostTarget(platform, arch)) {
    throw new Error(`Unsupported bot-host target: ${platform}-${arch}`)
  }

  const asset = hostAssetName(platform, arch)
  const destPath = options.destPath ?? getCachedHostBinaryPath(platform, arch, version)
  if (existsSync(destPath)) {
    return destPath
  }

  const baseUrl = (options.baseUrl ?? getReleaseBaseUrl(version)).replace(/\/+$/, "")
  const sumsRes = await fetch(`${baseUrl}/SHA256SUMS.txt`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  })
  if (!sumsRes.ok) {
    throw new Error(`Failed to fetch SHA256SUMS.txt (${sumsRes.status} ${sumsRes.statusText})`)
  }
  const sums = parseSha256Sums(await sumsRes.text())
  const expectedSha = sums.get(asset)
  if (!expectedSha) {
    throw new Error(`SHA256SUMS.txt does not contain checksum for ${asset}`)
  }

  const binRes = await fetch(`${baseUrl}/${asset}`, {
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  })
  if (!binRes.ok) {
    throw new Error(`Failed to download ${asset} (${binRes.status} ${binRes.statusText})`)
  }
  const data = Buffer.from(await binRes.arrayBuffer())
  const actualSha = createHash("sha256").update(data).digest("hex")
  if (actualSha !== expectedSha) {
    throw new Error(`SHA-256 mismatch for ${asset}: expected ${expectedSha}, got ${actualSha}`)
  }

  mkdirSync(path.dirname(destPath), { recursive: true })
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmpPath, data)
    if (platform !== "win32") {
      chmodSync(tmpPath, 0o755)
    }
    rmSync(destPath, { force: true })
    renameSync(tmpPath, destPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }

  return destPath
}
