import { resolveBinary, runCommand } from "./macos/exec.ts"
import { getMacDesktopStatus } from "./macos/desktop.ts"
import { StreamSidecar } from "./stream/sidecar.ts"
import { resolveLocale, type SupportedLocale } from "./i18n/locale.ts"
import { tServer } from "./i18n/server.ts"

/**
 * Minimum CLI versions verified against this plugin's command usage.
 * agent-desktop / agent-browser are 0.x/1.x fast-moving projects; bump these
 * whenever the CLI argument contract changes and the plugin is re-verified.
 */
export const MIN_AGENT_DESKTOP_VERSION = "1.1.0"
export const MIN_AGENT_BROWSER_VERSION = "0.41.1"

/** Official install commands (verified against vercel-labs READMEs, 2026-11). */
export const AGENT_DESKTOP_INSTALL_HINT =
  "npm install -g agent-desktop (or: brew install agent-desktop), then run `agent-desktop permissions --guide`"
export const AGENT_BROWSER_INSTALL_HINT =
  "npm install -g agent-browser && agent-browser install (or: brew install agent-browser)"

export function getAgentDesktopInstallHint(locale: SupportedLocale = resolveLocale()): string {
  return tServer(locale, "diag.agentDesktopInstallHint")
}

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
  stream?: { backend?: "auto" | "native" | "ffmpeg"; locale?: SupportedLocale },
): Promise<DiagnosticsReport> {
  const locale = stream?.locale ?? resolveLocale()
  const isMac = process.platform === "darwin"
  const dependencies = isMac
    ? await Promise.all([
        checkCli("agent-desktop", MIN_AGENT_DESKTOP_VERSION, getAgentDesktopInstallHint(locale), signal),
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
    stream: StreamSidecar.probe({ backend: stream?.backend, locale }),
  }
}

/** Derives actionable issues from a report (no extra probing). */
export function collectHealthIssues(
  report: DiagnosticsReport,
  locale: SupportedLocale = resolveLocale(),
): HealthIssue[] {
  const issues: HealthIssue[] = []
  for (const dep of report.dependencies) {
    if (!dep.installed) {
      issues.push({
        component: dep.name,
        problem: tServer(locale, "diag.depNotInstalledProblem"),
        hint: tServer(locale, "diag.depNotInstalledHint", { installHint: dep.installHint ?? "" }),
      })
    } else if (dep.versionOk === false) {
      issues.push({
        component: dep.name,
        problem: tServer(locale, "diag.depOutdatedProblem", {
          version: dep.version ?? "",
          minimumVersion: dep.minimumVersion ?? "",
        }),
        hint: tServer(locale, "diag.depOutdatedHint", { installHint: dep.installHint ?? "" }),
      })
    }
  }
  if (report.permissions) {
    if (report.permissions.accessibility !== "granted") {
      issues.push({
        component: tServer(locale, "diag.accessibilityComponent"),
        problem: tServer(locale, "diag.accessibilityProblem", { state: report.permissions.accessibility }),
        hint: tServer(locale, "diag.accessibilityHint"),
      })
    }
    if (report.permissions.screenRecording !== "granted") {
      issues.push({
        component: tServer(locale, "diag.screenRecordingComponent"),
        problem: tServer(locale, "diag.screenRecordingProblem", { state: report.permissions.screenRecording }),
        hint: tServer(locale, "diag.screenRecordingHint"),
      })
    }
  }
  if (!report.stream.backend) {
    issues.push({
      component: tServer(locale, "diag.streamComponent"),
      problem: tServer(locale, "diag.streamUnavailableProblem", {
        reason: report.stream.reason ?? tServer(locale, "diag.unknownReason"),
      }),
      hint: tServer(locale, "diag.sidecarHint"),
    })
  } else if (report.stream.backend === "ffmpeg") {
    issues.push({
      component: tServer(locale, "diag.streamComponent"),
      problem: tServer(locale, "diag.streamFfmpegProblem"),
      hint: tServer(locale, "diag.streamFfmpegHint"),
    })
  }
  return issues
}

/** Startup warnings for missing/mismatched pieces; empty array = all healthy. */
export function startupWarnings(
  report: DiagnosticsReport,
  locale: SupportedLocale = resolveLocale(),
): string[] {
  return collectHealthIssues(report, locale).map((issue) =>
    tServer(locale, "diag.startupWarning", {
      component: issue.component,
      problem: issue.problem,
      hint: issue.hint,
    }),
  )
}

/** Human-readable `/doctor` output. */
export function formatDoctorReport(
  report: DiagnosticsReport,
  locale: SupportedLocale = resolveLocale(),
): string {
  const lines = [tServer(locale, "doctor.title")]
  if (!report.isMac) {
    lines.push(tServer(locale, "doctor.nonMacPlatform", { platform: report.platform }))
    lines.push(streamLine(report, locale))
    return lines.join("\n")
  }
  for (const dep of report.dependencies) {
    const state = !dep.installed
      ? tServer(locale, "doctor.depNotInstalled")
      : dep.versionOk === false
        ? tServer(locale, "doctor.depOutdated", {
            version: dep.version ?? "",
            minimumVersion: dep.minimumVersion ?? "",
          })
        : tServer(locale, "doctor.depInstalled", {
            version: dep.version ?? tServer(locale, "doctor.installedFallback"),
          })
    lines.push(`- **${dep.name}**: ${state}`)
    if (!dep.installed || dep.versionOk === false) {
      lines.push(tServer(locale, "doctor.fixCode", { hint: dep.installHint ?? "" }))
    }
  }
  if (report.permissions) {
    lines.push(tServer(locale, "doctor.accessibilityLine", { state: report.permissions.accessibility }))
    lines.push(tServer(locale, "doctor.screenRecordingLine", { state: report.permissions.screenRecording }))
    if (report.permissions.accessibility !== "granted") {
      lines.push(tServer(locale, "doctor.fix", { hint: tServer(locale, "diag.accessibilityHint") }))
    }
    if (report.permissions.screenRecording !== "granted") {
      lines.push(tServer(locale, "doctor.fix", { hint: tServer(locale, "diag.screenRecordingHint") }))
    }
  }
  lines.push(streamLine(report, locale))
  return lines.join("\n")
}

function streamLine(report: DiagnosticsReport, locale: SupportedLocale): string {
  if (report.stream.backend === "native") {
    return tServer(locale, "doctor.streamNative")
  }
  if (report.stream.backend === "ffmpeg") {
    return tServer(locale, "doctor.streamFfmpeg")
  }
  return tServer(locale, "doctor.streamUnavailable", {
    reason: report.stream.reason ?? tServer(locale, "diag.unknownReason"),
    hint: tServer(locale, "diag.sidecarHint"),
  })
}
