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

/** The OpenCode server connection key (base64 of user:password) from service.json, for pairing links. */
function connectionKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const password = readJson(join(config, "opencode", "service.json"))?.password
  return typeof password === "string" && password ? Buffer.from(`opencode:${password}`).toString("base64") : undefined
}

/** Link to the static console page. Without `pair` it carries no credentials; with it, the connection key rides in the fragment. */
export function consoleLink(options: BotOptions, sessionID?: string, pair = false): string | undefined {
  const server = options.serverUrl ?? detectTunnelUrl()
  if (!options.consoleUrl || !server) return undefined
  const auth = pair ? connectionKey() : undefined
  const hash = new URLSearchParams({ server, ...(sessionID ? { session: sessionID } : {}), ...(auth ? { auth } : {}) })
  return `${options.consoleUrl}/#${hash}`
}
