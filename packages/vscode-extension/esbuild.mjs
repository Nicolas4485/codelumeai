// Bundles src/extension.ts (and everything it imports, including
// @codelumeai/core) into a single CommonJS file at dist/extension.js.
// Required for vsce packaging in a pnpm workspace — otherwise the
// .vsix has unresolvable symlinks into node_modules.
//
// Also copies sql-wasm.wasm into dist/ so the graph store can load it
// at runtime inside the packaged .vsix (node_modules is not shipped).

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  loader: { ".wasm": "file" },
};

function copyWasm() {
  const src = path.join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const dest = path.join(__dirname, "dist", "sql-wasm.wasm");
  if (!fs.existsSync(src)) {
    console.error("esbuild: sql-wasm.wasm not found at", src);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const size = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`  dist/sql-wasm.wasm  ${size}kb`);
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyWasm();
  console.warn("esbuild: watching for changes…");
} else {
  await esbuild.build(buildOptions);
  copyWasm();
}
