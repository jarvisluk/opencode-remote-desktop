import { resolveBinary, runCommand } from "./macos/exec.ts"
import { StreamSidecar } from "./stream/sidecar.ts"

/**
 * Minimum CLI versions verified against this plugin's command usage.
 * agent-desktop / agent-browser are 0.x/1.x fast-moving projects; bump these
 * whenever the CLI argument contract changes and the plugin is re-verified.
 */
export const MIN_AGENT_DESKTOP_VERSION = "1.1.0"
export const MIN_AGENT_BROWSER_VERSION = "0.41.1"

/** Official install commands (verified against vercel-labs READMEs, 2026-11). */
export const AGENT_DESKTOP_INSTALL_HINT =
  "npm install -g agent-desktop (or: brew install agent-desktop), then grant Accessibility & Screen Recording"
export const AGENT_BROWSER_INSTALL_HINT =
  "npm install -g agent-browser && agent-browser install (or: brew install agent-browser)"

export interface DependencyCheck {
  readonly name: string
  readonly installed: boolean
  readonly version?: string
  readonly versionOk?: boolean
  readonly minimumVersion?: string
  readonly installHint?: string
}

export interface DiagnosticsReport {
  readonly platform: string
  readonly isMac: boolean
  readonly dependencies: readonly DependencyCheck[]
  readonly sidecarAvailable: boolean
}

/** Lenient semver-ish parse: takes the first `N.N[.N]` found in raw output. */
export function parseVersion(raw: string): string | null {
  const m = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? `${m[1]}.${m[2]}.${m[3] ?? "0"}` : null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

async function checkCli(
  name: string,
  minimumVersion: string,
  installHint: string,
  signal?: AbortSignal,
): Promise<DependencyCheck> {
  const bin = resolveBinary(name)
  if (!bin) return { name, installed: false, minimumVersion, installHint }
  const version = await runCommand(bin, ["--version"], { timeoutMs: 5_000, signal })
    .then((res) => (res.code === 0 ? parseVersion(`${res.stdout}${res.stderr}`) : null))
    .catch(() => null)
  return {
    name,
    installed: true,
    version: version ?? undefined,
    versionOk: version ? compareVersions(version, minimumVersion) >= 0 : undefined,
    minimumVersion,
    installHint,
  }
}

/** Probes external CLIs and native sidecar binaries. Fast-fails, never throws. */
export async function collectDiagnostics(signal?: AbortSignal): Promise<DiagnosticsReport> {
  const isMac = process.platform === "darwin"
  const dependencies = isMac
    ? await Promise.all([
        checkCli("agent-desktop", MIN_AGENT_DESKTOP_VERSION, AGENT_DESKTOP_INSTALL_HINT, signal),
        checkCli("agent-browser", MIN_AGENT_BROWSER_VERSION, AGENT_BROWSER_INSTALL_HINT, signal),
      ])
    : []
  return {
    platform: process.platform,
    isMac,
    dependencies,
    sidecarAvailable: StreamSidecar.available(),
  }
}

/** Startup warnings for missing/mismatched pieces; empty array = all healthy. */
export function startupWarnings(report: DiagnosticsReport): string[] {
  const warnings: string[] = []
  for (const dep of report.dependencies) {
    if (!dep.installed) {
      warnings.push(`[bot] Missing dependency: ${dep.name}. Fix: ${dep.installHint}`)
    } else if (dep.versionOk === false) {
      warnings.push(
        `[bot] ${dep.name} ${dep.version} is below the verified minimum ${dep.minimumVersion}; CLI commands may fail. Upgrade: ${dep.installHint}`,
      )
    }
  }
  if (report.isMac && !report.sidecarAvailable) {
    warnings.push(
      "[bot] Native live-stream helpers not built (dist/bin); live view falls back to JPEG polling. Run `npm run build:native` in the plugin directory.",
    )
  }
  return warnings
}

/** Human-readable `/doctor` output. */
export function formatDoctorReport(report: DiagnosticsReport): string {
  const lines = [`### Bot Doctor — 依赖体检`]
  if (!report.isMac) {
    lines.push(`- **平台**: \`${report.platform}\` — 桌面控制当前仅支持 macOS，其余功能已降级关闭。`)
    return lines.join("\n")
  }
  for (const dep of report.dependencies) {
    const state = !dep.installed
      ? "✖ 未安装"
      : dep.versionOk === false
        ? `⚠ 已安装 ${dep.version}（低于已验证版本 ${dep.minimumVersion}）`
        : `✔ ${dep.version ?? "已安装"}`
    lines.push(`- **${dep.name}**: ${state}`)
    if (!dep.installed || dep.versionOk === false) {
      lines.push(`  - 修复: \`${dep.installHint}\``)
    }
  }
  lines.push(
    report.sidecarAvailable
      ? "- **原生直播 sidecar (dist/bin)**: ✔ 已构建（WebRTC 低延迟模式可用）"
      : "- **原生直播 sidecar (dist/bin)**: ✖ 未构建，实时画面降级为 JPEG 轮询。运行 `npm run build:native`（需 Go + swiftc）。",
  )
  return lines.join("\n")
}
