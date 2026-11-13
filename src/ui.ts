import { createSignal, onCleanup, type JSX } from "solid-js"
import h from "solid-js/h"
import type { IconName, Ui } from "@opencode/plugin/gui"

// OpenCode Desktop theme tokens (see DESIGN.md). Not a public SDK API, so every one keeps a dark fallback.
const v = (name: string, fallback: string) => `var(--${name}, ${fallback})`

export const T = {
  bgDeep: v("v2-background-bg-deep", "#050505"),
  bgLayer: v("v2-background-bg-layer-02", "#1f1f1f"),
  text: v("v2-text-text-base", "#ededed"),
  muted: v("v2-text-text-muted", "#a1a1a1"),
  faint: v("v2-text-text-faint", "#707070"),
  focus: v("v2-border-border-focus", "#3b82f6"),
  success: v("v2-state-fg-success", "#22c55e"),
  warning: v("v2-state-fg-warning", "#f59e0b"),
  danger: v("v2-state-fg-danger", "#ef4444"),
  dangerBg: v("v2-state-bg-danger", "#3b1212"),
  elevation: v("v2-elevation-floating", "0 4px 16px rgba(0,0,0,0.35)"),
  sans: v("v2-font-family-sans", "system-ui, sans-serif"),
  code: v("v2-font-family-code", "ui-monospace, monospace"),
  small: v("font-size-small", "12px"),
  radius: v("radius-md", "8px"),
  sp: (n: number) => `calc(${v("spacing", "4px")} * ${n})`,
}

export type Corner = "top-left" | "top-right" | "bottom-right"

/** A floating card over the remote screen: no borders, separated from the picture only by its layer and shadow. */
export function floating(corner: Corner, extra: JSX.CSSProperties = {}): JSX.CSSProperties {
  const [y, x] = corner.split("-")
  return {
    position: "absolute",
    // --bot-inset-top keeps top cards clear of the window controls while the view fills a non-fullscreen window.
    [y]: y === "top" ? `calc(${T.sp(2)} + var(--bot-inset-top, 0px))` : T.sp(2),
    [x]: T.sp(2),
    "max-width": `calc(100% - ${T.sp(4)})`,
    background: T.bgLayer,
    "box-shadow": T.elevation,
    "border-radius": T.radius,
    color: T.text,
    "font-family": T.sans,
    "font-size": T.small,
    "z-index": "1",
    ...extra,
  }
}

export function rootStyle(): JSX.CSSProperties {
  return { position: "relative", height: "100%", width: "100%", overflow: "hidden", background: T.bgDeep, color: T.text, "font-family": T.sans }
}

export type Tone = "success" | "warning" | "danger" | "muted"

export function dot(tone: () => Tone): JSX.Element {
  return h("span", {
    style: () => ({ width: "6px", height: "6px", "border-radius": "50%", flex: "none", background: T[tone()] }),
  }) as unknown as JSX.Element
}

/** Icon-only button with a tooltip. Handlers take an argument: solid-js/h turns zero-arg function props into getters. */
export function iconButton(ui: Ui, p: { icon: IconName; label: string; onClick: (e: MouseEvent) => void; pressed?: () => boolean }): JSX.Element {
  return h(ui.Tooltip, {
    value: p.label,
    placement: "top",
    children: h(ui.IconButton, {
      icon: p.icon,
      label: p.label,
      variant: "ghost-muted",
      size: "large",
      onClick: p.onClick,
      ...(p.pressed ? { pressed: p.pressed } : {}),
    }),
  }) as unknown as JSX.Element
}

export interface Row {
  label: string
  value: () => string
}

/** Grouped two-column details: faint group title, muted label, monospace value. */
export function details(groups: { title: string; rows: Row[] }[]): JSX.Element {
  return h("div", {
    style: { display: "grid", "grid-template-columns": "auto 1fr", gap: `${T.sp(0.5)} ${T.sp(3)}`, padding: `0 ${T.sp(3)} ${T.sp(2)}`, "min-width": "260px" },
  }, groups.flatMap((g) => [
    h("div", { style: { "grid-column": "1 / -1", color: T.faint, "padding-top": T.sp(1.5) } }, g.title),
    ...g.rows.flatMap((r) => [
      h("span", { style: { color: T.muted, "white-space": "nowrap" } }, r.label),
      h("span", { style: { "font-family": T.code, "font-variant-numeric": "tabular-nums", "word-break": "break-all" } }, r.value),
    ]),
  ])) as unknown as JSX.Element
}

/** Top-left connection card: status dot + summary line, expands to details on click. */
export function statusCard(p: { tone: () => Tone; summary: () => string; open: () => boolean; toggle: () => void; body: () => JSX.Element }): JSX.Element {
  return h("div", { style: floating("top-left", { overflow: "hidden" }) }, [
    h("div", {
      role: "button",
      tabIndex: 0,
      title: "连接详情",
      onClick: () => p.toggle(),
      onKeyDown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && p.toggle(),
      style: { display: "flex", "align-items": "center", gap: T.sp(2), padding: `${T.sp(1.5)} ${T.sp(3)}`, cursor: "pointer", "user-select": "none" },
    }, [
      dot(p.tone),
      h("span", { style: { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "font-variant-numeric": "tabular-nums" } }, p.summary),
    ]),
    () => (p.open() ? p.body() : null),
  ]) as unknown as JSX.Element
}

/** Top-right card shown while a human takeover is pending. */
export function takeoverCard(ui: Ui, reason: () => string, resume: () => void): JSX.Element {
  return h("div", {
    style: floating("top-right", { background: T.dangerBg, display: "flex", "align-items": "center", gap: T.sp(2), padding: `${T.sp(1)} ${T.sp(1)} ${T.sp(1)} ${T.sp(3)}`, "max-width": "50%" }),
  }, [
    h("span", { style: { color: T.danger, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" } }, () => `人工接管：${reason()}`),
    h(ui.Button, { variant: "contrast", size: "small", onClick: (_e: MouseEvent) => resume(), children: "完成并恢复 AI" }),
  ]) as unknown as JSX.Element
}

// Height of the window controls (macOS traffic lights, Windows caption buttons) drawn over a frameless window.
const WINDOW_CONTROLS = "40px"

const screenFull = () => window.outerWidth >= screen.width && window.outerHeight >= screen.height

/** OpenCode's "Toggle Full Screen" menu shortcut. Views must let it through instead of sending it to the remote. */
export const isFullscreenKey = (e: KeyboardEvent) => e.ctrlKey && e.metaKey && !e.altKey && e.code === "KeyF"

/**
 * Lets a view fill the whole OpenCode window. HTML fullscreen never completes in the Desktop shell, and plugins
 * cannot reach the window's own fullscreen, so true fullscreen is the user's ⌃⌘F on top of this. The panel's
 * `contain` ancestors trap `position: fixed`, so the view is moved under <body> while filled. Call inside a component.
 */
export function windowFill(el: () => HTMLElement | undefined) {
  const [on, setOn] = createSignal(false)
  const [full, setFull] = createSignal(screenFull())
  let mark: Comment | null = null
  const inset = () => el()?.style.setProperty("--bot-inset-top", on() && !full() ? WINDOW_CONTROLS : "0px")
  const onResize = () => {
    setFull(screenFull())
    inset()
  }
  window.addEventListener("resize", onResize)
  // Moving a <video> in the DOM pauses it.
  const replay = (n: HTMLElement) => n.querySelectorAll("video").forEach((v) => void v.play().catch(() => {}))
  const enter = () => {
    const n = el()
    if (!n || mark) return
    mark = document.createComment("bot-live-screen")
    n.replaceWith(mark)
    Object.assign(n.style, { position: "fixed", inset: "0", zIndex: "40" })
    document.body.appendChild(n)
    setOn(true)
    inset()
    replay(n)
  }
  const exit = () => {
    const n = el()
    if (!n || !mark) return
    Object.assign(n.style, { position: "relative", inset: "", zIndex: "" })
    mark.replaceWith(n)
    mark = null
    setOn(false)
    inset()
    replay(n)
  }
  // Esc inside the picture belongs to the remote machine. ⌃⌘F from the picture or while filled takes the window to
  // true fullscreen (the app's own menu shortcut) with the view filling it, and back.
  const onKey = (e: KeyboardEvent) => {
    const inScreen = !!(e.target as Element | null)?.closest?.("[data-bot-screen]")
    if (e.key === "Escape" && on() && !inScreen) exit()
    if (isFullscreenKey(e) && (inScreen || on())) full() ? exit() : enter()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => {
    document.removeEventListener("keydown", onKey)
    window.removeEventListener("resize", onResize)
    if (mark) {
      el()?.remove()
      mark.remove()
      mark = null
    }
  })
  return { on, full, toggle: () => (on() ? exit() : enter()) }
}
