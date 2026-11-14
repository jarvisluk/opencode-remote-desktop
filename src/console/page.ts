import { toBcp47, type SupportedLocale } from "../i18n/locale.ts"
import { WEB_CONSOLE_I18N } from "../i18n/web-console.ts"

export function renderConsoleHtml(defaultLocale: SupportedLocale = "en"): string {
  const s = WEB_CONSOLE_I18N[defaultLocale] ?? WEB_CONSOLE_I18N.en
  const htmlLang = toBcp47(defaultLocale)
  const dictJson = JSON.stringify(WEB_CONSOLE_I18N).replace(/</g, "\\u003c")
  const localeJson = JSON.stringify(defaultLocale)
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#000000" />
  <title>${s.pageTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --glass: rgba(22, 22, 22, 0.78);
      --glass-border: rgba(255, 255, 255, 0.12);
      --surface-hover: rgba(255, 255, 255, 0.08);
      --surface-active: rgba(255, 255, 255, 0.14);
      --text-strong: rgba(255, 255, 255, 0.94);
      --text-base: rgba(255, 255, 255, 0.64);
      --text-weak: rgba(255, 255, 255, 0.42);
      --interactive: #9dbefe;
      --success: #7add71;
      --critical: #fc533a;
      --warning: #f5c84b;
      --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --radius: 10px;
      --shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      --safe-top: env(safe-area-inset-top);
      --safe-bottom: env(safe-area-inset-bottom);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; background: #000; }
    body {
      color: var(--text-strong);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 20px;
      -webkit-font-smoothing: antialiased;
      overscroll-behavior: none;
    }
    button, select, input { font: inherit; color: inherit; }
    button { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    :focus-visible { outline: 2px solid var(--interactive); outline-offset: 1px; }
    [hidden] { display: none !important; }

    /* 全屏画面 */
    #stage {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #screenWrap { position: relative; line-height: 0; }
    #screenImg, #screenVideo {
      display: block;
      max-width: 100vw;
      max-height: 100dvh;
      width: auto;
      height: auto;
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      -webkit-touch-callout: none;
      cursor: crosshair;
      outline: none;
    }
    #screenImg:not([src]) { width: 100vw; height: 100dvh; }
    #screenVideo[hidden], #screenImg[hidden] { display: none; }
    #screenWrap[data-mode="view"] #screenImg,
    #screenWrap[data-mode="view"] #screenVideo { cursor: default; }
    .placeholder {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--text-weak);
      line-height: 20px;
      pointer-events: none;
    }
    .dot {
      position: absolute;
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      border: 2px solid var(--interactive);
      border-radius: 50%;
      pointer-events: none;
      animation: pulse 0.45s ease-out forwards;
    }
    @keyframes pulse {
      from { transform: scale(0.5); opacity: 1; }
      to { transform: scale(1.8); opacity: 0; }
    }

    /* 浮层通用 */
    .glass {
      background: var(--glass);
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      backdrop-filter: blur(16px) saturate(1.4);
    }
    .icon-btn {
      width: 32px;
      height: 32px;
      display: inline-grid;
      place-items: center;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--text-base);
    }
    .icon-btn:hover { background: var(--surface-hover); color: var(--text-strong); }
    .icon-btn[aria-pressed="true"] { background: var(--surface-active); color: var(--text-strong); }
    .icon-btn svg { width: 18px; height: 18px; }

    /* 悬浮把手：默认唯一可见的控件，闲置时变淡 */
    #handle {
      position: fixed;
      top: calc(10px + var(--safe-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border-radius: 999px;
      transition: opacity 0.3s, transform 0.25s;
    }
    #handle .icon-btn { border-radius: 999px; }
    #handle[data-idle="true"]:not(:hover):not(:focus-within) { opacity: 0.28; }
    body[data-top="open"] #handle { transform: translateX(-50%) translateY(-80px); opacity: 0; pointer-events: none; }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 46vw;
      padding: 0 10px 0 8px;
      color: var(--text-base);
      font-size: 12px;
      white-space: nowrap;
    }
    .status-pill span:last-child { overflow: hidden; text-overflow: ellipsis; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-weak); flex-shrink: 0; }
    .status-dot[data-state="online"] { background: var(--success); }
    .status-dot[data-state="error"] { background: var(--critical); }
    .status-dot[data-state="busy"] { background: var(--interactive); }

    /* 顶部工具栏：按需唤出 */
    #topbar {
      position: fixed;
      top: calc(8px + var(--safe-top));
      left: 50%;
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100vw - 16px);
      padding: 4px;
      border-radius: 12px;
      transform: translate(-50%, calc(-100% - 24px));
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    body[data-top="open"] #topbar { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
    .segmented {
      display: inline-flex;
      padding: 2px;
      gap: 2px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      flex-shrink: 0;
    }
    .segmented button {
      border: 0;
      background: transparent;
      color: var(--text-base);
      height: 28px;
      padding: 0 10px;
      border-radius: 6px;
      white-space: nowrap;
    }
    .segmented button:hover { color: var(--text-strong); }
    .segmented button[aria-pressed="true"] { background: rgba(255, 255, 255, 0.16); color: var(--text-strong); }
    .select {
      height: 32px;
      max-width: 200px;
      min-width: 0;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid var(--glass-border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-strong);
    }
    .select option { background: #1c1c1c; }
    .vsep { width: 1px; height: 20px; background: var(--glass-border); flex-shrink: 0; }

    /* 底部输入坞：按需唤出 */
    #dock {
      position: fixed;
      left: 50%;
      bottom: calc(10px + var(--safe-bottom));
      z-index: 40;
      width: min(760px, calc(100vw - 16px));
      border-radius: 14px;
      transform: translate(-50%, calc(100% + 24px));
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    body[data-dock="open"] #dock { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
    #textForm { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; }
    #textInput {
      flex: 1;
      min-width: 0;
      height: 32px;
      border: 0;
      outline: 0;
      background: transparent;
      font-size: 15px;
    }
    #textInput::placeholder { color: var(--text-weak); }
    .send-btn {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: var(--text-strong);
      color: #111;
    }
    .send-btn:disabled { opacity: 0.25; cursor: default; }
    .send-btn svg { width: 16px; height: 16px; }
    .keys {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-top: 1px solid var(--glass-border);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .keys::-webkit-scrollbar { display: none; }
    .keys .vsep { height: 16px; margin: 0 2px; }
    .key {
      height: 28px;
      min-width: 28px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-base);
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .key:hover { background: var(--surface-hover); color: var(--text-strong); }
    .key:active { background: var(--surface-active); }

    /* 接管提示：AI 等待时始终显示 */
    #takeoverBanner, #agentBanner {
      position: fixed;
      left: 50%;
      top: calc(58px + var(--safe-top));
      z-index: 35;
      display: none;
      align-items: center;
      gap: 10px;
      width: max-content;
      max-width: calc(100vw - 16px);
      padding: 6px 6px 6px 12px;
      border-radius: 12px;
      border-color: rgba(245, 200, 75, 0.45);
      transform: translateX(-50%);
    }
    #takeoverBanner[data-open="true"], #agentBanner[data-open="true"] { display: flex; }
    body[data-top="open"] #takeoverBanner, body[data-top="open"] #agentBanner { top: calc(62px + var(--safe-top)); }
    #takeoverBanner p, #agentBanner p { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #takeoverBanner .warn { color: var(--warning); flex-shrink: 0; }
    #agentBanner { border-color: rgba(96, 165, 250, 0.5); }
    #agentBanner .warn { color: var(--interactive); flex-shrink: 0; animation: agentPulse 1.2s ease-in-out infinite; }
    @keyframes agentPulse { 50% { opacity: 0.3; } }
    /* AI 操作中：画面只读 */
    body[data-screen="agent"] #screenWrap { outline: 2px solid var(--interactive); outline-offset: -2px; cursor: not-allowed; }
    body[data-screen="agent"] #dock { opacity: 0.5; pointer-events: none; }
    .btn-primary {
      height: 30px;
      padding: 0 12px;
      flex-shrink: 0;
      border: 0;
      border-radius: 8px;
      background: var(--text-strong);
      color: #111;
      font-weight: 560;
      white-space: nowrap;
    }
    .btn-primary:hover { opacity: 0.9; }

    @media (max-width: 720px) {
      #topbar { flex-wrap: wrap; justify-content: center; width: calc(100vw - 16px); }
      .segmented { width: 100%; }
      .segmented button { flex: 1; }
      .select { flex: 1; max-width: none; }
      #topbar > .vsep { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot { animation: none; opacity: 0.6; }
      #handle, #topbar, #dock { transition: none; }
    }

    /* 连接表单 */
    #login {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: #000;
    }
    #loginForm {
      width: min(360px, 100%);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 20px;
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      background: var(--glass);
      box-shadow: var(--shadow);
    }
    #loginForm h1 { margin: 0 0 4px; font-size: 15px; line-height: 22px; font-weight: 600; }
    #loginForm label { display: flex; flex-direction: column; gap: 4px; color: var(--text-base); }
    #loginForm input {
      height: 36px;
      padding: 0 10px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-strong);
      font-size: 16px;
    }
    #loginError { margin: 0; color: var(--critical); min-height: 20px; }
    #loginForm .hint { margin: 0; color: var(--text-weak); font-size: 12px; line-height: 18px; }
  </style>
</head>
<body data-top="closed" data-dock="closed">
  <div id="stage">
    <div id="screenWrap" data-mode="click">
      <video id="screenVideo" autoplay muted playsinline tabindex="0" hidden></video>
      <img id="screenImg" data-i18n-alt="screenAlt" alt="${s.screenAlt}" />
      <div class="placeholder" id="placeholder" data-i18n="connectingMac">${s.connectingMac}</div>
    </div>
  </div>

  <div id="handle" class="glass" data-idle="false">
    <div class="status-pill" data-i18n-title="connectionStatusTitle" title="${s.connectionStatusTitle}">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText" data-i18n="connecting">${s.connecting}</span>
    </div>
    <button class="icon-btn" id="dockToggle" type="button" data-i18n-title="dockTitle" data-i18n-aria="dockAria" title="${s.dockTitle}" aria-label="${s.dockAria}" aria-pressed="false">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M5.5 8h1M9.5 8h1M13.5 8h1M6.5 12h7"/></svg>
    </button>
    <button class="icon-btn" id="topToggle" type="button" data-i18n-title="topTitle" data-i18n-aria="topAria" title="${s.topTitle}" aria-label="${s.topAria}" aria-pressed="false">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 10h12M4 14h12"/></svg>
    </button>
  </div>

  <header id="topbar" class="glass">
    <div class="segmented" id="modeBar" role="group" data-i18n-aria="modeAria" aria-label="${s.modeAria}">
      <button type="button" data-mode="click" data-i18n="modeClick" aria-pressed="true">${s.modeClick}</button>
      <button type="button" data-mode="double_click" data-i18n="modeDoubleClick" aria-pressed="false">${s.modeDoubleClick}</button>
      <button type="button" data-mode="right_click" data-i18n="modeRightClick" aria-pressed="false">${s.modeRightClick}</button>
      <button type="button" data-mode="view" data-i18n="modeView" aria-pressed="false">${s.modeView}</button>
    </div>
    <span class="vsep"></span>
    <select class="select" id="windowSelect" data-i18n-aria="windowAria" aria-label="${s.windowAria}"><option value="" data-i18n="entireScreen">${s.entireScreen}</option></select>
    <select class="select" id="fpsSelect" data-i18n-aria="fpsAria" aria-label="${s.fpsAria}">
      <option value="webrtc" data-i18n="fpsWebrtc" selected>${s.fpsWebrtc}</option>
      <option value="-1" data-i18n="fpsJpegFast">${s.fpsJpegFast}</option>
      <option value="500" data-i18n="fpsJpeg2">${s.fpsJpeg2}</option>
      <option value="1000" data-i18n="fpsJpeg1">${s.fpsJpeg1}</option>
      <option value="0" data-i18n="fpsManual">${s.fpsManual}</option>
    </select>
    <button class="icon-btn" id="refreshBtn" type="button" data-i18n-title="refreshTitle" data-i18n-aria="refreshTitle" title="${s.refreshTitle}" aria-label="${s.refreshTitle}">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v3h-3"/></svg>
    </button>
    <button class="icon-btn" id="fullscreenBtn" type="button" data-i18n-title="fullscreenTitle" data-i18n-aria="fullscreenTitle" title="${s.fullscreenTitle}" aria-label="${s.fullscreenTitle}">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg>
    </button>
    <button class="icon-btn" id="topClose" type="button" data-i18n-title="topCloseTitle" data-i18n-aria="topCloseTitle" title="${s.topCloseTitle}" aria-label="${s.topCloseTitle}">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l5-5 5 5"/></svg>
    </button>
  </header>

  <div id="agentBanner" class="glass" role="status">
    <span class="warn">●</span>
    <p id="agentText" data-i18n="agentOperating">${s.agentOperating}</p>
    <button class="btn-primary" id="forceBtn" type="button" data-i18n="forceTakeoverBtn">${s.forceTakeoverBtn}</button>
  </div>

  <div id="takeoverBanner" class="glass" role="alert">
    <span class="warn">●</span>
    <p id="takeoverReason" data-i18n="takeoverDefaultReason">${s.takeoverDefaultReason}</p>
    <button class="btn-primary" id="resumeBtn" type="button" data-i18n="resumeBtn">${s.resumeBtn}</button>
  </div>

  <div id="dock" class="glass">
    <form id="textForm">
      <input id="textInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-i18n-placeholder="textPlaceholder" placeholder="${s.textPlaceholder}" />
      <button class="send-btn" id="sendBtn" type="submit" data-i18n-title="sendTitle" data-i18n-aria="sendTitle" title="${s.sendTitle}" aria-label="${s.sendTitle}" disabled>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4"/><path d="M5 9l5-5 5 5"/></svg>
      </button>
      <button class="icon-btn" id="dockClose" type="button" data-i18n-title="dockCloseTitle" data-i18n-aria="dockCloseAria" title="${s.dockCloseTitle}" aria-label="${s.dockCloseAria}">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5l5 5 5-5"/></svg>
      </button>
    </form>
    <div class="keys" id="keyBar">
      <button class="key" type="button" data-key="return" data-i18n-title="keyReturnTitle" data-i18n="keyReturnText" title="${s.keyReturnTitle}">${s.keyReturnText}</button>
      <button class="key" type="button" data-key="escape" data-i18n-title="keyEscTitle" title="${s.keyEscTitle}">Esc</button>
      <button class="key" type="button" data-key="tab" data-i18n-title="keyTabTitle" title="${s.keyTabTitle}">⇥ Tab</button>
      <button class="key" type="button" data-key="delete" data-i18n-title="keyBackspaceTitle" title="${s.keyBackspaceTitle}">⌫</button>
      <button class="key" type="button" data-key="space" data-i18n-title="keySpaceTitle" data-i18n="keySpaceText" title="${s.keySpaceTitle}">${s.keySpaceText}</button>
      <span class="vsep"></span>
      <button class="key" type="button" data-key="cmd+c" data-i18n-title="keyCopyTitle" title="${s.keyCopyTitle}">⌘C</button>
      <button class="key" type="button" data-key="cmd+v" data-i18n-title="keyPasteTitle" title="${s.keyPasteTitle}">⌘V</button>
      <span class="vsep"></span>
      <button class="key" type="button" data-key="up" data-i18n-title="keyUpTitle" title="${s.keyUpTitle}">↑</button>
      <button class="key" type="button" data-key="down" data-i18n-title="keyDownTitle" title="${s.keyDownTitle}">↓</button>
      <button class="key" type="button" id="scrollUpBtn" data-i18n-title="scrollUpTitle" data-i18n="scrollUpText" title="${s.scrollUpTitle}">${s.scrollUpText}</button>
      <button class="key" type="button" id="scrollDownBtn" data-i18n-title="scrollDownTitle" data-i18n="scrollDownText" title="${s.scrollDownTitle}">${s.scrollDownText}</button>
    </div>
  </div>

  <div id="login" hidden>
    <form id="loginForm" autocomplete="on">
      <h1 data-i18n="loginTitle">${s.loginTitle}</h1>
      <label><span data-i18n="loginServer">${s.loginServer}</span>
        <input id="loginServer" name="url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://…" required />
      </label>
      <input name="username" type="text" autocomplete="username" value="opencode" hidden />
      <label><span data-i18n="loginPassword">${s.loginPassword}</span>
        <input id="loginPassword" name="password" type="password" autocomplete="current-password" required />
      </label>
      <p id="loginError" role="alert"></p>
      <button class="btn-primary" type="submit" data-i18n="loginSubmit">${s.loginSubmit}</button>
      <p class="hint" data-i18n="loginHint">${s.loginHint}</p>
    </form>
  </div>

  <script>
    (() => {
      const I18N = ${dictJson};
      const DEFAULT_LOCALE = ${localeJson};
      // Links carry server and session in the fragment, which browsers never send to the page host.
      const params = new URLSearchParams(location.hash.slice(1) || location.search);
      const targetSession = params.get("session") || "";
      const username = params.get("user") || "opencode";
      let server = (params.get("server") || localStorage.getItem("bot-console:server") || "").replace(/\\/+$/, "");
      let auth = server ? localStorage.getItem("bot-console:auth:" + server) || "" : "";
      // A pairing link (/bot-link) carries the connection key as base64(user:password); keep it and wipe it from the address bar.
      if (params.get("auth") && server) {
        auth = "Basic " + params.get("auth");
        localStorage.setItem("bot-console:server", server);
        localStorage.setItem("bot-console:auth:" + server, auth);
        history.replaceState(null, "", location.pathname + "#" + new URLSearchParams({ server, ...(targetSession ? { session: targetSession } : {}) }));
      }

      function normalizeLang(raw) {
        if (!raw) return null;
        const clean = String(raw).split(".")[0].trim().toLowerCase().replace(/_/g, "-");
        if (clean === "zht" || clean === "zh-hant" || clean.startsWith("zh-hant-") || clean === "zh-tw" || clean === "zh-hk" || clean === "zh-mo") return "zht";
        if (clean === "zh" || clean.startsWith("zh-")) return "zh";
        if (clean === "en" || clean.startsWith("en-")) return "en";
        return null;
      }

      const locale = normalizeLang(params.get("lang")) || normalizeLang(navigator.language) || DEFAULT_LOCALE || "en";
      const msgs = I18N[locale] || I18N.en;
      document.documentElement.lang = locale === "zh" ? "zh-CN" : locale === "zht" ? "zh-TW" : "en-US";
      document.title = msgs.pageTitle;

      function t(key, vars) {
        let str = msgs[key] || I18N.en[key] || key;
        if (vars) {
          str = str.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));
        }
        return str;
      }

      document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
      document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
      document.querySelectorAll("[data-i18n-alt]").forEach((el) => { el.alt = t(el.dataset.i18nAlt); });

      const $ = (id) => document.getElementById(id);

      function basicAuth(user, password) {
        const bytes = new TextEncoder().encode(user + ":" + password);
        let bin = "";
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        return "Basic " + btoa(bin);
      }

      // All control goes through the plugin's RPC on the OpenCode server itself.
      async function rpc(method, input, keepalive) {
        const res = await fetch(server + "/api/rpc/bot/" + method, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ input: input || {} }),
          cache: "no-store",
          keepalive: Boolean(keepalive),
        });
        if (res.status === 401) {
          showLogin(t("loginBadPassword"));
          throw new Error("HTTP 401");
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !("output" in data)) {
          throw new Error((data && (data.message || (data.error && data.error.message))) || "HTTP " + res.status);
        }
        return data.output;
      }

      let started = false;
      function showLogin(error) {
        $("login").hidden = false;
        $("loginServer").value = server;
        $("loginError").textContent = error || "";
        (server ? $("loginPassword") : $("loginServer")).focus();
      }

      async function connect() {
        try {
          const status = await rpc("status");
          streamAvailable = rtcSupported && status.streamAvailable;
          $("login").hidden = true;
          if (!started) { started = true; start(); }
        } catch (e) {
          if ($("login").hidden) showLogin(t("loginUnreachable", { error: e.message }));
        }
      }

      $("loginForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        server = $("loginServer").value.trim().replace(/\\/+$/, "");
        auth = basicAuth(username, $("loginPassword").value);
        $("loginPassword").value = "";
        $("loginError").textContent = "";
        localStorage.setItem("bot-console:server", server);
        localStorage.setItem("bot-console:auth:" + server, auth);
        connect();
      });
      const video = $("screenVideo");
      const img = $("screenImg");
      const wrap = $("screenWrap");
      const placeholder = $("placeholder");
      const statusText = $("statusText");
      const statusDot = $("statusDot");
      const handle = $("handle");
      const windowSelect = $("windowSelect");
      const fpsSelect = $("fpsSelect");
      const banner = $("takeoverBanner");
      const reasonEl = $("takeoverReason");
const agentBanner = $("agentBanner");
const agentText = $("agentText");
let screenOwner = "idle";
      const textInput = $("textInput");
      const sendBtn = $("sendBtn");
      const topToggle = $("topToggle");
      const dockToggle = $("dockToggle");

      let clickMode = "click";
      let logical = { x: 0, y: 0, w: 1920, h: 1080 };
      let lastPoint = { x: 960, y: 540 };
      let inFlight = false;
      let timer = null;
      let continuousStop = true;
      let lastWheel = 0;
      let idleTimer = null;

      // WebRTC state
      let pc = null;
      let dc = null;
      let rtcSession = null;
      let rtcStatsTimer = null;
      let rtcConnectTimer = null;
      let rtcAttempt = 0;
      let rtcGen = 0;
      let rtcSupported = typeof RTCPeerConnection !== "undefined";
      let streamAvailable = rtcSupported;
      let cachedVideoRect = null;
      let videoRectDirty = true;
      let lastMove = 0;
      let pendingMove = null;
      let moveTimer = null;
      let pendingWheel = { dx: 0, dy: 0 };
      let wheelRaf = 0;

      function invalidateVideoRect() { videoRectDirty = true; }
      window.addEventListener("resize", invalidateVideoRect, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(invalidateVideoRect).observe(video);
      }

      function setStatus(text, state) {
        statusText.textContent = text;
        if (state) statusDot.dataset.state = state;
      }

      function showMode(mode) {
        if (mode === "webrtc") {
          video.hidden = false;
          img.hidden = true;
        } else {
          video.hidden = true;
          img.hidden = false;
        }
      }

      function sendDc(msg, ephemeral) {
        if (screenOwner === "agent") return true;
        if (!dc || dc.readyState !== "open") return false;
        if (ephemeral && dc.bufferedAmount > 65536) return true;
        dc.send(JSON.stringify(msg));
        return true;
      }

      function closeWebRtc(silent) {
        rtcGen++;
        clearInterval(rtcStatsTimer);
        rtcStatsTimer = null;
        clearTimeout(rtcConnectTimer);
        rtcConnectTimer = null;
        clearTimeout(moveTimer);
        moveTimer = null;
        pendingMove = null;
        if (wheelRaf) { cancelAnimationFrame(wheelRaf); wheelRaf = 0; }
        pendingWheel = { dx: 0, dy: 0 };
        if (pc) {
          pc.onconnectionstatechange = null;
          pc.ontrack = null;
          pc.close();
          pc = null;
        }
        dc = null;
        video.srcObject = null;
        if (rtcSession) {
          const sid = rtcSession;
          rtcSession = null;
          rpc("streamClose", { session: sid }, true).catch(() => {});
        }
        if (!silent) showMode("jpeg");
      }

      function fallbackToJpeg(reason) {
        if (fpsSelect.value === "webrtc") fpsSelect.value = "-1";
        if (reason) setStatus(t("switchedToJpeg", { reason }), "online");
        scheduleLoop();
      }

      async function startWebRtc() {
        if (!rtcSupported || !streamAvailable || windowSelect.value) {
          fallbackToJpeg();
          return;
        }
        closeWebRtc(true);
        const gen = ++rtcGen;
        const started = performance.now();
        setStatus(t("webrtcConnecting"), "busy");

        const peer = new RTCPeerConnection();
        pc = peer;
        peer.addTransceiver("video", { direction: "recvonly" });
        dc = peer.createDataChannel("input", { ordered: true });
        peer.ontrack = (e) => {
          const rx = e.receiver;
          if (rx) {
            if ("playoutDelayHint" in rx) rx.playoutDelayHint = 0;
            if ("jitterBufferTarget" in rx) rx.jitterBufferTarget = 0;
          }
          video.srcObject = e.streams[0] || new MediaStream([e.track]);
          video.play().catch(() => {});
          showMode("webrtc");
          placeholder.hidden = true;
          invalidateVideoRect();
        };
        peer.onconnectionstatechange = () => {
          if (gen !== rtcGen) return;
          const s = peer.connectionState;
          if (s === "connected") {
            clearTimeout(rtcConnectTimer);
            rtcConnectTimer = null;
            rtcAttempt = 0;
            const ms = Math.round(performance.now() - started);
            setStatus("WebRTC · " + ms + " ms", "online");
          } else if (s === "failed") {
            if (++rtcAttempt < 2) {
              setTimeout(() => { if (gen === rtcGen) startWebRtc(); }, 500);
            } else {
              fallbackToJpeg(t("webrtcDirectFailed"));
            }
          } else if (s === "disconnected") {
            setStatus(t("webrtcReconnecting"), "busy");
          }
        };

        try {
          await peer.setLocalDescription(await peer.createOffer());
          await new Promise((resolve) => {
            if (peer.iceGatheringState === "complete") return resolve();
            let tm = null;
            const finish = () => {
              peer.removeEventListener("icegatheringstatechange", onState);
              clearTimeout(tm);
              resolve();
            };
            const onState = () => { if (peer.iceGatheringState === "complete") finish(); };
            peer.addEventListener("icegatheringstatechange", onState);
            tm = setTimeout(finish, 400);
          });
          if (gen !== rtcGen) return;
          const offerSdp = (peer.localDescription && peer.localDescription.sdp) || "";
          if (!/^a=candidate:/m.test(offerSdp)) {
            return fallbackToJpeg(t("webrtcNoCandidates"));
          }

          const ans = await rpc("streamOffer", { sdp: offerSdp });
          if (gen !== rtcGen) {
            rpc("streamClose", { session: ans.session }, true).catch(() => {});
            return;
          }
          rtcSession = ans.session;
          await peer.setRemoteDescription({ type: "answer", sdp: ans.sdp });
          clearTimeout(rtcConnectTimer);
          rtcConnectTimer = setTimeout(() => {
            if (gen === rtcGen && peer.connectionState !== "connected") {
              fallbackToJpeg(t("webrtcTimeout"));
            }
          }, 3500);

          clearInterval(rtcStatsTimer);
          rtcStatsTimer = setInterval(async () => {
            if (gen !== rtcGen || peer.connectionState !== "connected") return;
            try {
              const stats = await peer.getStats();
              let fps = 0;
              let rttMs = null;
              stats.forEach((r) => {
                if (r.type === "inbound-rtp" && r.kind === "video" && r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
                if (r.type === "candidate-pair" && r.nominated && r.currentRoundTripTime != null) rttMs = Math.round(r.currentRoundTripTime * 1000);
              });
              const parts = ["WebRTC"];
              if (fps) parts.push(fps + " fps");
              if (rttMs !== null) parts.push(rttMs + " ms");
              setStatus(parts.join(" · "), "online");
            } catch {}
          }, 1000);
        } catch (err) {
          if (gen === rtcGen) fallbackToJpeg(err && err.message ? err.message : t("webrtcSignalingError"));
        }
      }

      window.addEventListener("pagehide", () => closeWebRtc(true));

      // 悬浮把手闲置变淡
      function wake() {
        handle.dataset.idle = "false";
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { handle.dataset.idle = "true"; }, 2500);
      }
      ["pointermove", "pointerdown", "keydown"].forEach((t) => document.addEventListener(t, wake, { passive: true }));
      wake();

      // 面板唤出 / 收起
      function setTop(open) {
        document.body.dataset.top = open ? "open" : "closed";
        topToggle.setAttribute("aria-pressed", String(open));
      }
      function setDock(open) {
        document.body.dataset.dock = open ? "open" : "closed";
        dockToggle.setAttribute("aria-pressed", String(open));
        if (open) setTimeout(() => textInput.focus(), 60);
        else textInput.blur();
      }
      topToggle.addEventListener("click", () => setTop(document.body.dataset.top !== "open"));
      dockToggle.addEventListener("click", () => setDock(document.body.dataset.dock !== "open"));
      $("topClose").addEventListener("click", () => setTop(false));
      $("dockClose").addEventListener("click", () => setDock(false));
      document.addEventListener("keydown", (ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod && ev.key === "k") { ev.preventDefault(); setDock(document.body.dataset.dock !== "open"); }
        else if (mod && ev.key === ".") { ev.preventDefault(); setTop(document.body.dataset.top !== "open"); }
        else if (ev.key === "Escape" && (document.body.dataset.top === "open" || document.body.dataset.dock === "open")) {
          setTop(false);
          setDock(false);
        }
      });

      const fsBtn = $("fullscreenBtn");
      if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;
      fsBtn.addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      });

      document.querySelectorAll("#modeBar button[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          clickMode = btn.dataset.mode;
          wrap.dataset.mode = clickMode;
          document.querySelectorAll("#modeBar button[data-mode]").forEach((b) =>
            b.setAttribute("aria-pressed", String(b === btn))
          );
        });
      });

      async function fetchFrame(force) {
        if (inFlight || (!force && document.hidden && img.src) || fpsSelect.value === "webrtc") return;
        inFlight = true;
        try {
          const t0 = performance.now();
          const winId = windowSelect.value;
          const dim = Math.max(1280, Math.min(1920, Math.round(Math.max(screen.width, screen.height) * Math.min(devicePixelRatio || 1, 2))));
          const frame = await rpc("frame", winId ? { maxDimension: dim, quality: 65, windowId: winId } : { maxDimension: dim, quality: 65 });
          logical = { x: frame.logicalX, y: frame.logicalY, w: frame.logicalWidth, h: frame.logicalHeight };
          img.src = "data:image/jpeg;base64," + frame.jpegBase64;
          showMode("jpeg");
          placeholder.hidden = true;
          const ms = Math.round(performance.now() - t0);
          if (statusDot.dataset.state !== "busy") setStatus("JPEG · " + Math.round(logical.w) + " × " + Math.round(logical.h) + " · " + ms + " ms", "online");
        } catch (e) {
          setStatus(t("frameFetchFailed", { error: e.message }), "error");
        } finally {
          inFlight = false;
        }
      }

      async function fetchState() {
        try {
          const [win, tk, scr] = await Promise.all([rpc("listWindows"), rpc("listTakeovers"), rpc("screenState")]);
          const data = { windows: win.windows, takeovers: tk.items };
          const rtcOpt = fpsSelect.querySelector('option[value="webrtc"]');
          if (rtcOpt) rtcOpt.disabled = !streamAvailable;
          if (document.activeElement !== windowSelect) {
            const currentVal = windowSelect.value;
            const esc = (str) => String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const opts = ['<option value="">' + esc(t("entireScreen")) + "</option>"];
            for (const w of data.windows || []) {
              const label = (w.title && w.title !== w.appName ? w.appName + ": " + w.title : w.appName).slice(0, 48);
              const sel = w.id === currentVal ? " selected" : "";
              opts.push('<option value="' + esc(w.id) + '"' + sel + ">" + esc(label) + "</option>");
            }
            windowSelect.innerHTML = opts.join("");
          }

          const items = data.takeovers || [];
          const matched = targetSession ? items.find((t) => t.sessionID === targetSession) || items[0] : items[0];
          if (matched) {
            banner.dataset.open = "true";
            reasonEl.textContent = matched.reason;
            banner.dataset.session = matched.sessionID;
          } else {
            banner.dataset.open = "false";
          }

          screenOwner = scr.owner;
          document.body.dataset.screen = scr.owner;
          agentBanner.dataset.open = String(scr.owner === "agent");
          agentBanner.dataset.session = (scr.sessionIDs || [])[0] || "";
          agentText.textContent = scr.tool ? t("agentOperatingTool", { tool: scr.tool }) : t("agentOperating");
        } catch {}
      }

      function stopJpegLoops() {
        if (timer) { clearInterval(timer); timer = null; }
        continuousStop = true;
      }

      function scheduleLoop() {
        stopJpegLoops();
        const mode = fpsSelect.value;
        if (mode === "webrtc" && !windowSelect.value) {
          startWebRtc();
          return;
        }
        closeWebRtc(false);
        const ms = Number(mode);
        if (ms < 0) {
          continuousStop = false;
          const pump = async () => {
            let first = true;
            while (!continuousStop && fpsSelect.value !== "webrtc") {
              await fetchFrame(first);
              first = false;
              await new Promise((r) => setTimeout(r, 16));
            }
          };
          pump();
        } else if (ms > 0) {
          timer = setInterval(fetchFrame, ms);
        }
      }

      async function sendInput(payload) {
        if (screenOwner === "agent") {
          setStatus(t("inputLockedAgent"), "error");
          return;
        }
        if (payload.kind === "type" && payload.text && sendDc({ t: "text", s: payload.text })) {
          return;
        }
        setStatus(t("sending"), "busy");
        wake();
        try {
          const out = await rpc("sendInput", payload);
          setStatus(out.ok ? (out.detail || t("sent")) : t("sendFailedPrefix", { detail: out.detail || "" }), out.ok ? "online" : "error");
          if (fpsSelect.value !== "webrtc") setTimeout(fetchFrame, 120);
        } catch (e) {
          setStatus(t("sendError", { error: e.message }), "error");
        }
      }

      function videoPos(ev) {
        if (!video.videoWidth || !video.videoHeight) return null;
        if (videoRectDirty || !cachedVideoRect) {
          cachedVideoRect = video.getBoundingClientRect();
          videoRectDirty = false;
        }
        const r = cachedVideoRect;
        if (!r.width || !r.height) return null;
        const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        const x = (ev.clientX - r.left - (r.width - w) / 2) / w;
        const y = (ev.clientY - r.top - (r.height - h) / 2) / h;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x, y, px: ev.clientX - r.left, py: ev.clientY - r.top };
      }

      function mods(ev) {
        return { shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey };
      }

      video.addEventListener("mousemove", (ev) => {
        if (clickMode === "view" || !dc || dc.readyState !== "open") return;
        const p = videoPos(ev);
        if (!p) return;
        const msg = { t: "move", x: p.x, y: p.y, b: ev.button, ...mods(ev) };
        const now = performance.now();
        const elapsed = now - lastMove;
        if (elapsed >= 16) {
          clearTimeout(moveTimer);
          moveTimer = null;
          pendingMove = null;
          lastMove = now;
          sendDc(msg, true);
        } else {
          pendingMove = msg;
          if (!moveTimer) {
            moveTimer = setTimeout(() => {
              moveTimer = null;
              if (pendingMove) {
                lastMove = performance.now();
                sendDc(pendingMove, true);
                pendingMove = null;
              }
            }, 16 - elapsed);
          }
        }
      });

      video.addEventListener("mousedown", (ev) => {
        setTop(false);
        if (clickMode === "view") return;
        const p = videoPos(ev);
        if (!p) return;
        ev.preventDefault();
        video.focus();
        lastPoint = { x: logical.x + p.x * logical.w, y: logical.y + p.y * logical.h };
        if (clickMode === "click") {
          if (pendingMove) { clearTimeout(moveTimer); moveTimer = null; pendingMove = null; }
          sendDc({ t: "down", x: p.x, y: p.y, b: ev.button, ...mods(ev) });
        }
      });

      video.addEventListener("mouseup", (ev) => {
        if (clickMode === "view") return;
        const p = videoPos(ev);
        if (!p) return;
        ev.preventDefault();
        if (clickMode === "click") {
          sendDc({ t: "up", x: p.x, y: p.y, b: ev.button, ...mods(ev) });
        } else if (clickMode === "double_click") {
          ripple(p);
          for (let i = 0; i < 2; i++) {
            sendDc({ t: "down", x: p.x, y: p.y, b: 0, ...mods(ev) });
            sendDc({ t: "up", x: p.x, y: p.y, b: 0, ...mods(ev) });
          }
        } else if (clickMode === "right_click") {
          ripple(p);
          sendDc({ t: "down", x: p.x, y: p.y, b: 2, ...mods(ev) });
          sendDc({ t: "up", x: p.x, y: p.y, b: 2, ...mods(ev) });
        }
      });

      video.addEventListener("contextmenu", (ev) => {
        if (clickMode !== "view") ev.preventDefault();
      });

      video.addEventListener("wheel", (ev) => {
        if (clickMode === "view") return;
        ev.preventDefault();
        const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
        pendingWheel.dx += ev.deltaX * scale;
        pendingWheel.dy += ev.deltaY * scale;
        if (!wheelRaf) {
          wheelRaf = requestAnimationFrame(() => {
            wheelRaf = 0;
            if (pendingWheel.dx || pendingWheel.dy) {
              sendDc({ t: "wheel", dx: pendingWheel.dx, dy: pendingWheel.dy }, true);
              pendingWheel = { dx: 0, dy: 0 };
            }
          });
        }
      }, { passive: false });

      function onVideoKey(t) {
        return (ev) => {
          if (ev.isComposing || (ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === ".")) return;
          if (!dc || dc.readyState !== "open") return;
          ev.preventDefault();
          if (t === "keydown" && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
            sendDc({ t: "text", s: ev.key });
            return;
          }
          if (t === "keyup" && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) return;
          sendDc({ t, code: ev.code, ...mods(ev) });
        };
      }
      video.addEventListener("keydown", onVideoKey("keydown"));
      video.addEventListener("keyup", onVideoKey("keyup"));
      video.addEventListener("paste", (ev) => {
        const text = ev.clipboardData && ev.clipboardData.getData("text/plain");
        if (text && sendDc({ t: "text", s: text })) ev.preventDefault();
      });

      function toMac(ev) {
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const relX = (ev.clientX - rect.left) / rect.width;
        const relY = (ev.clientY - rect.top) / rect.height;
        return {
          x: logical.x + relX * logical.w,
          y: logical.y + relY * logical.h,
          px: ev.clientX - rect.left,
          py: ev.clientY - rect.top,
        };
      }

      function ripple(p) {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.left = p.px + "px";
        dot.style.top = p.py + "px";
        wrap.appendChild(dot);
        setTimeout(() => dot.remove(), 480);
      }

      img.addEventListener("click", (ev) => {
        setTop(false);
        if (clickMode === "view" || !img.src) return;
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        ripple(p);
        sendInput({ kind: clickMode, x: p.x, y: p.y });
      });

      img.addEventListener("contextmenu", (ev) => {
        if (clickMode === "view" || !img.src) return;
        ev.preventDefault();
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        ripple(p);
        sendInput({ kind: "right_click", x: p.x, y: p.y });
      });

      img.addEventListener("wheel", (ev) => {
        if (clickMode === "view" || !img.src) return;
        ev.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 250) return;
        lastWheel = now;
        const p = toMac(ev);
        if (!p) return;
        lastPoint = { x: p.x, y: p.y };
        sendInput({ kind: "scroll", x: p.x, y: p.y, deltaY: ev.deltaY > 0 ? -3 : 3 });
      }, { passive: false });

      textInput.addEventListener("input", () => { sendBtn.disabled = !textInput.value; });

      $("textForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (!textInput.value) return;
        const text = textInput.value;
        textInput.value = "";
        sendBtn.disabled = true;
        sendInput({ kind: "type", text });
      });

      document.querySelectorAll("#keyBar button[data-key]").forEach((btn) => {
        btn.addEventListener("click", () => sendInput({ kind: "key", key: btn.dataset.key }));
      });

      $("scrollUpBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastPoint.x, y: lastPoint.y, deltaY: 5 })
      );
      $("scrollDownBtn").addEventListener("click", () =>
        sendInput({ kind: "scroll", x: lastPoint.x, y: lastPoint.y, deltaY: -5 })
      );

      $("refreshBtn").addEventListener("click", () => {
        if (fpsSelect.value === "webrtc" && !windowSelect.value) startWebRtc();
        else fetchFrame(true);
      });
      windowSelect.addEventListener("change", () => {
        if (windowSelect.value) {
          closeWebRtc(false);
          if (fpsSelect.value === "webrtc") fpsSelect.value = "-1";
          fetchFrame();
          scheduleLoop();
        } else {
          if (streamAvailable) fpsSelect.value = "webrtc";
          scheduleLoop();
        }
      });
      fpsSelect.addEventListener("change", scheduleLoop);

      $("forceBtn").addEventListener("click", async () => {
        if (!confirm(t("forceTakeoverConfirm"))) return;
        const sid = agentBanner.dataset.session || targetSession || undefined;
        await rpc("forceTakeover", sid ? { sessionID: sid } : {});
        await fetchState();
        setStatus(t("forceTakeoverDone"), "online");
      });

      $("resumeBtn").addEventListener("click", async () => {
        const sid = banner.dataset.session || targetSession || undefined;
        await rpc("resolveTakeover", sid ? { sessionID: sid, note: "User completed takeover via Web Console" } : { note: "User completed takeover via Web Console" });
        await fetchState();
        setStatus(t("handedBackToAi"), "online");
      });

      function start() {
      fetchState().then(() => {
        if (streamAvailable && !windowSelect.value) {
          startWebRtc();
        } else {
          if (fpsSelect.value === "webrtc") fpsSelect.value = "-1";
          fetchFrame(true);
          scheduleLoop();
        }
      });
      setInterval(fetchState, 1500);
      }

      if (server && auth) connect();
      else showLogin("");
    })();
  </script>
</body>
</html>
`
}
