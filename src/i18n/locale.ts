export type SupportedLocale = "en" | "zh" | "zht"
export type LocalePreference = SupportedLocale | "auto"

/**
 * Normalizes any BCP-47 / POSIX / OpenCode locale tag into one of the supported locales:
 * - "zh": Simplified Chinese (`zh`, `zh-CN`, `zh-SG`, `zh-Hans`, ...)
 * - "zht": Traditional Chinese (`zht`, `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant`, ...)
 * - "en": English (default fallback)
 */
export function normalizeLocale(raw?: string | null): SupportedLocale {
  if (!raw || typeof raw !== "string") return "en"
  const clean = raw.split(".")[0]?.split("@")[0]?.trim().toLowerCase().replace(/_/g, "-") ?? ""
  if (!clean) return "en"
  if (clean === "zht" || clean === "zh-hant" || clean.startsWith("zh-hant-")) return "zht"
  if (clean === "zh-tw" || clean === "zh-hk" || clean === "zh-mo" || clean.startsWith("zh-tw-") || clean.startsWith("zh-hk-") || clean.startsWith("zh-mo-")) {
    return "zht"
  }
  if (clean === "zh" || clean.startsWith("zh-")) return "zh"
  return "en"
}

export function parseLocalePreference(raw: unknown): LocalePreference {
  if (typeof raw !== "string") return "auto"
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === "auto") return "auto"
  const lower = trimmed.toLowerCase().replace(/_/g, "-")
  if (lower === "en" || lower.startsWith("en-")) return "en"
  if (lower.startsWith("zh")) return normalizeLocale(trimmed)
  return "auto"
}

/** Resolves the effective server-side locale from explicit option -> env vars -> Intl runtime -> "en". */
export function resolveLocale(
  preferred?: string | null,
  env: Record<string, string | undefined> = process.env,
): SupportedLocale {
  if (preferred && preferred.trim() && preferred.trim().toLowerCase() !== "auto") {
    return normalizeLocale(preferred)
  }
  const envCandidate = env.OPENCODE_BOT_LOCALE || env.OPENCODE_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG
  if (envCandidate && !/^(c|posix)(\.|$)/i.test(envCandidate.trim())) {
    return normalizeLocale(envCandidate)
  }
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale
    if (intlLocale) return normalizeLocale(intlLocale)
  } catch {
    // Ignore Intl errors and fall back to English.
  }
  return "en"
}

/** Parses an HTTP Accept-Language header and picks the highest-priority supported locale if present. */
export function parseAcceptLanguage(header?: string | null): SupportedLocale | null {
  if (!header || typeof header !== "string") return null
  const candidates = header
    .split(",")
    .map((part, index) => {
      const [tagPart, ...params] = part.trim().split(";")
      const tag = tagPart?.trim() ?? ""
      let q = 1
      for (const p of params) {
        const m = p.trim().match(/^q=([0-9.]+)$/)
        if (m) q = Number(m[1])
      }
      return { tag, q: Number.isFinite(q) ? q : 0, index }
    })
    .filter((c) => c.tag && c.tag !== "*" && c.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)

  for (const c of candidates) {
    const lower = c.tag.toLowerCase()
    if (lower.startsWith("zh")) return normalizeLocale(c.tag)
    if (lower.startsWith("en")) return "en"
  }
  return null
}

export function toBcp47(locale: SupportedLocale): string {
  if (locale === "zh") return "zh-CN"
  if (locale === "zht") return "zh-TW"
  return "en-US"
}

export function interpolate(
  template: string,
  params?: Record<string, string | number | boolean>,
): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    key in params ? String(params[key]) : full,
  )
}
