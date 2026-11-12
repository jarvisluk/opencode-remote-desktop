import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

const EXTRA_MACOS_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]

const binaryCache = new Map<string, { path: string; timestamp: number }>()
const BINARY_CACHE_TTL_MS = 60_000

export function clearBinaryCache(): void {
  binaryCache.clear()
}

export function buildMacOSPath(): string {
  const existing = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const merged = new Set<string>([...existing, ...EXTRA_MACOS_PATHS])
  return [...merged].join(delimiter)
}

export function resolveBinary(name: string): string | null {
  const cached = binaryCache.get(name)
  const now = Date.now()
  if (cached && now - cached.timestamp < BINARY_CACHE_TTL_MS && existsSync(cached.path)) {
    return cached.path
  }

  const dirs = buildMacOSPath().split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
        binaryCache.set(name, { path: candidate, timestamp: now })
        return candidate
      }
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  binaryCache.delete(name)
  return null
}

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export function runCommand(
  binaryOrName: string,
  args: readonly string[],
  options?: {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
    readonly env?: Record<string, string | undefined>
  },
): Promise<ExecResult> {
  const resolved = binaryOrName.includes("/") ? binaryOrName : resolveBinary(binaryOrName)
  if (!resolved) {
    return Promise.resolve({
      code: 127,
      stdout: "",
      stderr: `Binary not found on macOS PATH: ${binaryOrName}`,
    })
  }

  return new Promise((resolve) => {
    execFile(
      resolved,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 30_000,
        signal: options?.signal,
        env: {
          ...process.env,
          PATH: buildMacOSPath(),
          ...options?.env,
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" })
          return
        }
        const exitCode = typeof error.code === "number" ? error.code : 1
        resolve({
          code: exitCode,
          stdout: stdout ?? "",
          stderr: stderr || error.message,
        })
      },
    )
  })
}
