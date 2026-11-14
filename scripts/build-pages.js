import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { renderConsoleHtml } from "../src/console/page.ts"

// Static Web/Mobile console for Cloudflare Pages: `npx wrangler pages deploy pages --project-name bot-console`.
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pages")
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, "index.html"), renderConsoleHtml("en"))
writeFileSync(
  path.join(out, "_headers"),
  "/*\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n",
)
console.log(`Wrote ${out}`)
