export interface DesktopActionInput {
  action: string
  app?: string
  ref?: string
  rootRef?: string
  skeleton?: boolean
  interactiveOnly?: boolean
  text?: string
  role?: string
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  x?: number
  y?: number
  windowId?: string
  headed?: boolean
}

export function buildDesktopArgs(input: DesktopActionInput): { args: string[]; error?: never } | { error: string; args?: never } {
  switch (input.action) {
    case "snapshot": {
      const args = ["snapshot", "--compact"]
      if (input.interactiveOnly !== false) args.push("-i")
      if (input.skeleton) args.push("--skeleton")
      if (input.rootRef) args.push("--root", input.rootRef)
      if (input.app) args.push("--app", input.app)
      return { args }
    }
    case "find": {
      const args = ["find"]
      if (input.app) args.push("--app", input.app)
      if (input.role) args.push("--role", input.role)
      if (input.text) args.push("--text", input.text)
      return { args }
    }
    case "list_windows": {
      const args = ["list-windows"]
      if (input.app) args.push("--app", input.app)
      return { args }
    }
    case "list_apps": {
      const args = ["list-apps"]
      if (input.app) args.push("--app", input.app)
      return { args }
    }
    case "list_notifications": {
      return { args: ["list-notifications"] }
    }
    case "click": {
      if (!input.ref) return { error: "Error: `ref` is required for click." }
      return { args: ["click", input.ref] }
    }
    case "double_click": {
      if (!input.ref) return { error: "Error: `ref` is required for double_click." }
      return { args: ["double-click", input.ref] }
    }
    case "right_click": {
      if (!input.ref) return { error: "Error: `ref` is required for right_click." }
      return { args: ["right-click", input.ref] }
    }
    case "type": {
      if (!input.ref || typeof input.text !== "string") {
        return { error: "Error: both `ref` and `text` are required for type." }
      }
      return { args: ["type", input.ref, input.text] }
    }
    case "set_value": {
      if (!input.ref || typeof input.text !== "string") {
        return { error: "Error: both `ref` and `text` are required for set_value." }
      }
      return { args: ["set-value", input.ref, input.text] }
    }
    case "press": {
      if (!input.text) return { error: "Error: `text` (key combo like 'return' or 'cmd+k') is required for press." }
      const args = ["press"]
      if (input.app) args.push("--app", input.app)
      args.push(input.text)
      return { args }
    }
    case "scroll": {
      if (!input.ref) return { error: "Error: `ref` is required for scroll." }
      const args = ["scroll", input.ref, "--direction", input.direction ?? "down"]
      if (typeof input.amount === "number") args.push("--amount", String(input.amount))
      return { args }
    }
    case "launch": {
      if (!input.app) return { error: "Error: `app` is required for launch." }
      return { args: ["launch", "--activate", input.app] }
    }
    case "focus_window": {
      const args = ["focus-window"]
      if (input.windowId) args.push("--window-id", input.windowId)
      else if (input.app) args.push("--app", input.app)
      return { args }
    }
    case "mouse_click_xy": {
      if (typeof input.x !== "number" || typeof input.y !== "number") {
        return { error: "Error: numeric `x` and `y` are required for mouse_click_xy." }
      }
      return { args: ["mouse-click", `--xy=${Math.round(input.x)},${Math.round(input.y)}`] }
    }
    case "wait": {
      const ms = typeof input.amount === "number" ? Math.min(30_000, Math.max(100, Math.round(input.amount))) : 1000
      return { args: ["wait", String(ms)] }
    }
    default:
      return { error: `Unsupported action: ${input.action}` }
  }
}

export interface BrowserActionInput {
  action: string
  target?: string
  value?: string
}

export function buildBrowserArgs(input: BrowserActionInput): { args: string[]; error?: never } | { error: string; args?: never } {
  switch (input.action) {
    case "open":
      if (!input.target) return { error: "Error: `target` URL is required for open." }
      return { args: ["open", input.target] }
    case "snapshot":
      return { args: ["snapshot"] }
    case "read":
      return { args: input.target ? ["read", input.target] : ["read"] }
    case "click":
      if (!input.target) return { error: "Error: `target` (@ref or selector) is required for click." }
      return { args: ["click", input.target] }
    case "fill":
      if (!input.target || typeof input.value !== "string") {
        return { error: "Error: `target` and `value` are required for fill." }
      }
      return { args: ["fill", input.target, input.value] }
    case "type":
      if (!input.target || typeof input.value !== "string") {
        return { error: "Error: `target` and `value` are required for type." }
      }
      return { args: ["type", input.target, input.value] }
    case "press":
      if (!input.target) return { error: "Error: `target` key name is required for press." }
      return { args: ["press", input.target] }
    case "scroll": {
      const args = ["scroll", input.target || "down"]
      if (input.value) args.push(input.value)
      return { args }
    }
    case "wait":
      return { args: ["wait", input.target || "1000"] }
    case "eval":
      if (!input.target) return { error: "Error: `target` JS expression is required for eval." }
      return { args: ["eval", input.target] }
    default:
      return { error: `Unsupported browser action: ${input.action}` }
  }
}
