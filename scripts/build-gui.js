import esbuild from "esbuild"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

// External packages matching OpenCode V2 plugin GUI runtime specification
const externals = [
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/client/solid",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "electron",
]

const externalSet = new Set(externals)

const exactExternalsPlugin = {
  name: "exact-externals",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (externalSet.has(args.path)) {
        return { path: args.path, external: true }
      }
      return null
    })
  },
}

export const guiBuildOptions = {
  entryPoints: [path.join(root, "src/gui.ts")],
  outfile: path.join(root, "dist/gui-experimental.cjs"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  plugins: [exactExternalsPlugin],
  sourcemap: true,
  logLevel: "info",
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("Building GUI bundle dist/gui-experimental.cjs...")
  await esbuild.build(guiBuildOptions)
  console.log("GUI bundle built successfully!")
}
