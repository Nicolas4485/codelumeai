import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { Database, SqlJsStatic } from "sql.js";
import { SCHEMA_SQL } from "./schema";
import type { ConnectedSymbols, RefLocation, RefRow, SymbolKind, SymbolRow } from "./types";

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
}

export interface TopSymbol {
  id: string;
  name: string;
  kind: string;
  file: string;
  startLine: number;
  totalRefs: number;
}

export interface FileStat {
  path: string;
  language: string;
  symbolCount: number;
  incomingRefs: number;
  outgoingDeps: number;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

/**
 * Initialize sql.js once per process. Uses a dynamic require so sql.js's
 * Emscripten bootstrap code does NOT run at extension-host startup — only
 * the first time GraphStore.open() is actually called. Without this deferral
 * the extension host can time-out on the 10-second startup window.
 *
 * The WASM blob lives at:
 *   - dev (F5): node_modules/sql.js/dist/sql-wasm.wasm
 *   - packaged (.vsix): dist/sql-wasm.wasm (copied at build time)
 */
function loadSqlJs(extensionPath: string): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = (require("sql.js") as { default: (config: object) => Promise<SqlJsStatic> }).default;
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => {
        const candidates = [
          path.join(extensionPath, "node_modules", "sql.js", "dist", file),
          path.join(extensionPath, "dist", file),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) return candidate;
        }
        return file;
      },
    });
  }
  return sqlJsPromise;
}

/**
 * SQLite-backed graph store for code symbols and their references.
 *
 * Uses sql.js (pure-WASM SQLite) instead of better-sqlite3 to avoid
 * native-module compilation issues — relevant on Windows + Node 24
 * during dev, and even more relevant for marketplace .vsix packaging.
 *
 * Persistence model: load the file into memory on open(), mutate
 * in-memory during indexing, call save() to flush to disk. Since
 * indexing is a batch operation (workspace-level run, not per-keystroke),
 * the export-and-write cost is amortised.
 */
export class GraphStore {
  private constructor(
    private readonly db: Database,
    private readonly dbPath: string,
  ) {}

  /** Open or create the graph DB at dbPath. Schema is applied automatically. */
  static async open(args: {
    extensionPath: string;
    dbPath: string;
  }): Promise<GraphStore> {
    const SQL = await loadSqlJs(args.extensionPath);
    fs.mkdirSync(path.dirname(args.dbPath), { recursive: true });
    const data = fs.existsSync(args.dbPath)
      ? new Uint8Array(fs.readFileSync(args.dbPath))
      : undefined;
    const db = new SQL.Database(data);
    db.exec(SCHEMA_SQL);
    return new GraphStore(db, args.dbPath);
  }

  /** Stable id for a symbol given its location and kind. */
  static computeSymbolId(args: {
    file: string;
    name: string;
    startLine: number;
    kind: string;
  }): string {
    const h = createHash("sha256");
    h.update(`${args.file}:${args.name}:${String(args.startLine)}:${args.kind}`);
    return h.digest("hex").slice(0, 16);
  }

  /** Hash a workspace folder path so we get a per-workspace DB filename. */
  static workspaceHash(workspacePath: string): string {
    const h = createHash("sha256");
    h.update(workspacePath);
    return h.digest("hex").slice(0, 8);
  }

  /** Compute the on-disk DB path for a given workspace folder. */
  static dbPathForWorkspace(
    globalStorageUri: vscode.Uri,
    workspacePath: string,
  ): string {
    return path.join(
      globalStorageUri.fsPath,
      `graph-${GraphStore.workspaceHash(workspacePath)}.db`,
    );
  }

  /** Flush the in-memory DB to disk. Call after batch operations. */
  save(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, data);
  }

  upsertFile(args: {
    path: string;
    language: string;
    contentHash: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, language, content_hash, indexed_at)
      VALUES (:path, :lang, :hash, :ts)
      ON CONFLICT (path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at
    `);
    stmt.run({
      ":path": args.path,
      ":lang": args.language,
      ":hash": args.contentHash,
      ":ts": Date.now(),
    });
    stmt.free();
  }

  /** Drop all symbols and refs originating in this file (so we can re-index cleanly). */
  clearFile(filePath: string): void {
    const s1 = this.db.prepare(`DELETE FROM symbols WHERE file = :f`);
    s1.run({ ":f": filePath });
    s1.free();
    const s2 = this.db.prepare(`DELETE FROM refs WHERE from_file = :f`);
    s2.run({ ":f": filePath });
    s2.free();
  }

  insertSymbols(symbols: SymbolRow[]): void {
    if (symbols.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, name, kind, file, start_line, end_line, start_char, end_char, detail, parent_id)
      VALUES (:id, :name, :kind, :file, :sl, :el, :sc, :ec, :detail, :parent)
    `);
    this.db.exec("BEGIN");
    try {
      for (const s of symbols) {
        stmt.run({
          ":id": s.id,
          ":name": s.name,
          ":kind": s.kind,
          ":file": s.file,
          ":sl": s.startLine,
          ":el": s.endLine,
          ":sc": s.startChar,
          ":ec": s.endChar,
          ":detail": s.detail ?? null,
          ":parent": s.parentId ?? null,
        });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      stmt.free();
    }
  }

  insertRefs(refs: RefRow[]): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO refs (to_symbol, from_file, from_line, from_char)
      VALUES (:to, :from, :line, :char)
    `);
    this.db.exec("BEGIN");
    try {
      for (const r of refs) {
        stmt.run({
          ":to": r.toSymbol,
          ":from": r.fromFile,
          ":line": r.fromLine,
          ":char": r.fromChar,
        });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      stmt.free();
    }
  }

  /**
   * For a chunk at file/lines, return:
   *  - outgoing: symbols referenced from inside the chunk whose definition
   *    is somewhere ELSE (a different file, or a different chunk in the same file)
   *  - incoming: symbols defined inside the chunk that are used elsewhere,
   *    with reference counts (only counts uses outside the chunk)
   */
  getChunkConnections(args: {
    file: string;
    startLine: number;
    endLine: number;
  }): ConnectedSymbols {
    const outgoingStmt = this.db.prepare(`
      SELECT DISTINCT s.id, s.name, s.kind, s.file,
             s.start_line as startLine, s.end_line as endLine,
             s.start_char as startChar, s.end_char as endChar,
             s.detail, s.parent_id as parentId
      FROM refs r
      JOIN symbols s ON r.to_symbol = s.id
      WHERE r.from_file = :file
        AND r.from_line BETWEEN :sl AND :el
        AND NOT (s.file = :file AND s.start_line BETWEEN :sl AND :el)
      ORDER BY s.name
    `);
    outgoingStmt.bind({
      ":file": args.file,
      ":sl": args.startLine,
      ":el": args.endLine,
    });
    const outgoing: SymbolRow[] = [];
    while (outgoingStmt.step()) {
      outgoing.push(outgoingStmt.getAsObject() as unknown as SymbolRow);
    }
    outgoingStmt.free();

    const incomingStmt = this.db.prepare(`
      SELECT s.id, s.name, s.kind, s.file,
             s.start_line as startLine, s.end_line as endLine,
             s.start_char as startChar, s.end_char as endChar,
             s.detail, s.parent_id as parentId,
             (SELECT COUNT(*) FROM refs r
              WHERE r.to_symbol = s.id
                AND NOT (r.from_file = s.file AND r.from_line BETWEEN :sl AND :el))
               AS refCount
      FROM symbols s
      WHERE s.file = :file AND s.start_line BETWEEN :sl AND :el
    `);
    incomingStmt.bind({
      ":file": args.file,
      ":sl": args.startLine,
      ":el": args.endLine,
    });
    const rawIncoming: Array<{ symbol: SymbolRow; refCount: number }> = [];
    while (incomingStmt.step()) {
      const row = incomingStmt.getAsObject() as unknown as SymbolRow & {
        refCount: number;
      };
      if (row.refCount && row.refCount > 0) {
        const { refCount, ...sym } = row;
        rawIncoming.push({ symbol: sym, refCount });
      }
    }
    incomingStmt.free();
    rawIncoming.sort(
      (a, b) =>
        b.refCount - a.refCount || a.symbol.name.localeCompare(b.symbol.name),
    );

    // Fetch the actual ref locations for each incoming symbol so the UI can
    // render a drilldown list. IDs are sha256 hex (safe to inline).
    // The correlated subquery finds the narrowest enclosing function/method
    // for each ref by picking the containing symbol with the smallest line range.
    const refsBySymbol = new Map<string, RefLocation[]>();
    if (rawIncoming.length > 0) {
      const idList = rawIncoming.map((i) => `'${i.symbol.id}'`).join(",");
      const refsStmt = this.db.prepare(`
        SELECT r.to_symbol, r.from_file, r.from_line,
          (SELECT s2.name FROM symbols s2
           WHERE s2.file = r.from_file
             AND r.from_line BETWEEN s2.start_line AND s2.end_line
             AND s2.kind IN ('function','method','constructor','class')
           ORDER BY (s2.end_line - s2.start_line) ASC
           LIMIT 1) AS in_name,
          (SELECT s2.kind FROM symbols s2
           WHERE s2.file = r.from_file
             AND r.from_line BETWEEN s2.start_line AND s2.end_line
             AND s2.kind IN ('function','method','constructor','class')
           ORDER BY (s2.end_line - s2.start_line) ASC
           LIMIT 1) AS in_kind
        FROM refs r
        WHERE r.to_symbol IN (${idList})
          AND NOT (r.from_file = :file AND r.from_line BETWEEN :sl AND :el)
        ORDER BY r.from_file, r.from_line
      `);
      refsStmt.bind({ ":file": args.file, ":sl": args.startLine, ":el": args.endLine });
      while (refsStmt.step()) {
        const r = refsStmt.getAsObject() as unknown as {
          to_symbol: string;
          from_file: string;
          from_line: number;
          in_name: string | null;
          in_kind: string | null;
        };
        let list = refsBySymbol.get(r.to_symbol);
        if (!list) { list = []; refsBySymbol.set(r.to_symbol, list); }
        const loc: RefLocation = { file: r.from_file, line: r.from_line };
        if (r.in_name && r.in_kind) {
          loc.inSymbol = { name: r.in_name, kind: r.in_kind as SymbolKind };
        }
        list.push(loc);
      }
      refsStmt.free();
    }

    const incoming = rawIncoming.map((item) => ({
      ...item,
      refs: refsBySymbol.get(item.symbol.id) ?? [],
    }));

    return { outgoing, incoming };
  }

  /**
   * All cross-file dependency edges, capped for rendering performance.
   * Each edge represents one file importing/calling symbols from another.
   * Weight = number of distinct symbol references between the two files.
   */
  getGraphEdges(maxEdges = 400): GraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT r.from_file AS "from", s.file AS "to", COUNT(*) AS weight
      FROM refs r
      JOIN symbols s ON r.to_symbol = s.id
      WHERE r.from_file != s.file
      GROUP BY r.from_file, s.file
      ORDER BY weight DESC
      LIMIT :limit
    `);
    stmt.bind({ ":limit": maxEdges });
    const results: GraphEdge[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as GraphEdge);
    }
    stmt.free();
    return results;
  }

  /**
   * Top N symbols by number of distinct files that reference them.
   * Used by the onboarding panel to surface the most important concepts.
   */
  getTopSymbols(limit: number): TopSymbol[] {
    const stmt = this.db.prepare(`
      SELECT s.id, s.name, s.kind, s.file, s.start_line AS startLine,
             COUNT(DISTINCT r.from_file) AS totalRefs
      FROM symbols s
      JOIN refs r ON r.to_symbol = s.id
      WHERE r.from_file != s.file
      GROUP BY s.id
      ORDER BY totalRefs DESC
      LIMIT :limit
    `);
    stmt.bind({ ":limit": limit });
    const results: TopSymbol[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as TopSymbol);
    }
    stmt.free();
    return results;
  }

  /**
   * Per-file stats used by the onboarding reading-order view.
   * incomingRefs = distinct files that use anything from this file.
   * outgoingDeps = distinct files this file pulls symbols from.
   */
  getFileStats(): FileStat[] {
    const stmt = this.db.prepare(`
      SELECT
        f.path,
        f.language,
        (SELECT COUNT(*) FROM symbols s WHERE s.file = f.path) AS symbolCount,
        (SELECT COUNT(DISTINCT r.from_file)
           FROM refs r JOIN symbols s ON r.to_symbol = s.id
           WHERE s.file = f.path AND r.from_file != f.path) AS incomingRefs,
        (SELECT COUNT(DISTINCT s2.file)
           FROM refs r2 JOIN symbols s2 ON r2.to_symbol = s2.id
           WHERE r2.from_file = f.path AND s2.file != f.path) AS outgoingDeps
      FROM files f
      ORDER BY incomingRefs DESC, symbolCount DESC
    `);
    const results: FileStat[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as FileStat);
    }
    stmt.free();
    return results;
  }

  /** Diagnostic counts for the status bar / output channel. */
  stats(): { files: number; symbols: number; refs: number } {
    const files = this.scalar("SELECT COUNT(*) FROM files");
    const symbols = this.scalar("SELECT COUNT(*) FROM symbols");
    const refs = this.scalar("SELECT COUNT(*) FROM refs");
    return { files, symbols, refs };
  }

  private scalar(sql: string): number {
    const stmt = this.db.prepare(sql);
    stmt.step();
    const row = stmt.get();
    stmt.free();
    return Number(row[0] ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
