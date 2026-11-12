const esbuild = require("esbuild");
const path = require("path");

const provided = [
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
  "solid-js/h",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
  "electron"
];

(async () => {
  try {
    await esbuild.build({
      entryPoints: ["src/gui.ts"],
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "cjs",
      outfile: "dist/gui-experimental.cjs",
      external: provided,
      sourcemap: true,
    });
    console.log("Successfully built dist/gui-experimental.cjs");
  } catch (err) {
    console.error("Build failed:", err);
    process.exit(1);
  }
})();
