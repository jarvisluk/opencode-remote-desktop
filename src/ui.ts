import { createSignal, onCleanup, type JSX } from "solid-js"
import h from "solid-js/h"
import type { IconName, Ui } from "@opencode/plugin/gui"
import { createGuiTranslator, type GuiTranslate } from "./i18n/gui.ts"

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

export type TextOrGetter = string | (() => string)

/** Icon-only button with a tooltip. Handlers take an argument: solid-js/h turns zero-arg function props into getters. */
export function iconButton(ui: Ui, p: { icon: IconName; label: TextOrGetter; onClick: (e: MouseEvent) => void; pressed?: () => boolean }): JSX.Element {
  return h(ui.Tooltip, {
    value: p.label as any,
    placement: "top",
    children: h(ui.IconButton, {
      icon: p.icon,
      label: p.label as any,
      variant: "ghost-muted",
      size: "large",
      onClick: p.onClick,
      ...(p.pressed ? { pressed: p.pressed } : {}),
    }),
  }) as unknown as JSX.Element
}

export interface Row {
  label: TextOrGetter
  value: () => string
}

/** Grouped two-column details: faint group title, muted label, monospace value. */
export function details(groups: { title: TextOrGetter; rows: Row[] }[]): JSX.Element {
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
export function statusCard(p: { title?: TextOrGetter; tone: () => Tone; summary: () => string; open: () => boolean; toggle: () => void; body: () => JSX.Element }): JSX.Element {
  return h("div", { style: floating("top-left", { overflow: "hidden" }) }, [
    h("div", {
      role: "button",
      tabIndex: 0,
      title: p.title ?? "Connection details",
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

// Full-width row under the top-left status pill, so a long reason never squeezes against it.
function belowStatus(): JSX.CSSProperties {
  return { top: `calc(${T.sp(2)} + var(--bot-inset-top, 0px) + 44px)`, left: T.sp(2), "max-width": "none" }
}

/** Card under the status pill shown while a human takeover is pending. */
export function takeoverCard(
  ui: Ui,
  reason: () => string,
  resume: () => void,
  labels?: { text?: () => string; resume?: TextOrGetter },
): JSX.Element {
  return h("div", {
    style: floating("top-right", { ...belowStatus(), background: T.dangerBg, display: "flex", "align-items": "center", gap: T.sp(2), padding: `${T.sp(1)} ${T.sp(1)} ${T.sp(1)} ${T.sp(3)}` }),
  }, [
    h("span", { title: reason, style: { color: T.danger, flex: "1", "min-width": "0", "word-break": "break-word" } }, () => (labels?.text ? labels.text() : `Human takeover: ${reason()}`)),
    h("div", { style: { flex: "none", "white-space": "nowrap", display: "flex" } }, [
      h(ui.Button, { variant: "contrast", size: "small", onClick: (_e: MouseEvent) => resume(), children: (labels?.resume ?? "Done & Resume AI") as any }),
    ]),
  ]) as unknown as JSX.Element
}

/** Top-right card shown while an agent drives the screen and remote input is locked. */
export function agentCard(ui: Ui, text: () => string, force: () => void, forceLabel: TextOrGetter): JSX.Element {
  return h("div", {
    role: "status",
    style: floating("top-right", { ...belowStatus(), display: "flex", "align-items": "center", gap: T.sp(2), padding: `${T.sp(1)} ${T.sp(1)} ${T.sp(1)} ${T.sp(3)}` }),
  }, [
    h("span", { style: { width: "6px", height: "6px", "border-radius": "50%", flex: "none", background: T.focus, animation: "bot-agent-pulse 1.2s ease-in-out infinite" } }),
    h("style", {}, "@keyframes bot-agent-pulse { 50% { opacity: 0.3 } }"),
    h("span", { title: text, style: { flex: "1", "min-width": "0", "word-break": "break-word" } }, text),
    h(ui.Button, { variant: "danger", size: "small", onClick: (_e: MouseEvent) => force(), children: forceLabel as any }),
  ]) as unknown as JSX.Element
}

interface SecretRequest {
  id: string
  sessionID: string
  name: string
  reason: string
}

/**
 * Polls the host for a pending `computer_secret_request` on this session and renders its top-right entry card.
 * The typed value lives only in this card until it is submitted. Call inside a component.
 */
export function secretPrompt(ui: Ui, p: { rpc: () => any; sessionID: () => string | undefined; t: GuiTranslate }) {
  const [req, setReq] = createSignal<SecretRequest | null>(null)
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const show = (next: SecretRequest | null) => {
    if ((next?.id ?? "") === (req()?.id ?? "")) return
    setValue("")
    setError("")
    setReq(next)
  }
  const poll = async () => {
    try {
      const sid = p.sessionID()
      const res = await p.rpc()?.listSecretRequests({})
      show(res?.items.find((i: SecretRequest) => !sid || i.sessionID === sid) ?? null)
    } catch {}
  }
  void poll()
  const timer = setInterval(poll, 2000)
  onCleanup(() => clearInterval(timer))

  const submit = async () => {
    const r = req()
    if (!r || !value() || busy()) return
    setBusy(true)
    setError("")
    try {
      await p.rpc()?.secretSubmit({ id: r.id, value: value() })
      show(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    const r = req()
    show(null)
    if (r) await p.rpc()?.secretCancel({ id: r.id }).catch(() => {})
  }

  const card = () =>
    req()
      ? (h("div", {
          style: floating("top-right", { display: "flex", "flex-direction": "column", gap: T.sp(2), padding: T.sp(3), width: "300px" }),
        }, [
          h("div", { style: { display: "flex", "flex-direction": "column", gap: T.sp(0.5) } }, [
            h("span", { style: { color: T.warning } }, () => p.t("secret.title")),
            h("span", { style: { "word-break": "break-word" } }, () => req()?.reason ?? ""),
            h("span", { style: { color: T.faint, "font-family": T.code } }, () => p.t("secret.storedAs", { name: req()?.name ?? "" })),
          ]),
          h(ui.TextInput, {
            type: "password",
            label: (() => p.t("secret.label")) as any,
            placeholder: (() => p.t("secret.placeholder")) as any,
            value,
            onInput: (v: string) => setValue(v),
            onSubmit: (_v: string) => void submit(),
            invalid: (() => Boolean(error())) as any,
            autofocus: true,
          }),
          () => (error() ? h("span", { style: { color: T.danger, "word-break": "break-word" } }, error()) : null),
          h("div", { style: { display: "flex", "justify-content": "flex-end", gap: T.sp(1) } }, [
            h(ui.Button, { variant: "ghost-muted", size: "small", onClick: (_e: MouseEvent) => void cancel(), children: (() => p.t("secret.cancel")) as any }),
            h(ui.Button, {
              variant: "contrast",
              size: "small",
              busy: busy as any,
              disabled: (() => !value()) as any,
              onClick: (_e: MouseEvent) => void submit(),
              children: (() => p.t("secret.submit")) as any,
            }),
          ]),
        ]) as unknown as JSX.Element)
      : null

  return { pending: () => Boolean(req()), card }
}

// Height of OpenCode's own title strip (8px top inset + 48px traffic-light row, measured in the 2.3.0 shell).
const WINDOW_CONTROLS = "56px"

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
    // no-drag: the app's title strip underneath is a window drag region, which would swallow clicks on the picture.
    Object.assign(n.style, { position: "fixed", inset: "0", zIndex: "40", webkitAppRegion: "no-drag" })
    document.body.appendChild(n)
    setOn(true)
    inset()
    replay(n)
  }
  const exit = () => {
    const n = el()
    if (!n || !mark) return
    Object.assign(n.style, { position: "relative", inset: "", zIndex: "", webkitAppRegion: "" })
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

const DEFAULT_ERR_T = createGuiTranslator("zh")

export interface ScreenErrorInfo {
  /** Short, human-friendly summary of what failed. */
  summary: string
  /** Actionable remediation hint when known. */
  hint?: string
  /** Raw error string from RPC / WebRTC / capture. */
  raw: string
  /** Whether the entire remote `bot` RPC service is unavailable (not just WebRTC). */
  serviceUnavailable?: boolean
}

/** Translates low-level RPC / WebRTC / capture error strings into clear user-facing diagnostics. */
export function explainScreenError(raw: string, t: GuiTranslate = DEFAULT_ERR_T): ScreenErrorInfo {
  const msg = raw.trim()
  if (!msg) return { summary: "", raw: "" }

  if (/RPC is unavailable:\s*bot/i.test(msg)) {
    return {
      summary: t("err.botRpcUnavailable.summary"),
      hint: t("err.botRpcUnavailable.hint"),
      raw: msg,
      serviceUnavailable: true,
    }
  }
  if (/native stream binary missing|build:native/i.test(msg)) {
    return {
      summary: t("err.nativeMissing.summary"),
      hint: t("err.nativeMissing.hint"),
      raw: msg,
    }
  }
  if (/WebRTC no direct route|WebRTC connection failed/i.test(msg)) {
    return {
      summary: t("err.webrtcRoute.summary"),
      hint: t("err.webrtcRoute.hint"),
      raw: msg,
    }
  }
  if (/WebRTC connect timeout/i.test(msg)) {
    return {
      summary: t("err.webrtcTimeout.summary"),
      hint: t("err.webrtcTimeout.hint"),
      raw: msg,
    }
  }
  if (/Screen Recording|screencapture failed| screen capture|录屏|螢幕錄製/i.test(msg)) {
    return {
      summary: t("err.screenRecording.summary"),
      hint: t("err.screenRecording.hint"),
      raw: msg,
    }
  }
  if (/Window not found/i.test(msg)) {
    return {
      summary: t("err.windowNotFound.summary"),
      hint: t("err.windowNotFound.hint"),
      raw: msg,
    }
  }
  if (/服务器已断开|伺服器已中斷|Server disconnected/i.test(msg)) {
    return {
      summary: t("err.serverDisconnected.summary"),
      hint: t("err.serverDisconnected.hint"),
      raw: msg,
      serviceUnavailable: true,
    }
  }
  return { summary: msg, raw: msg }
}
