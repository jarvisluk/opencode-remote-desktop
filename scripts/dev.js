// Isolated dev loop: rebuilds the GUI bundle and native helpers on change and runs a private
// `opencode serve` that loads only this checkout as a plugin. The server hot-reloads src/*.ts
// and dist/gui-experimental.cjs by itself; reload the browser tab to pick up GUI changes.
//
//   npm run dev                      http://127.0.0.1:49390  (user opencode / password dotbot-dev)
//   DOTBOT_DEV_PORT=49391 npm run dev
//   OPENCODE_BIN=/path/to/opencode-cli npm run dev
import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, watch, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import esbuild from "esbuild"
import { guiBuildOptions } from "./build-gui.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const port = process.env.DOTBOT_DEV_PORT ?? "49390"
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "dotbot-dev"

function findOpencode() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const cliDir = path.join(os.homedir(), "Library/Application Support/ai.opencode.desktop/cli")
  if (existsSync(cliDir)) {
    const latest = readdirSync(cliDir).sort().at(-1)
    const bin = latest && path.join(cliDir, latest, "opencode-cli")
    if (bin && existsSync(bin)) return bin
  }
  return "opencode"
}

// Plugin set comes from this private config dir; the global config is still merged by OpenCode,
// so the dev port must differ from the service port (49374) and its plugin instances.
const configDir = path.join(root, ".dotbot-tmp/devcfg")
mkdirSync(configDir, { recursive: true })
writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ plugins: [root] }, null, 2))

const ctx = await esbuild.context(guiBuildOptions)
await ctx.watch()

let nativeTimer
const rebuildNative = () => {
  clearTimeout(nativeTimer)
  nativeTimer = setTimeout(() => {
    try {
      execFileSync(process.execPath, [path.join(root, "scripts/build-native.js")], { stdio: "inherit" })
      console.log("[dev] native helpers rebuilt; restart the stream from the panel to use them")
    } catch {
      console.error("[dev] native build failed")
    }
  }, 300)
}
if (!existsSync(path.join(root, "dist/bin"))) rebuildNative()
for (const dir of ["native/stream", "native/capture-macos"]) {
  watch(path.join(root, dir), (_event, file) => {
    if (file && /\.(go|swift|mod|sum)$/.test(file)) rebuildNative()
  })
}

const bin = findOpencode()
console.log(`[dev] ${bin} serve on http://127.0.0.1:${port}  (user opencode / password ${password})`)
const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", port, "--print-logs", "--log-level", process.env.OPENCODE_LOG_LEVEL ?? "info"], {
  stdio: "inherit",
  env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, OPENCODE_SERVER_PASSWORD: password },
})

const stop = async () => {
  server.kill("SIGTERM")
  await ctx.dispose()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
server.on("exit", (code) => {
  console.log(`[dev] opencode exited (${code})`)
  void ctx.dispose().then(() => process.exit(code ?? 1))
})
