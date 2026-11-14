import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { BotOptions } from "../options.ts"

function readJson(path: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** The OpenCode remote-access tunnel URL (`opencode service set remote true`), if one is set up. */
export function detectTunnelUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const route = readJson(join(config, "opencode", "service.json"))?.remote?.route
  const hostname = readJson(join(data, "opentunnel", "default", "tunnel.json"))?.hostname
  return typeof route === "string" && typeof hostname === "string" ? `https://${route}.${hostname}` : undefined
}

/** Link to the static console page; it carries no credentials, the server password is entered in the page. */
export function consoleLink(options: BotOptions, sessionID?: string): string | undefined {
  const server = options.serverUrl ?? detectTunnelUrl()
  if (!options.consoleUrl || !server) return undefined
  const hash = new URLSearchParams({ server, ...(sessionID ? { session: sessionID } : {}) })
  return `${options.consoleUrl}/#${hash}`
}
