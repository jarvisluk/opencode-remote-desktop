import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function parseSemver(ver) {
  const m = ver.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) throw new Error(`Invalid semver: ${ver}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function bumpSemver(ver, level) {
  const [maj, min, pat] = parseSemver(ver)
  if (level === "major") return `${maj + 1}.0.0`
  if (level === "minor") return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function latestTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*")
  } catch {
    return null
  }
}

function detectBumpLevel(commits, forced) {
  if (forced && forced !== "auto") {
    return forced
  }
  let level = null
  for (const { subject, body } of commits) {
    if (subject.startsWith("chore(release):")) continue
    if (/BREAKING CHANGE:/i.test(body) || /^[a-z]+(\([^)]*\))?!:/.test(subject)) {
      return "major"
    }
    if (/^feat(\([^)]*\))?:/.test(subject)) {
      level = "minor"
      continue
    }
    if (/^(fix|perf|refactor|revert|build|deps)(\([^)]*\))?:/.test(subject)) {
      if (!level) level = "patch"
    }
  }
  return level
}

function readCommitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD"
  const raw = git("log", range, "--format=%x1e%s%x1f%b")
  if (!raw) return []
  return raw
    .split("\x1e")
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f")
      return { subject: subject.trim(), body: body.trim() }
    })
}

function updateFiles(nextVersion) {
  const pkgPath = path.join(root, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  pkg.version = nextVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

  const lockPath = path.join(root, "package-lock.json")
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    lock.version = nextVersion
    if (lock.packages?.[""]) {
      lock.packages[""].version = nextVersion
    }
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")
  }

  const cargoTomlPath = path.join(root, "native/bot-host/Cargo.toml")
  if (existsSync(cargoTomlPath)) {
    const cargoToml = readFileSync(cargoTomlPath, "utf8")
    const updated = cargoToml.replace(
      /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
      `$1${nextVersion}$2`,
    )
    writeFileSync(cargoTomlPath, updated)
  }

  const cargoLockPath = path.join(root, "native/bot-host/Cargo.lock")
  if (existsSync(cargoLockPath)) {
    const cargoLock = readFileSync(cargoLockPath, "utf8")
    const updated = cargoLock.replace(
      /(\[\[package\]\]\nname = "bot-host"\nversion = ")[^"]+(")/,
      `$1${nextVersion}$2`,
    )
    writeFileSync(cargoLockPath, updated)
  }
}

function writeGithubOutput(data) {
  const outFile = process.env.GITHUB_OUTPUT
  if (!outFile) return
  const lines = Object.entries(data).map(([k, v]) => `${k}=${v}`)
  writeFileSync(outFile, lines.join("\n") + "\n", { flag: "a" })
}

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const asIdx = args.indexOf("--as")
const forced = asIdx >= 0 ? args[asIdx + 1] : "auto"

const pkgVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
const tag = latestTag()
const tagVersion = tag ? tag.replace(/^v/, "") : "0.0.0"
const baseVersion = compareSemver(pkgVersion, tagVersion) >= 0 ? pkgVersion : tagVersion

const commits = readCommitsSince(tag)
const headSubject = git("log", "-1", "--format=%s")

let level = null
if (!headSubject.startsWith("chore(release):")) {
  level = detectBumpLevel(commits, forced)
} else if (forced && forced !== "auto") {
  level = forced
}

if (!level) {
  console.log(`No releasable commits since ${tag ?? "beginning"} (HEAD: ${headSubject}). Skipping release.`)
  writeGithubOutput({ should_release: "false", version: baseVersion, tag: `v${baseVersion}` })
  process.exit(0)
}

const nextVersion = bumpSemver(baseVersion, level)
const nextTag = `v${nextVersion}`
console.log(`Bump (${level}): ${baseVersion} -> ${nextVersion} (${commits.length} commit(s) since ${tag ?? "init"})`)

if (!dryRun) {
  updateFiles(nextVersion)
}

writeGithubOutput({
  should_release: "true",
  bump_level: level,
  version: nextVersion,
  tag: nextTag,
})
