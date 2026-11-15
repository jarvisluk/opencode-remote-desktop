import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  downloadHostBinary,
  getPackageVersion,
  isSupportedHostTarget,
  resolveHostBinarySync,
} from "../src/host/release.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function main() {
  if (process.env.OPENCODE_BOT_SKIP_DOWNLOAD === "1") {
    return
  }
  if (!isSupportedHostTarget()) {
    return
  }
  if (resolveHostBinarySync(repoRoot)) {
    return
  }

  const version = getPackageVersion(repoRoot)
  try {
    const dest = await downloadHostBinary({ repoRoot, version })
    console.log(`[opencode-remote-desktop] Downloaded bot-host v${version} to ${dest}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[opencode-remote-desktop] Skipping prebuilt bot-host download (${msg}). Will retry on first use or build locally with \`npm run build:native\`.`)
  }
}

await main()
