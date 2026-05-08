// Mirrors VS Code's vscode.SymbolKind names. We carry the LSP's kind through
// to the DB rather than mapping to a smaller enum — preserves fidelity for
// future filters ("show me only classes", "highlight enum members") and lets
// the UI render kind-specific icons later.
export type SymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enumMember"
  | "struct"
  | "event"
  | "operator"
  | "typeParameter";

/** A definition the LSP recognizes — a function, class, method, etc. */
export interface SymbolRow {
  /** Stable across re-indexes. sha256(file:name:start_line:kind) truncated to 16 chars. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** Workspace-relative path with forward slashes. */
  file: string;
  /** 1-indexed inclusive — matches our translation chunks. */
  startLine: number;
  endLine: number;
  /** 0-indexed character columns from VS Code's Range. */
  startChar: number;
  endChar: number;
  /** Optional signature/type info from the LSP (e.g., the function signature). */
  detail?: string;
  /** Parent symbol's id for nested symbols (methods inside classes). */
  parentId?: string;
}

/**
 * A reference is a USE of a symbol at some location.
 * The location is (fromFile, fromLine, fromChar). The symbol being used
 * is `toSymbol`. The "from symbol" containing this use is implicit — we
 * resolve it at query time by checking which symbol's range contains the
 * location.
 */
export interface RefRow {
  toSymbol: string;
  fromFile: string;
  /** 1-indexed line number. */
  fromLine: number;
  /** 0-indexed character column. */
  fromChar: number;
}

/**
 * The "Connected" data for one chunk in the side panel.
 * - outgoing: symbols referenced from inside the chunk that are defined elsewhere
 * - incoming: symbols defined inside the chunk that are used elsewhere, with use counts
 */
export interface ConnectedSymbols {
  outgoing: SymbolRow[];
  incoming: Array<{ symbol: SymbolRow; refCount: number }>;
}
