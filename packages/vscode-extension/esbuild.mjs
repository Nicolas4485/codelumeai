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
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.warn("esbuild: watching for changes…");
} else {
  await esbuild.build(buildOptions);
}
