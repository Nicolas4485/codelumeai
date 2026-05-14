// Bundles src/extension.ts (and everything it imports, including
// @codelumeai/core) into a single CommonJS file at dist/extension.js.
// Required for vsce packaging in a pnpm workspace — otherwise the
// .vsix has unresolvable symlinks into node_modules.

import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "sql.js"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // sql.js needs its WASM file at runtime; we load it from node_modules
  // at extension-host time. For .vsix packaging, the wasm gets copied
  // alongside dist/ — see scripts/copy-wasm.mjs (added in step 5.4).
  loader: { ".wasm": "file" },
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.warn("esbuild: watching for changes…");
} else {
  await esbuild.build(buildOptions);
}
