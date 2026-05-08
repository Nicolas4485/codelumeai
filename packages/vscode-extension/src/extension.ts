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

const SECRET_KEY = "codelumeai.apiKey";
const CACHE_SCHEMA_VERSION = "v2";

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

interface ExtensionState {
  context: vscode.ExtensionContext;
  cache: MemoryCache<Translation>;
  inlayHintsEmitter: vscode.EventEmitter<void>;
  statusBar: vscode.StatusBarItem;
  inFlight: Map<string, Promise<Translation | undefined>>;
  output: vscode.OutputChannel;
  sidePanel: SidePanel;
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
 * Walk the translation's chunks, return any gaps in line coverage.
 * Each gap is a [startLine, endLine] tuple (1-indexed, inclusive).
 *
 * Used after every translation to detect when the model skipped a
 * function or block. The sequence-of-bools version (one bool per
 * line) is fine here — files are bounded by the maxFileLines setting.
 */
function findCoverageGaps(
  translation: Translation,
  totalLines: number,
): Array<[number, number]> {
  if (totalLines <= 0) return [];
  const covered = new Array<boolean>(totalLines + 1).fill(false);
  for (const chunk of translation.chunks) {
    const start = Math.max(1, chunk.startLine);
    const end = Math.min(totalLines, chunk.endLine);
    for (let i = start; i <= end; i++) {
      covered[i] = true;
    }
  }
  const gaps: Array<[number, number]> = [];
  let gapStart = -1;
  for (let i = 1; i <= totalLines; i++) {
    if (!covered[i]) {
      if (gapStart === -1) gapStart = i;
    } else if (gapStart !== -1) {
      gaps.push([gapStart, i - 1]);
      gapStart = -1;
    }
  }
  if (gapStart !== -1) gaps.push([gapStart, totalLines]);
  return gaps;
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
      // sometimes does anyway. Surface gaps to the log so users know to
      // re-translate.
      const gaps = findCoverageGaps(translation, document.lineCount);
      if (gaps.length > 0) {
        const fmt = gaps.map(([s, e]) => `L${s}-${e}`).join(", ");
        log(
          state,
          "warn",
          `Coverage gaps in ${filename ?? "(unnamed)"}: ${fmt}. The model skipped these line ranges. Consider running "Translate Current File" again or switching to claude-sonnet-4-6 in settings.`,
        );
      }
      // Push the fresh translation to the side panel if it's open and showing this doc.
      if (state.sidePanel.isOpen()) {
        state.sidePanel.update(translation, document);
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

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CodeLumeAI");
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
    sidePanel: new SidePanel(output),
  };

  log(state, "info", "Extension activated.");

  context.subscriptions.push(
    state.inlayHintsEmitter,
    state.statusBar,
    state.output,
    { dispose: () => state.sidePanel.dispose() },

    vscode.commands.registerCommand("codelumeai.showLogs", () => {
      state.output.show();
    }),

    vscode.commands.registerCommand(
      "codelumeai.openSidePanel",
      async () => {
        state.sidePanel.show();
        const editor = vscode.window.activeTextEditor;
        if (editor && SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
          const apiKey = await ensureApiKeyOrPrompt(state);
          if (!apiKey) {
            return;
          }
          const translation = await getOrFetchTranslation(state, editor.document);
          if (translation) {
            state.sidePanel.update(translation, editor.document);
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
            state.sidePanel.update(t, doc);
          }
        });
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // When the active editor changes and the panel is open, refresh it
      // for the new file. Skips unsupported languages.
      if (!state.sidePanel.isOpen()) {
        return;
      }
      if (!editor || !SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
        return;
      }
      void getOrFetchTranslation(state, editor.document).then((t) => {
        if (t) {
          state.sidePanel.update(t, editor.document);
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
