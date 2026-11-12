import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveBinary, runCommand } from "./exec.ts"

export interface HostBrowserEndpoint {
  readonly browser: "Microsoft Edge" | "Google Chrome"
  readonly wsUrl: string
}

const DEVTOOLS_PORT_FILES: ReadonlyArray<{
  readonly browser: "Microsoft Edge" | "Google Chrome"
  readonly path: string
}> = [
  {
    browser: "Microsoft Edge",
    path: join(homedir(), "Library", "Application Support", "Microsoft Edge", "DevToolsActivePort"),
  },
  {
    browser: "Google Chrome",
    path: join(homedir(), "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort"),
  },
]

export async function discoverHostCdpEndpoint(): Promise<HostBrowserEndpoint | null> {
  for (const candidate of DEVTOOLS_PORT_FILES) {
    if (!existsSync(candidate.path)) continue
    try {
      const raw = await readFile(candidate.path, "utf8")
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (lines.length >= 2) {
        const port = Number(lines[0])
        const wsPath = lines[1]
        if (Number.isInteger(port) && port > 0 && wsPath.startsWith("/")) {
          return {
            browser: candidate.browser,
            wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
          }
        }
      }
    } catch {
      // Try next browser candidate.
    }
  }
  return null
}

export class MacBrowserController {
  private connectedWsUrl: string | null = null
  private connectedBrowserName: string = "isolated"
  private readonly reuseHostBrowser: boolean

  constructor(reuseHostBrowser: boolean) {
    this.reuseHostBrowser = reuseHostBrowser
  }

  get modeDescription(): string {
    if (!resolveBinary("agent-browser")) return "missing_agent_browser"
    return this.connectedWsUrl ? `host-cdp:${this.connectedBrowserName}` : "managed-or-idle"
  }

  async ensureConnected(signal?: AbortSignal): Promise<{ readonly mode: string; readonly warning?: string }> {
    const bin = resolveBinary("agent-browser")
    if (!bin) {
      throw new Error("agent-browser is not installed on this macOS server.")
    }

    if (!this.reuseHostBrowser) {
      return { mode: "isolated" }
    }

    const endpoint = await discoverHostCdpEndpoint()
    if (!endpoint) {
      return {
        mode: "isolated-fallback",
        warning:
          "No DevToolsActivePort found for Microsoft Edge or Chrome; running in standalone agent-browser session. Enable edge://inspect/#remote-debugging on the Mac to reuse signed-in tabs.",
      }
    }

    if (this.connectedWsUrl === endpoint.wsUrl) {
      return { mode: `host-cdp:${endpoint.browser}` }
    }

    const res = await runCommand(bin, ["connect", endpoint.wsUrl], { timeoutMs: 12_000, signal })
    if (res.code === 0) {
      this.connectedWsUrl = endpoint.wsUrl
      this.connectedBrowserName = endpoint.browser
      return { mode: `host-cdp:${endpoint.browser}` }
    }

    this.connectedWsUrl = null
    return {
      mode: "isolated-fallback",
      warning: `Could not connect to ${endpoint.browser} CDP (${res.stderr.trim() || res.stdout.trim()}); falling back to standalone browser.`,
    }
  }

  async run(args: readonly string[], options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly output: string
    readonly mode: string
    readonly warning?: string
  }> {
    const bin = resolveBinary("agent-browser")
    if (!bin) {
      return {
        ok: false,
        output: "agent-browser binary not found on macOS PATH.",
        mode: "missing",
      }
    }

    const conn = await this.ensureConnected(options?.signal)
    const res = await runCommand(bin, args, {
      timeoutMs: options?.timeoutMs ?? 30_000,
      signal: options?.signal,
    })

    // If a stale CDP socket dropped after browser restart, reconnect once
    if (res.code !== 0 && this.connectedWsUrl) {
      this.connectedWsUrl = null
      const retryConn = await this.ensureConnected(options?.signal)
      const retryRes = await runCommand(bin, args, {
        timeoutMs: options?.timeoutMs ?? 30_000,
        signal: options?.signal,
      })
      return {
        ok: retryRes.code === 0,
        output: (retryRes.stdout || retryRes.stderr).trim(),
        mode: retryConn.mode,
        warning: retryConn.warning,
      }
    }

    return {
      ok: res.code === 0,
      output: (res.stdout || res.stderr).trim(),
      mode: conn.mode,
      warning: conn.warning,
    }
  }
}
