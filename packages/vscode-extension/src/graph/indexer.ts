import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { GraphStore } from "./store";
import type { RefRow, SymbolKind, SymbolRow } from "./types";

export interface IndexFileResult {
  file: string;
  symbolCount: number;
  refCount: number;
  durationMs: number;
  /** True if the LSP returned no symbols — usually means no language server is installed for this file's language. */
  empty: boolean;
}

/**
 * Index a single file. Extracts symbols via VS Code's
 * DocumentSymbolProvider, then for each symbol asks ReferenceProvider
 * for usages, and writes both into the GraphStore.
 *
 * The caller is responsible for batching and calling store.save()
 * after a batch — we don't save here because saving rewrites the
 * whole DB file (sql.js limitation) and that's expensive.
 */
export async function indexFile(args: {
  store: GraphStore;
  uri: vscode.Uri;
  workspaceFolder: vscode.Uri;
  cancellation?: vscode.CancellationToken;
}): Promise<IndexFileResult> {
  const startedAt = Date.now();
  const relPath = workspaceRelative(args.workspaceFolder, args.uri);

  // We open the document explicitly so the file's language server has it
  // loaded before we ask for symbols. Without this, the LSP often returns
  // empty results for files that haven't been opened in the editor yet.
  const doc = await vscode.workspace.openTextDocument(args.uri);
  const contentHash = sha256(doc.getText());

  args.store.upsertFile({
    path: relPath,
    language: doc.languageId,
    contentHash,
  });
  args.store.clearFile(relPath);

  if (args.cancellation?.isCancellationRequested) {
    return {
      file: relPath,
      symbolCount: 0,
      refCount: 0,
      durationMs: Date.now() - startedAt,
      empty: true,
    };
  }

  const docSymbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      args.uri,
    )) ?? [];

  if (docSymbols.length === 0) {
    return {
      file: relPath,
      symbolCount: 0,
      refCount: 0,
      durationMs: Date.now() - startedAt,
      empty: true,
    };
  }

  const symbols: SymbolRow[] = [];
  flattenSymbols(docSymbols, relPath, undefined, symbols);
  args.store.insertSymbols(symbols);

  // For each symbol, ask the LSP "where else is this used?". This is the
  // expensive part — one RPC per symbol. For a 245-line file with ~30
  // symbols, expect ~1–3 seconds depending on the LSP.
  const refs: RefRow[] = [];
  for (const sym of symbols) {
    if (args.cancellation?.isCancellationRequested) break;

    const position = new vscode.Position(sym.startLine - 1, sym.startChar);
    let locations: vscode.Location[] = [];
    try {
      locations =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          args.uri,
          position,
        )) ?? [];
    } catch {
      // Some LSPs throw on certain symbol kinds (e.g. local variables in
      // some Python configs). Skip — the indexer should never fail a
      // whole file because of one symbol.
      continue;
    }

    for (const loc of locations) {
      const fromRel = workspaceRelative(args.workspaceFolder, loc.uri);
      const fromLine = loc.range.start.line + 1; // 1-indexed
      const fromChar = loc.range.start.character;

      // Skip the definition itself — many LSPs include it in the
      // reference list. We want USES, not the def.
      if (fromRel === sym.file && fromLine === sym.startLine) continue;

      refs.push({
        toSymbol: sym.id,
        fromFile: fromRel,
        fromLine,
        fromChar,
      });
    }
  }

  args.store.insertRefs(refs);

  return {
    file: relPath,
    symbolCount: symbols.length,
    refCount: refs.length,
    durationMs: Date.now() - startedAt,
    empty: false,
  };
}

/** Recursively walk DocumentSymbol[] (which can be tree-shaped) into a flat list. */
function flattenSymbols(
  syms: vscode.DocumentSymbol[],
  file: string,
  parentId: string | undefined,
  out: SymbolRow[],
): void {
  for (const sym of syms) {
    const kindName = symbolKindName(sym.kind);
    const startLine = sym.range.start.line + 1; // 1-indexed
    const id = GraphStore.computeSymbolId({
      file,
      name: sym.name,
      startLine,
      kind: kindName,
    });
    out.push({
      id,
      name: sym.name,
      kind: kindName,
      file,
      startLine,
      endLine: sym.range.end.line + 1,
      startChar: sym.selectionRange.start.character,
      endChar: sym.selectionRange.end.character,
      detail: sym.detail || undefined,
      parentId,
    });
    if (sym.children && sym.children.length > 0) {
      flattenSymbols(sym.children, file, id, out);
    }
  }
}

/** Map vscode.SymbolKind (numeric enum) → our SymbolKind string union. */
function symbolKindName(kind: vscode.SymbolKind): SymbolKind {
  const names: Record<number, SymbolKind> = {
    [vscode.SymbolKind.File]: "file",
    [vscode.SymbolKind.Module]: "module",
    [vscode.SymbolKind.Namespace]: "namespace",
    [vscode.SymbolKind.Package]: "package",
    [vscode.SymbolKind.Class]: "class",
    [vscode.SymbolKind.Method]: "method",
    [vscode.SymbolKind.Property]: "property",
    [vscode.SymbolKind.Field]: "field",
    [vscode.SymbolKind.Constructor]: "constructor",
    [vscode.SymbolKind.Enum]: "enum",
    [vscode.SymbolKind.Interface]: "interface",
    [vscode.SymbolKind.Function]: "function",
    [vscode.SymbolKind.Variable]: "variable",
    [vscode.SymbolKind.Constant]: "constant",
    [vscode.SymbolKind.String]: "string",
    [vscode.SymbolKind.Number]: "number",
    [vscode.SymbolKind.Boolean]: "boolean",
    [vscode.SymbolKind.Array]: "array",
    [vscode.SymbolKind.Object]: "object",
    [vscode.SymbolKind.Key]: "key",
    [vscode.SymbolKind.Null]: "null",
    [vscode.SymbolKind.EnumMember]: "enumMember",
    [vscode.SymbolKind.Struct]: "struct",
    [vscode.SymbolKind.Event]: "event",
    [vscode.SymbolKind.Operator]: "operator",
    [vscode.SymbolKind.TypeParameter]: "typeParameter",
  };
  return names[kind as number] ?? "variable";
}

/** Convert a vscode.Uri to a forward-slash workspace-relative path. */
function workspaceRelative(workspaceFolder: vscode.Uri, file: vscode.Uri): string {
  const ws = workspaceFolder.fsPath.replace(/\\/g, "/");
  const f = file.fsPath.replace(/\\/g, "/");
  if (f.startsWith(ws + "/")) return f.slice(ws.length + 1);
  return f;
}

function sha256(text: string): string {
  const h = createHash("sha256");
  h.update(text);
  return h.digest("hex").slice(0, 16);
}

/** Extensions to try when resolving an extensionless import path. */
const RESOLVE_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];

/**
 * Supplement the LSP ref graph with statically-parsed import edges.
 *
 * Scans every TS/JS file for `import`/`export from`/`require()` statements,
 * resolves relative paths to workspace-relative file paths, and inserts a
 * ref edge for each one that is not already in the DB.
 *
 * This is a pure additive pass — it never removes existing refs, never
 * overwrites LSP data. It runs *after* the main LSP indexing loop so the
 * LSP data takes precedence and this only fills the gaps.
 *
 * Key gaps it closes:
 * - LSP warmup: the TS server hasn't analysed all files during early indexing
 * - Barrel re-exports: `export * from './utils'` often produces 0 LSP refs
 * - Entry points: files that only import but export nothing have 0 symbols
 */
export async function supplementWithStaticImports(args: {
  store: GraphStore;
  workspaceFolder: vscode.Uri;
  output: vscode.OutputChannel;
  cancellation?: vscode.CancellationToken;
}): Promise<number> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(
      args.workspaceFolder,
      "**/*.{ts,tsx,js,jsx,mjs,cjs}",
    ),
    new vscode.RelativePattern(
      args.workspaceFolder,
      "{node_modules,dist,build,.git,.turbo}/**",
    ),
  );

  // Pre-build a lookup set — avoid per-import DB queries for unknown files
  const knownFiles = args.store.getAllIndexedFilePaths();

  let edgesAdded = 0;

  for (const uri of uris) {
    if (args.cancellation?.isCancellationRequested) break;

    const fromRel = workspaceRelative(args.workspaceFolder, uri);

    let text: string;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      text = doc.getText();
    } catch {
      continue;
    }

    for (const importPath of extractImportPaths(text)) {
      if (!importPath.startsWith(".")) continue; // skip node_modules

      const base = resolveRelativeImport(importPath, fromRel);
      if (!base || base === fromRel) continue;

      // Try the path as-is then with each extension
      const candidates = [base, ...RESOLVE_EXTS.map((ext) => base + ext)];

      for (const candidate of candidates) {
        if (!knownFiles.has(candidate)) continue;

        const symbolId = args.store.getFirstSymbolIdForFile(candidate);
        if (!symbolId) break; // file has no symbols — can't hang a ref from it

        const added = args.store.upsertImportEdge(fromRel, symbolId);
        if (added) edgesAdded++;
        break; // matched — stop trying extensions
      }
    }
  }

  args.output.appendLine(
    `[graph] Static import supplement: +${edgesAdded} import edge(s) added.`,
  );
  return edgesAdded;
}

/** Extract all import/require source strings from TS/JS source text. */
function extractImportPaths(text: string): string[] {
  const paths: string[] = [];
  // import ... from '...'  |  export ... from '...'  (static)
  const staticRe =
    /(?:^|[\r\n])\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(text)) !== null) {
    if (m[1]) paths.push(m[1]);
  }
  // require('...')
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(text)) !== null) {
    if (m[1]) paths.push(m[1]);
  }
  return paths;
}

/**
 * Resolve a relative import path to a workspace-relative path string
 * (WITHOUT extension — the caller tries extensions separately).
 * Returns null if the path escapes the workspace root.
 */
function resolveRelativeImport(
  importPath: string,
  fromRelFile: string,
): string | null {
  const slashIdx = fromRelFile.lastIndexOf("/");
  const fromDir = slashIdx >= 0 ? fromRelFile.slice(0, slashIdx) : "";
  const combined = fromDir ? `${fromDir}/${importPath}` : importPath;

  const segments = combined.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (resolved.length === 0) return null; // would escape workspace root
      resolved.pop();
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }
  return resolved.length > 0 ? resolved.join("/") : null;
}
