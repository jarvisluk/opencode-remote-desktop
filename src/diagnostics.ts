import { resolveBinary, runCommand } from "./macos/exec.ts"
import { getMacDesktopStatus } from "./macos/desktop.ts"
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
  "npm install -g agent-desktop (or: brew install agent-desktop), then `agent-desktop permissions --guide` 授予辅助功能与录屏权限"
export const AGENT_BROWSER_INSTALL_HINT =
  "npm install -g agent-browser && agent-browser install (or: brew install agent-browser)"

const ACCESSIBILITY_HINT =
  "系统设置 → 隐私与安全性 → 辅助功能，为宿主终端/OpenCode 进程勾选；或运行 `agent-desktop permissions --guide`。"
const SCREEN_RECORDING_HINT = "系统设置 → 隐私与安全性 → 屏幕录制，为宿主终端/OpenCode 进程勾选后重启会话。"
const SIDECAR_HINT = "在插件目录运行 `npm run build:native`（需要 Go，macOS 另需 swiftc）。"

export interface DependencyCheck {
  readonly name: string
  readonly installed: boolean
  readonly version?: string
  readonly versionOk?: boolean
  readonly minimumVersion?: string
  readonly installHint?: string
}

export interface DiagnosticsPermissions {
  readonly accessibility: string
  readonly screenRecording: string
}

export interface StreamBackendInfo {
  /** "native" = bot-capture (framed contract), "ffmpeg" = raw Annex-B pipe, null = unavailable. */
  readonly backend: "native" | "ffmpeg" | null
  /** Set when backend is null. */
  readonly reason?: string
}

export interface DiagnosticsReport {
  readonly platform: string
  readonly isMac: boolean
  readonly dependencies: readonly DependencyCheck[]
  /** TCC permission states; null when unknown (CLI missing) or non-mac. */
  readonly permissions: DiagnosticsPermissions | null
  readonly stream: StreamBackendInfo
}

export interface HealthIssue {
  readonly component: string
  readonly problem: string
  readonly hint: string
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

/**
 * One-shot dependency probe: CLI presence + versions, TCC permissions and
 * the selected live-stream backend. Fast-fails, never throws.
 */
export async function collectDiagnostics(
  signal?: AbortSignal,
  stream?: { backend?: "auto" | "native" | "ffmpeg" },
): Promise<DiagnosticsReport> {
  const isMac = process.platform === "darwin"
  const dependencies = isMac
    ? await Promise.all([
        checkCli("agent-desktop", MIN_AGENT_DESKTOP_VERSION, AGENT_DESKTOP_INSTALL_HINT, signal),
        checkCli("agent-browser", MIN_AGENT_BROWSER_VERSION, AGENT_BROWSER_INSTALL_HINT, signal),
      ])
    : []

  let permissions: DiagnosticsPermissions | null = null
  if (isMac && dependencies[0]?.installed) {
    // TCC permission states are macOS-only; on other platforms getMacDesktopStatus
    // reports "unsupported" and must not be treated as a permission problem.
    const status = await getMacDesktopStatus(signal).catch(() => null)
    if (status) {
      permissions = { accessibility: status.accessibility, screenRecording: status.screenRecording }
    }
  }

  return {
    platform: process.platform,
    isMac,
    dependencies,
    permissions,
    stream: StreamSidecar.probe(stream),
  }
}

/** Derives actionable issues from a report (no extra probing). */
export function collectHealthIssues(report: DiagnosticsReport): HealthIssue[] {
  const issues: HealthIssue[] = []
  for (const dep of report.dependencies) {
    if (!dep.installed) {
      issues.push({ component: dep.name, problem: "CLI 未安装（PATH 未找到）", hint: `运行 \`${dep.installHint}\`。` })
    } else if (dep.versionOk === false) {
      issues.push({
        component: dep.name,
        problem: `已安装 ${dep.version}，低于已验证版本 ${dep.minimumVersion}，CLI 契约可能不兼容`,
        hint: `升级：\`${dep.installHint}\`。`,
      })
    }
  }
  if (report.permissions) {
    if (report.permissions.accessibility !== "granted") {
      issues.push({
        component: "辅助功能权限 (Accessibility)",
        problem: `当前状态 \`${report.permissions.accessibility}\`，桌面语义操作将失败`,
        hint: ACCESSIBILITY_HINT,
      })
    }
    if (report.permissions.screenRecording !== "granted") {
      issues.push({
        component: "屏幕录制权限 (Screen Recording)",
        problem: `当前状态 \`${report.permissions.screenRecording}\`，截屏/直播将失败`,
        hint: SCREEN_RECORDING_HINT,
      })
    }
  }
  if (!report.stream.backend) {
    issues.push({
      component: "实时画面后端",
      problem: `无可用采集后端（${report.stream.reason ?? "未知原因"}），直播将降级为低帧率 JPEG 轮询`,
      hint: SIDECAR_HINT,
    })
  } else if (report.stream.backend === "ffmpeg") {
    issues.push({
      component: "实时画面后端",
      problem: "使用 FFmpeg 直播：观看可用，但接管期间无键鼠注入（输入将走 agent-desktop RPC 降级路径，延迟较高）",
      hint: "macOS 上可构建原生后端获得完整能力：`npm run build:native`。",
    })
  }
  return issues
}

/** Startup warnings for missing/mismatched pieces; empty array = all healthy. */
export function startupWarnings(report: DiagnosticsReport): string[] {
  return collectHealthIssues(report).map((issue) => `[bot] ${issue.component}: ${issue.problem} Fix: ${issue.hint}`)
}

/** Human-readable `/doctor` output. */
export function formatDoctorReport(report: DiagnosticsReport): string {
  const lines = [`### Bot Doctor — 依赖体检`]
  if (!report.isMac) {
    lines.push(
      `- **平台**: \`${report.platform}\` — 桌面控制当前仅支持 macOS（已降级关闭）。`,
    )
    lines.push(streamLine(report))
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
  if (report.permissions) {
    lines.push(`- **辅助功能权限 (Accessibility)**: \`${report.permissions.accessibility}\``)
    lines.push(`- **屏幕录制权限 (Screen Recording)**: \`${report.permissions.screenRecording}\``)
    if (report.permissions.accessibility !== "granted") lines.push(`  - 修复: ${ACCESSIBILITY_HINT}`)
    if (report.permissions.screenRecording !== "granted") lines.push(`  - 修复: ${SCREEN_RECORDING_HINT}`)
  }
  lines.push(streamLine(report))
  return lines.join("\n")
}

function streamLine(report: DiagnosticsReport): string {
  if (report.stream.backend === "native") {
    return "- **直播后端**: ✔ 原生 bot-capture（WebRTC 低延迟 + 键鼠注入）"
  }
  if (report.stream.backend === "ffmpeg") {
    return "- **直播后端**: ⚠ FFmpeg（观看可用，接管键鼠注入走降级路径）。macOS 完整能力：`npm run build:native`"
  }
  return `- **直播后端**: ✖ 不可用（${report.stream.reason ?? "未知原因"}），实时画面降级为 JPEG 轮询。${SIDECAR_HINT}`
}
