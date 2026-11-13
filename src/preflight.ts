import { resolveBinary } from "./macos/exec.ts"
import { getMacDesktopStatus } from "./macos/desktop.ts"
import { StreamSidecar } from "./stream/sidecar.ts"

export interface PreflightIssue {
  readonly component: string
  readonly problem: string
  readonly hint: string
}

/**
 * Startup dependency preflight. Surfaces missing CLIs, TCC permissions and native
 * helpers at plugin load time instead of on the first failing tool call.
 */
export async function collectPreflightIssues(signal?: AbortSignal): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = []

  // TCC permission states are macOS-only; on other platforms getMacDesktopStatus
  // reports "unsupported" and must not be treated as a permission problem.
  const isMac = process.platform === "darwin"

  if (!resolveBinary("agent-desktop")) {
    issues.push({
      component: "agent-desktop",
      problem: "CLI 未安装（PATH 未找到）",
      hint: "运行 `npm install -g agent-desktop`（或 `brew install agent-desktop`），再用 `agent-desktop check` 验证辅助功能与录屏权限。",
    })
  } else if (isMac) {
    const status = await getMacDesktopStatus(signal).catch(() => null)
    if (status) {
      if (status.accessibility !== "granted") {
        issues.push({
          component: "辅助功能权限 (Accessibility)",
          problem: `当前状态 \`${status.accessibility}\`，桌面语义操作将失败`,
          hint: "系统设置 → 隐私与安全性 → 辅助功能，为宿主终端/OpenCode 进程勾选。",
        })
      }
      if (status.screenRecording !== "granted") {
        issues.push({
          component: "屏幕录制权限 (Screen Recording)",
          problem: `当前状态 \`${status.screenRecording}\`，截屏/直播将失败`,
          hint: "系统设置 → 隐私与安全性 → 屏幕录制，为宿主终端/OpenCode 进程勾选。",
        })
      }
    }
  }

  if (!resolveBinary("agent-browser")) {
    issues.push({
      component: "agent-browser",
      problem: "CLI 未安装（PATH 未找到）",
      hint: "运行 `npm install -g agent-browser`。",
    })
  }

  if (!StreamSidecar.available()) {
    issues.push({
      component: "实时画面 sidecar",
      problem: "dist/bin 原生二进制缺失，直播将降级为低帧率 JPEG 轮询",
      hint: "在插件目录运行 `npm run build:native`（需要 Go，macOS 另需 Swift 工具链）。",
    })
  }

  return issues
}

export function formatPreflightIssues(issues: readonly PreflightIssue[]): string {
  return issues.map((i) => `- **${i.component}**: ${i.problem} — ${i.hint}`).join("\n")
}
