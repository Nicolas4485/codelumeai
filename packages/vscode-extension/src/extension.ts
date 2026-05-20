import * as path from "node:path";
import * as vscode from "vscode";
import {
  translate,
  hashContent,
  MemoryCache,
  TranslationError,
  type Translation,
  type Chunk,
  type LineEntry,
} from "@codelumeai/core";
import { SidePanel } from "./sidePanel";
import { EditFlow } from "./editFlow";
import { GraphStore } from "./graph/store";
import { indexFile } from "./graph/indexer";
import { GraphPanel } from "./graph/graphPanel";
import { OnboardingPanel } from "./onboarding/panel";
import type { ConnectedSymbols } from "./graph/types";
import {
  generateBriefing,
  chatWithCodebase,
  type Briefing,
  type ChatMessage,
} from "@codelumeai/core";

const SECRET_KEY = "codelumeai.apiKey";
const CACHE_SCHEMA_VERSION = "v4";

const SUPPORTED_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
  "html",
  "css",
  "scss",
  "go",
  "rust",
  "java",
  "csharp",
  "ruby",
  "php",
];

type Mode = "off" | "hover" | "always-on";

/** Files that may need updating after the most recent EditFlow apply. */
interface RecentImpact {
  /** Workspace-relative paths of connected files that might be affected. */
  affectedFiles: Set<string>;
}

interface ExtensionState {
  context: vscode.ExtensionContext;
  cache: MemoryCache<Translation>;
  inlayHintsEmitter: vscode.EventEmitter<void>;
  statusBar: vscode.StatusBarItem;
  inFlight: Map<string, Promise<Translation | undefined>>;
  output: vscode.OutputChannel;
  sidePanel: SidePanel;
  onboardingPanel: OnboardingPanel | undefined;
  graphPanel: GraphPanel | undefined;
  graphStore: GraphStore | undefined;
  /** In-flight or completed init promise — prevents double-open. */
  graphStoreInitPromise: Promise<void> | undefined;
  workspaceFolderUri: vscode.Uri | undefined;
  /** Set after an edit is applied; cleared when the active editor changes. */
  recentImpact: RecentImpact | undefined;
}

function log(
  state: ExtensionState,
  level: "info" | "warn" | "error",
  message: string,
): void {
  const ts = new Date().toISOString();
  state.output.appendLine(`[${ts}] [${level}] ${message}`);
}

/**
 * Walk the translation's chunks, return any gaps in line coverage that
 * contain actual non-blank source content. Each gap is a [startLine,
 * endLine] tuple (1-indexed, inclusive).
 *
 * Used after every translation to detect when the model skipped a
 * function or block. Gaps that are entirely whitespace (blank lines
 * between chunks) are filtered out — they are not "missing translation",
 * just normal source spacing.
 */
function findCoverageGaps(
  translation: Translation,
  document: vscode.TextDocument,
): Array<[number, number]> {
  const totalLines = document.lineCount;
  if (totalLines <= 0) return [];
  const covered = new Array<boolean>(totalLines + 1).fill(false);
  for (const chunk of translation.chunks) {
    const start = Math.max(1, chunk.startLine);
    const end = Math.min(totalLines, chunk.endLine);
    for (let i = start; i <= end; i++) {
      covered[i] = true;
    }
  }
  const rawGaps: Array<[number, number]> = [];
  let gapStart = -1;
  for (let i = 1; i <= totalLines; i++) {
    if (!covered[i]) {
      if (gapStart === -1) gapStart = i;
    } else if (gapStart !== -1) {
      rawGaps.push([gapStart, i - 1]);
      gapStart = -1;
    }
  }
  if (gapStart !== -1) rawGaps.push([gapStart, totalLines]);

  // Drop gaps that are entirely blank — those aren't missing translation,
  // just whitespace between chunks. Keep gaps with any non-blank line.
  return rawGaps.filter(([start, end]) => {
    for (let i = start; i <= end; i++) {
      // document line indices are 0-based.
      const text = document.lineAt(i - 1).text.trim();
      if (text.length > 0) return true;
    }
    return false;
  });
}

function workspaceRelative(workspaceFolder: vscode.Uri, file: vscode.Uri): string {
  const ws = workspaceFolder.fsPath.replace(/\\/g, "/");
  const f = file.fsPath.replace(/\\/g, "/");
  if (f.startsWith(ws + "/")) return f.slice(ws.length + 1);
  return f;
}

/**
 * Lazy-open the graph store. Safe to call multiple times — only opens once.
 * Does NOT run during activate(); called on first user action that needs it
 * (openSidePanel or indexWorkspace). This keeps sql.js's Emscripten bootstrap
 * code out of the extension-host startup path.
 */
function ensureGraphStore(state: ExtensionState): Promise<void> {
  if (state.graphStore) return Promise.resolve();
  if (!state.workspaceFolderUri) return Promise.resolve();
  if (!state.graphStoreInitPromise) {
    state.graphStoreInitPromise = (async () => {
      try {
        const dbPath = GraphStore.dbPathForWorkspace(
          state.context.globalStorageUri,
          (state.workspaceFolderUri as vscode.Uri).fsPath,
        );
        state.graphStore = await GraphStore.open({
          extensionPath: state.context.extensionPath,
          dbPath,
        });
        const s = state.graphStore.stats();
        log(state, "info", `Graph store ready. ${s.files} files, ${s.symbols} symbols, ${s.refs} refs.`);
      } catch (err) {
        state.graphStoreInitPromise = undefined; // allow retry
        log(state, "warn", `Graph store init failed (connections unavailable): ${String(err)}`);
      }
    })();
  }
  return state.graphStoreInitPromise;
}

function maybeGetGraphConnections(
  state: ExtensionState,
  translation: Translation,
  document: vscode.TextDocument,
): Array<ConnectedSymbols | null> | undefined {
  if (!state.graphStore || !state.workspaceFolderUri) return undefined;
  try {
    if (state.graphStore.stats().files === 0) return undefined;
    const rel = workspaceRelative(state.workspaceFolderUri, document.uri);
    return translation.chunks.map((chunk) => {
      try {
        return (state.graphStore as GraphStore).getChunkConnections({
          file: rel,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        });
      } catch {
        return null;
      }
    });
  } catch {
    return undefined;
  }
}

function sidePanelUpdate(
  state: ExtensionState,
  translation: Translation,
  document: vscode.TextDocument,
): void {
  const connections = maybeGetGraphConnections(state, translation, document);
  state.sidePanel.update(translation, document, connections);
}

function refreshSidePanelIfNeeded(state: ExtensionState): void {
  if (!state.sidePanel.isOpen() || !state.workspaceFolderUri) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || !SUPPORTED_LANGUAGES.includes(editor.document.languageId)) return;
  const config = vscode.workspace.getConfiguration("codelumeai");
  const model = config.get<string>("model", "claude-haiku-4-5");
  const cacheKey = hashContent(editor.document.getText(), editor.document.languageId, model, CACHE_SCHEMA_VERSION);
  const cached = state.cache.get(cacheKey);
  if (!cached) return;
  sidePanelUpdate(state, cached.value, editor.document);
}

function getMode(): Mode {
  return vscode.workspace
    .getConfiguration("codelumeai")
    .get<Mode>("mode", "hover");
}

async function setMode(mode: Mode): Promise<void> {
  await vscode.workspace
    .getConfiguration("codelumeai")
    .update("mode", mode, vscode.ConfigurationTarget.Global);
}

function chunkContainingLine(
  chunks: Chunk[],
  zeroBasedLine: number,
): Chunk | undefined {
  const oneBased = zeroBasedLine + 1;
  return chunks.find(
    (c) => c.startLine <= oneBased && c.endLine >= oneBased,
  );
}

function lineEntryContainingLine(
  chunk: Chunk,
  zeroBasedLine: number,
): LineEntry | undefined {
  const oneBased = zeroBasedLine + 1;
  return chunk.lines.find(
    (l) => l.startLine <= oneBased && l.endLine >= oneBased,
  );
}

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `Line ${String(startLine)}`
    : `Lines ${String(startLine)}–${String(endLine)}`;
}

async function getOrFetchTranslation(
  state: ExtensionState,
  document: vscode.TextDocument,
): Promise<Translation | undefined> {
  const apiKey = await state.context.secrets.get(SECRET_KEY);
  if (!apiKey) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("codelumeai");
  const model = config.get<string>("model", "claude-haiku-4-5");
  const maxLines = config.get<number>("maxFileLines", 2000);

  if (document.lineCount > maxLines) {
    log(
      state,
      "info",
      `Skipping translation: ${document.lineCount} lines > maxFileLines (${maxLines}).`,
    );
    return undefined;
  }

  const source = document.getText();
  const cacheKey = hashContent(
    source,
    document.languageId,
    model,
    CACHE_SCHEMA_VERSION,
  );

  const cached = state.cache.get(cacheKey);
  if (cached) {
    return cached.value;
  }

  const inFlight = state.inFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const filename = document.fileName.split(/[\\/]/).pop();
  log(
    state,
    "info",
    `Translating ${filename ?? "(unnamed)"} (${document.lineCount} lines, lang=${document.languageId}, model=${model})`,
  );

  const promise = (async (): Promise<Translation | undefined> => {
    const startedAt = Date.now();
    try {
      const translation = await translate({
        apiKey,
        source,
        language: document.languageId,
        filename,
        model,
      });
      state.cache.set(cacheKey, translation);
      const elapsed = Date.now() - startedAt;
      log(
        state,
        "info",
        `Translated ${filename ?? "(unnamed)"} in ${elapsed}ms (${translation.chunks.length} chunks).`,
      );
      // Coverage check — the prompt forbids skipping functions, but the model
      // sometimes does anyway. Only flags gaps that contain actual non-blank
      // source code (whitespace between chunks is not a real gap).
      const gaps = findCoverageGaps(translation, document);
      if (gaps.length > 0) {
        const fmt = gaps.map(([s, e]) => `L${s}-${e}`).join(", ");
        log(
          state,
          "warn",
          `Coverage gaps with code in ${filename ?? "(unnamed)"}: ${fmt}. The model skipped these line ranges. Consider running "Translate Current File" again or switching to claude-sonnet-4-6 in settings.`,
        );
      }
      // Push the fresh translation to the side panel if it's open and showing this doc.
      if (state.sidePanel.isOpen()) {
        sidePanelUpdate(state, translation, document);
      }
      return translation;
    } catch (err) {
      const msg =
        err instanceof TranslationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      log(state, "error", `Translation failed for ${filename ?? "(unnamed)"}: ${msg}`);
      void vscode.window.showErrorMessage(`CodeLumeAI: ${msg}`, "Show Logs").then((choice) => {
        if (choice === "Show Logs") {
          state.output.show();
        }
      });
      return undefined;
    } finally {
      state.inFlight.delete(cacheKey);
      updateStatusBar(state);
    }
  })();
  state.inFlight.set(cacheKey, promise);
  updateStatusBar(state);
  return promise;
}

class CodeLumeHoverProvider implements vscode.HoverProvider {
  constructor(public readonly state: ExtensionState) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (getMode() !== "hover") {
      return undefined;
    }
    if (!SUPPORTED_LANGUAGES.includes(document.languageId)) {
      return undefined;
    }

    const translation = await getOrFetchTranslation(this.state, document);
    if (token.isCancellationRequested || !translation) {
      return undefined;
    }

    const chunk = chunkContainingLine(translation.chunks, position.line);
    if (!chunk) {
      return undefined;
    }

    // Notify the side panel (if open) so it highlights the matching chunk.
    if (this.state.sidePanel.isOpen()) {
      this.state.sidePanel.highlightChunkForEditorLine(position.line);
    }

    const lineEntry = lineEntryContainingLine(chunk, position.line);
    const sections: vscode.MarkdownString[] = [];

    // Section 1 — focused on the line under the cursor (when there's a match).
    if (lineEntry) {
      const lineMd = new vscode.MarkdownString();
      lineMd.supportThemeIcons = true;
      lineMd.appendMarkdown(
        `$(symbol-text) **CodeLumeAI · ${formatLineRange(lineEntry.startLine, lineEntry.endLine)}**\n\n`,
      );
      lineMd.appendMarkdown(lineEntry.english);
      sections.push(lineMd);
    }

    // Section 2 — the surrounding chunk: title, summary, all line bullets.
    const chunkMd = new vscode.MarkdownString();
    chunkMd.supportThemeIcons = true;
    chunkMd.appendMarkdown(
      `$(symbol-namespace) **CodeLumeAI · ${chunk.title}**\n\n`,
    );
    chunkMd.appendMarkdown(
      `_${formatLineRange(chunk.startLine, chunk.endLine)} · confidence: \`${chunk.confidence}\`_\n\n`,
    );
    chunkMd.appendMarkdown(`${chunk.summary}\n\n`);
    if (chunk.lines.length > 0) {
      chunkMd.appendMarkdown(`**Lines:**\n\n`);
      for (const l of chunk.lines) {
        chunkMd.appendMarkdown(
          `- **${formatLineRange(l.startLine, l.endLine)}** — ${l.english}\n`,
        );
      }
    }
    if (chunk.note) {
      chunkMd.appendMarkdown(`\n> ⚠ ${chunk.note}`);
    }
    sections.push(chunkMd);

    return new vscode.Hover(sections);
  }
}

class CodeLumeInlayHintsProvider implements vscode.InlayHintsProvider {
  readonly onDidChangeInlayHints: vscode.Event<void>;

  constructor(private readonly state: ExtensionState) {
    this.onDidChangeInlayHints = state.inlayHintsEmitter.event;
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    if (getMode() !== "always-on") {
      return [];
    }
    if (!SUPPORTED_LANGUAGES.includes(document.languageId)) {
      return [];
    }

    const translation = await getOrFetchTranslation(this.state, document);
    if (token.isCancellationRequested || !translation) {
      return [];
    }

    const hints: vscode.InlayHint[] = [];
    for (const chunk of translation.chunks) {
      const lineIdx = chunk.endLine - 1;
      if (lineIdx < range.start.line || lineIdx > range.end.line) {
        continue;
      }
      if (lineIdx < 0 || lineIdx >= document.lineCount) {
        continue;
      }

      const line = document.lineAt(lineIdx);
      const position = new vscode.Position(lineIdx, line.text.length);

      let summary = chunk.summary.trim().split("\n")[0] ?? "";
      if (summary.length > 80) {
        summary = summary.slice(0, 77) + "…";
      }

      const hint = new vscode.InlayHint(position, ` ▸ ${summary}`);
      hint.paddingLeft = true;

      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**${chunk.title}** _(${chunk.confidence})_\n\n`);
      tooltip.appendMarkdown(`${chunk.summary}\n\n`);
      if (chunk.lines.length > 0) {
        tooltip.appendMarkdown(`**Lines:**\n\n`);
        for (const l of chunk.lines) {
          tooltip.appendMarkdown(
            `- **${formatLineRange(l.startLine, l.endLine)}** — ${l.english}\n`,
          );
        }
      }
      if (chunk.note) {
        tooltip.appendMarkdown(`\n> ⚠ ${chunk.note}`);
      }
      hint.tooltip = tooltip;

      hints.push(hint);
    }
    return hints;
  }
}

function updateStatusBar(state: ExtensionState): void {
  const mode = getMode();
  const icons: Record<Mode, string> = {
    off: "$(circle-slash)",
    hover: "$(eye)",
    "always-on": "$(comment)",
  };

  if (state.inFlight.size > 0) {
    state.statusBar.text = `$(sync~spin) CodeLumeAI: translating…`;
    state.statusBar.tooltip = `Translating ${state.inFlight.size} file(s). Click for logs.`;
    state.statusBar.command = "codelumeai.showLogs";
  } else {
    state.statusBar.text = `${icons[mode]} CodeLumeAI: ${mode}`;
    state.statusBar.tooltip = "Click to cycle CodeLumeAI mode (Off → Hover → Always-on)";
    state.statusBar.command = "codelumeai.toggleMode";
  }
  state.statusBar.show();
}

async function ensureApiKeyOrPrompt(
  state: ExtensionState,
): Promise<string | undefined> {
  const existing = await state.context.secrets.get(SECRET_KEY);
  if (existing) {
    return existing;
  }
  const choice = await vscode.window.showInformationMessage(
    "CodeLumeAI needs your Anthropic API key. It's stored in VS Code's SecretStorage and never written to settings.json.",
    "Set API Key",
    "Not now",
  );
  if (choice !== "Set API Key") {
    return undefined;
  }
  await vscode.commands.executeCommand("codelumeai.setApiKey");
  return state.context.secrets.get(SECRET_KEY);
}

/** Build the context payload the briefing + chat calls need from the current graph state. */
function buildCodebaseContext(state: ExtensionState): {
  topSymbols: Parameters<typeof generateBriefing>[0]["topSymbols"];
  fileStructure: Parameters<typeof generateBriefing>[0]["fileStructure"];
  translationSummaries: Parameters<typeof generateBriefing>[0]["translationSummaries"];
} {
  const store = state.graphStore;
  if (!store) return { topSymbols: [], fileStructure: { foundations: [], features: [], entryPoints: [] }, translationSummaries: [] };

  const topSymbols = store.getTopSymbols(12);
  const fileStats = store.getFileStats().filter((f) => f.symbolCount > 0);
  const maxIn = Math.max(...fileStats.map((f) => f.incomingRefs), 1);
  const foundations = fileStats.filter((f) => f.incomingRefs >= Math.max(2, Math.ceil(maxIn * 0.4))).map((f) => f.path);
  const entryPoints = fileStats.filter((f) => f.incomingRefs === 0 && f.outgoingDeps > 0).map((f) => f.path);
  const features = fileStats.filter((f) => !foundations.includes(f.path) && !entryPoints.includes(f.path)).map((f) => f.path);

  // Pull any cached translations we already have for the foundation files
  const config = vscode.workspace.getConfiguration("codelumeai");
  const model = config.get<string>("model", "claude-haiku-4-5");
  const translationSummaries: Array<{ file: string; summary: string }> = [];
  for (const filePath of [...foundations, ...features].slice(0, 8)) {
    // The cache key needs the actual source text — we can only pull from in-memory cache
    // by scanning for any key that contains this file's path fragment. We iterate the
    // in-memory entries the cache exposes. For now we skip files not yet in the cache.
    const _ = filePath; // placeholder: actual lookup done below via state.cache iteration
    void model; // used implicitly above
  }
  // Simpler: scan the cache directly for translations of foundation files
  // (MemoryCache doesn't expose iteration, so we skip for now — the briefing
  // prompt handles "no translations available yet" gracefully)

  return {
    topSymbols,
    fileStructure: { foundations, features, entryPoints },
    translationSummaries,
  };
}

function makeOnboardingPanel(state: ExtensionState): OnboardingPanel {
  const BRIEFING_CACHE_KEY = `codelumeai.briefing.${
    state.workspaceFolderUri
      ? GraphStore.workspaceHash(state.workspaceFolderUri.fsPath)
      : "unknown"
  }`;

  const panel = new OnboardingPanel(state.output, state.workspaceFolderUri as vscode.Uri, {
    generateBriefing: async (): Promise<Briefing> => {
      const apiKey = await state.context.secrets.get(SECRET_KEY);
      if (!apiKey) throw new Error("API key not set. Run CodeLumeAI: Set Anthropic API Key first.");
      const config = vscode.workspace.getConfiguration("codelumeai");
      const model = config.get<string>("model", "claude-haiku-4-5");
      const workspaceName = state.workspaceFolderUri
        ? state.workspaceFolderUri.fsPath.split(/[\\/]/).pop() ?? "workspace"
        : "workspace";
      const ctx = buildCodebaseContext(state);
      const briefing = await generateBriefing({ apiKey, model, workspaceName, ...ctx });
      // Persist so it survives session restarts
      await state.context.globalState.update(BRIEFING_CACHE_KEY, briefing);
      return briefing;
    },

    chat: async (message: string, history: ChatMessage[]): Promise<string> => {
      const apiKey = await state.context.secrets.get(SECRET_KEY);
      if (!apiKey) throw new Error("API key not set. Run CodeLumeAI: Set Anthropic API Key first.");
      const config = vscode.workspace.getConfiguration("codelumeai");
      const model = config.get<string>("model", "claude-haiku-4-5");
      const workspaceName = state.workspaceFolderUri
        ? state.workspaceFolderUri.fsPath.split(/[\\/]/).pop() ?? "workspace"
        : "workspace";
      const cachedBriefing = state.context.globalState.get<Briefing>(BRIEFING_CACHE_KEY);
      const ctx = buildCodebaseContext(state);
      return chatWithCodebase({
        apiKey, model, workspaceName,
        briefing: cachedBriefing,
        messages: history,
        ...ctx,
      });
    },
  });

  // Restore cached briefing from previous session immediately
  const cachedBriefing = state.context.globalState.get<Briefing>(BRIEFING_CACHE_KEY);
  if (cachedBriefing) {
    panel.setCachedBriefing(cachedBriefing);
  }

  return panel;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CodeLumeAI");
  const editFlow = new EditFlow(context, context.secrets, output);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const state: ExtensionState = {
    context,
    cache: new MemoryCache<Translation>(),
    inlayHintsEmitter: new vscode.EventEmitter<void>(),
    statusBar: vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    ),
    inFlight: new Map(),
    output,
    sidePanel: new SidePanel(output, editFlow),
    onboardingPanel: undefined,
    graphPanel: undefined,
    graphStore: undefined,
    graphStoreInitPromise: undefined,
    workspaceFolderUri: workspaceFolder?.uri,
    recentImpact: undefined,
  };

  log(state, "info", "Extension activated.");

  // ── Cross-file impact detection ────────────────────────────────────────────
  // After an edit is applied via EditFlow, query the graph for all files that
  // reference the changed chunk's symbols and surface them in the side panel.
  editFlow.onApplied = (info) => {
    if (!state.graphStore || !state.workspaceFolderUri) return;
    try {
      const rel = workspaceRelative(state.workspaceFolderUri, info.document.uri);
      const conn = state.graphStore.getChunkConnections({
        file: rel,
        startLine: info.startLine,
        endLine: info.endLine,
      });
      const affected = new Set<string>();
      for (const sym of conn.outgoing) {
        if (sym.file !== rel) affected.add(sym.file);
      }
      for (const item of conn.incoming) {
        for (const ref of item.refs) {
          if (ref.file !== rel) affected.add(ref.file);
        }
      }
      state.recentImpact = affected.size > 0 ? { affectedFiles: affected } : undefined;
      state.sidePanel.setImpactedFiles(affected);
      log(state, "info", `Impact: edit in ${rel} affects ${affected.size} file(s): ${[...affected].join(", ")}`);
    } catch (err) {
      log(state, "warn", `Impact lookup failed: ${String(err)}`);
    }
  };

  // Blast-radius preview: when a chunk is hovered in the side panel, highlight
  // its connected files in the graph panel (if open).
  state.sidePanel.onPreviewImpact = (files) => {
    state.graphPanel?.highlightConnectedFiles(files);
  };

  // When the user clicks "Review impact" in the side panel, show a Quick Pick
  // listing all affected files so they can navigate to each one.
  state.sidePanel.onReviewImpact = () => {
    const files = state.recentImpact?.affectedFiles;
    if (!files || files.size === 0) return;
    const items = [...files].map((f) => ({
      label: f.split("/").pop() ?? f,
      description: f,
      file: f,
    }));
    void vscode.window.showQuickPick(items, {
      placeHolder: "Select a file to navigate to",
      matchOnDescription: true,
    }).then((item) => {
      if (!item || !state.workspaceFolderUri) return;
      const absPath = path.join(
        state.workspaceFolderUri.fsPath,
        item.file.replace(/\//g, path.sep),
      );
      void vscode.window.showTextDocument(vscode.Uri.file(absPath), {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
    });
  };

  context.subscriptions.push(
    state.inlayHintsEmitter,
    state.statusBar,
    state.output,
    { dispose: () => state.sidePanel.dispose() },
    { dispose: () => state.onboardingPanel?.dispose() },
    { dispose: () => state.graphPanel?.dispose() },
    { dispose: () => state.graphStore?.close() },

    vscode.commands.registerCommand("codelumeai.showLogs", () => {
      state.output.show();
    }),

    vscode.commands.registerCommand("codelumeai.indexWorkspace", async () => {
      if (!state.workspaceFolderUri) {
        void vscode.window.showErrorMessage("CodeLumeAI: No workspace folder open.");
        return;
      }
      await ensureGraphStore(state);
      if (!state.graphStore) {
        void vscode.window.showErrorMessage("CodeLumeAI: Graph store could not be opened — check the CodeLumeAI logs.");
        return;
      }
      const uris = await vscode.workspace.findFiles(
        "**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,rb,php,html,css,scss}",
        "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,.turbo/**}",
      );
      if (uris.length === 0) {
        void vscode.window.showInformationMessage("CodeLumeAI: No supported files found in workspace.");
        return;
      }
      const cancel = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CodeLumeAI: Indexing workspace…", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => { cancel.cancel(); });
          let indexed = 0;
          let skipped = 0;
          const SAVE_EVERY = 25;
          for (const uri of uris) {
            if (cancel.token.isCancellationRequested) break;
            try {
              const result = await indexFile({
                store: state.graphStore as GraphStore,
                uri,
                workspaceFolder: state.workspaceFolderUri as vscode.Uri,
                cancellation: cancel.token,
              });
              if (result.empty) {
                skipped++;
              } else {
                indexed++;
                log(state, "info", `Graph: ${result.file} — ${result.symbolCount} sym, ${result.refCount} refs, ${result.durationMs}ms`);
              }
            } catch (err) {
              log(state, "warn", `Graph: failed ${uri.fsPath}: ${String(err)}`);
              skipped++;
            }
            if ((indexed + skipped) % SAVE_EVERY === 0) {
              (state.graphStore as GraphStore).save();
            }
            progress.report({ increment: 100 / uris.length, message: `${indexed + skipped}/${uris.length}` });
          }
          (state.graphStore as GraphStore).save();
          cancel.dispose();
          const s = (state.graphStore as GraphStore).stats();
          log(state, "info", `Graph: done. ${s.files} files, ${s.symbols} symbols, ${s.refs} refs.`);
          void vscode.window.showInformationMessage(
            `CodeLumeAI: Indexed ${indexed} files (${skipped} skipped). ${s.symbols} symbols, ${s.refs} cross-file references.`,
          );
          refreshSidePanelIfNeeded(state);
        },
      );
    }),

    vscode.commands.registerCommand("codelumeai.newDevGuide", async () => {
      if (!state.workspaceFolderUri) {
        void vscode.window.showErrorMessage("CodeLumeAI: No workspace folder open.");
        return;
      }
      await ensureGraphStore(state);
      if (!state.graphStore) {
        void vscode.window.showWarningMessage(
          "CodeLumeAI: Index the workspace first (CodeLumeAI: Index Workspace for Connections) to get the full guide.",
        );
        return;
      }
      if (!state.onboardingPanel) {
        state.onboardingPanel = makeOnboardingPanel(state);
      }
      state.onboardingPanel.show(state.graphStore);
    }),

    vscode.commands.registerCommand("codelumeai.showGraph", async () => {
      if (!state.workspaceFolderUri) {
        void vscode.window.showErrorMessage("CodeLumeAI: No workspace folder open.");
        return;
      }
      await ensureGraphStore(state);
      if (!state.graphStore) {
        void vscode.window.showWarningMessage(
          "CodeLumeAI: Index the workspace first (CodeLumeAI: Index Workspace for Connections) to see the dependency graph.",
        );
        return;
      }
      if (!state.graphPanel) {
        state.graphPanel = new GraphPanel(state.output, state.workspaceFolderUri);
      }
      state.graphPanel.show(state.graphStore);
      // Highlight whichever file is currently active
      const editor = vscode.window.activeTextEditor;
      if (editor && state.workspaceFolderUri) {
        const rel = workspaceRelative(state.workspaceFolderUri, editor.document.uri);
        state.graphPanel.highlightFile(rel);
      }
    }),

    vscode.commands.registerCommand(
      "codelumeai.openSidePanel",
      async () => {
        // Start graph store init in the background so it's ready by the time
        // the translation completes (translations take several seconds).
        void ensureGraphStore(state);
        state.sidePanel.show();
        const editor = vscode.window.activeTextEditor;
        if (editor && SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
          const apiKey = await ensureApiKeyOrPrompt(state);
          if (!apiKey) {
            return;
          }
          const translation = await getOrFetchTranslation(state, editor.document);
          if (translation) {
            sidePanelUpdate(state, translation, editor.document);
          }
        }
      },
    ),

    vscode.commands.registerCommand("codelumeai.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Set Anthropic API Key",
        prompt:
          "Paste your Anthropic API key. It is stored in VS Code's SecretStorage and never in settings.json.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) =>
          v && v.startsWith("sk-")
            ? null
            : "Anthropic keys start with 'sk-'.",
      });
      if (!key) {
        return;
      }
      await context.secrets.store(SECRET_KEY, key);
      state.cache.clear();
      state.inlayHintsEmitter.fire();
      log(state, "info", "API key saved.");
      void vscode.window.showInformationMessage("CodeLumeAI: API key saved.");
    }),

    vscode.commands.registerCommand("codelumeai.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      state.cache.clear();
      state.inlayHintsEmitter.fire();
      log(state, "info", "API key cleared.");
      void vscode.window.showInformationMessage("CodeLumeAI: API key cleared.");
    }),

    vscode.commands.registerCommand("codelumeai.toggleMode", async () => {
      const current = getMode();
      const next: Mode =
        current === "off" ? "hover" : current === "hover" ? "always-on" : "off";
      await setMode(next);
    }),

    vscode.commands.registerCommand(
      "codelumeai.translateCurrentFile",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showInformationMessage(
            "CodeLumeAI: open a code file first.",
          );
          return;
        }
        const apiKey = await ensureApiKeyOrPrompt(state);
        if (!apiKey) {
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "CodeLumeAI: translating…",
          },
          () => getOrFetchTranslation(state, editor.document),
        );
        state.inlayHintsEmitter.fire();
        const filename = editor.document.fileName.split(/[\\/]/).pop();
        void vscode.window.showInformationMessage(
          `CodeLumeAI: ${filename ?? "file"} translated. Hover any function to see English.`,
        );
      },
    ),
  );

  const selector: vscode.DocumentSelector = SUPPORTED_LANGUAGES.map(
    (language) => ({ scheme: "file", language }),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      selector,
      new CodeLumeHoverProvider(state),
    ),
    vscode.languages.registerInlayHintsProvider(
      selector,
      new CodeLumeInlayHintsProvider(state),
    ),
  );

  updateStatusBar(state);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codelumeai.mode")) {
        updateStatusBar(state);
        state.inlayHintsEmitter.fire();
      }
      if (e.affectsConfiguration("codelumeai.model")) {
        state.cache.clear();
        state.inlayHintsEmitter.fire();
      }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Coarse but correct: any save invalidates the whole cache.
      // Per-chunk invalidation is a v0.2 optimization.
      state.cache.clear();
      state.inlayHintsEmitter.fire();
      // If the side panel is open and showing this file, refresh it.
      if (
        state.sidePanel.isOpen() &&
        SUPPORTED_LANGUAGES.includes(doc.languageId)
      ) {
        void getOrFetchTranslation(state, doc).then((t) => {
          if (t) {
            sidePanelUpdate(state, t, doc);
          }
        });
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Sync graph highlight to the newly active file.
      if (editor && state.graphPanel && state.workspaceFolderUri) {
        const rel = workspaceRelative(state.workspaceFolderUri, editor.document.uri);
        state.graphPanel.highlightFile(rel);
      }

      // Clear impact markers when the user switches file — the markers only
      // apply to the file they were viewing when the edit was applied.
      state.recentImpact = undefined;
      state.sidePanel.setImpactedFiles(new Set());

      // When the active editor changes and the panel is open, refresh it
      // for the new file. Skips unsupported languages.
      if (!state.sidePanel.isOpen()) {
        return;
      }
      if (!editor || !SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
        return;
      }
      // Show a spinner immediately — the translation fetch can take 5–15 s on a
      // cache miss and we don't want the stale previous file's content to linger.
      const filename = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
      state.sidePanel.showLoading(filename);
      void getOrFetchTranslation(state, editor.document).then((t) => {
        if (t) {
          sidePanelUpdate(state, t, editor.document);
        }
      });
    }),

    vscode.window.onDidChangeTextEditorSelection((e) => {
      // Move the panel's chunk highlight to follow the cursor in the editor.
      if (!state.sidePanel.isOpen()) {
        return;
      }
      if (!SUPPORTED_LANGUAGES.includes(e.textEditor.document.languageId)) {
        return;
      }
      const line = e.selections[0]?.active.line;
      if (line !== undefined) {
        state.sidePanel.highlightChunkForEditorLine(line);
      }
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      // Continuous scroll sync: when the editor's visible range changes,
      // tell the panel to scroll to the matching chunk.
      if (!state.sidePanel.isOpen()) {
        return;
      }
      if (!SUPPORTED_LANGUAGES.includes(e.textEditor.document.languageId)) {
        return;
      }
      const topLine = e.visibleRanges[0]?.start.line;
      if (topLine !== undefined) {
        state.sidePanel.syncPanelToEditorScroll(topLine);
      }
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically.
}
