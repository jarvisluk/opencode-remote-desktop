import test from "node:test"
import assert from "node:assert/strict"
import {
  interpolate,
  normalizeLocale,
  parseAcceptLanguage,
  parseLocalePreference,
  resolveLocale,
  toBcp47,
} from "../src/i18n/locale.ts"
import { createGuiTranslator, guiCatalog } from "../src/i18n/gui.ts"
import { SERVER_TABLES, tServer, type ServerMessageKey } from "../src/i18n/server.ts"
import { WEB_CONSOLE_I18N } from "../src/i18n/web-console.ts"
import { resolveOptions } from "../src/options.ts"
import { TakeoverManager } from "../src/takeover/manager.ts"
import { renderConsoleHtml } from "../src/console/page.ts"

test("locale normalization and resolution handles en, zh, zht, and auto", () => {
  assert.equal(normalizeLocale("en"), "en")
  assert.equal(normalizeLocale("en-US"), "en")
  assert.equal(normalizeLocale("zh"), "zh")
  assert.equal(normalizeLocale("zh-CN"), "zh")
  assert.equal(normalizeLocale("zh_CN.UTF-8"), "zh")
  assert.equal(normalizeLocale("zh-Hans"), "zh")
  assert.equal(normalizeLocale("zht"), "zht")
  assert.equal(normalizeLocale("zh-TW"), "zht")
  assert.equal(normalizeLocale("zh-HK"), "zht")
  assert.equal(normalizeLocale("zh-Hant-TW"), "zht")
  assert.equal(normalizeLocale(undefined), "en")

  assert.equal(parseLocalePreference("auto"), "auto")
  assert.equal(parseLocalePreference("zh-TW"), "zht")
  assert.equal(parseLocalePreference("zh_CN"), "zh")
  assert.equal(parseLocalePreference("en"), "en")

  assert.equal(resolveLocale("zh", { LANG: "en_US.UTF-8" }), "zh")
  assert.equal(resolveLocale("auto", { OPENCODE_BOT_LOCALE: "zh-HK", LANG: "en_US.UTF-8" }), "zht")
  assert.equal(resolveLocale("auto", { OPENCODE_LOCALE: "zh_CN.UTF-8" }), "zh")
  assert.equal(resolveLocale("auto", { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" }), "en")

  assert.equal(parseAcceptLanguage("zh-TW,zh;q=0.9,en-US;q=0.8"), "zht")
  assert.equal(parseAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh")
  assert.equal(parseAcceptLanguage("en-US,en;q=0.9,zh-CN;q=0.8"), "en")
  assert.equal(parseAcceptLanguage("fr-FR,de;q=0.9"), null)

  assert.equal(toBcp47("en"), "en-US")
  assert.equal(toBcp47("zh"), "zh-CN")
  assert.equal(toBcp47("zht"), "zh-TW")

  assert.equal(interpolate("Hi {{name}} ({{count}})", { name: "Bot", count: 2 }), "Hi Bot (2)")
})

test("resolveOptions parses locale preference", () => {
  assert.equal(resolveOptions({}).locale, "auto")
  assert.equal(resolveOptions({ locale: "zh-TW" }).locale, "zht")
  assert.equal(resolveOptions({ locale: "zh-CN" }).locale, "zh")
  assert.equal(resolveOptions({ locale: "en-GB" }).locale, "en")
})

test("GUI catalog defines identical keys across en, zh, zht and aliases", () => {
  const enKeys = Object.keys(guiCatalog.en).sort()
  const zhKeys = Object.keys(guiCatalog.zh).sort()
  const zhtKeys = Object.keys(guiCatalog.zht).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.deepEqual(zhtKeys, enKeys)
  assert.equal(guiCatalog["zh-CN"], guiCatalog.zh)
  assert.equal(guiCatalog["zh-Hans"], guiCatalog.zh)
  assert.equal(guiCatalog["zh-TW"], guiCatalog.zht)
  assert.equal(guiCatalog["zh-HK"], guiCatalog.zht)
  assert.equal(guiCatalog["zh-Hant"], guiCatalog.zht)

  const tZh = createGuiTranslator("zh")
  assert.equal(tZh("takeover.cardPrefix", { reason: "登录" }), "人工接管：登录")
  const tEn = createGuiTranslator("en")
  assert.equal(tEn("takeover.cardPrefix", { reason: "Login" }), "Human takeover: Login")
})

test("Server and Web Console catalogs define identical keys across en, zh, zht", () => {
  const enServerKeys = Object.keys(SERVER_TABLES.en).sort()
  assert.deepEqual(Object.keys(SERVER_TABLES.zh).sort(), enServerKeys)
  assert.deepEqual(Object.keys(SERVER_TABLES.zht).sort(), enServerKeys)
  for (const key of enServerKeys as ServerMessageKey[]) {
    assert.ok(tServer("en", key).length > 0)
    assert.ok(tServer("zh", key).length > 0)
    assert.ok(tServer("zht", key).length > 0)
  }

  const enWebKeys = Object.keys(WEB_CONSOLE_I18N.en).sort()
  assert.deepEqual(Object.keys(WEB_CONSOLE_I18N.zh).sort(), enWebKeys)
  assert.deepEqual(Object.keys(WEB_CONSOLE_I18N.zht).sort(), enWebKeys)
})

test("renderConsoleHtml renders the requested locale and talks only to the bot RPC", () => {
  assert.match(renderConsoleHtml("en"), /<html lang="en-US">/)
  assert.match(renderConsoleHtml("zh"), /<html lang="zh-CN">/)
  assert.match(renderConsoleHtml("zht"), /<html lang="zh-TW">/)
  const html = renderConsoleHtml("zh")
  assert.match(html, /Mac 远程控制/)
  assert.match(html, /\/api\/rpc\/bot\//)
  assert.doesNotMatch(html, /fetch\("\/api\//)
})
