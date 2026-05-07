import * as vscode from "vscode";
import {
  translate,
  hashContent,
  MemoryCache,
  TranslationError,
  type Translation,
  type Chunk,
} from "@codelumeai/core";

const SECRET_KEY = "codelumeai.apiKey";

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
    return undefined;
  }

  const source = document.getText();
  const cacheKey = hashContent(source, document.languageId, model);

  const cached = state.cache.get(cacheKey);
  if (cached) {
    return cached.value;
  }

  // De-duplicate concurrent requests for the same cache key (multiple
  // providers may both ask for the same translation in the same tick).
  const inFlight = state.inFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const filename = document.fileName.split(/[\\/]/).pop();
  const promise = (async (): Promise<Translation | undefined> => {
    try {
      const translation = await translate({
        apiKey,
        source,
        language: document.languageId,
        filename,
        model,
      });
      state.cache.set(cacheKey, translation);
      return translation;
    } catch (err) {
      const msg =
        err instanceof TranslationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      void vscode.window.showErrorMessage(`CodeLumeAI: ${msg}`);
      return undefined;
    } finally {
      state.inFlight.delete(cacheKey);
    }
  })();
  state.inFlight.set(cacheKey, promise);
  return promise;
}

class CodeLumeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly state: ExtensionState) {}

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

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**CodeLumeAI** — ${chunk.title}  \n`);
    md.appendMarkdown(
      `_Lines ${String(chunk.startLine)}–${String(chunk.endLine)} · confidence: \`${chunk.confidence}\`_\n\n`,
    );
    md.appendMarkdown(chunk.english);
    if (chunk.note) {
      md.appendMarkdown(`\n\n> ⚠ ${chunk.note}`);
    }

    return new vscode.Hover(md);
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

      let summary =
        chunk.english
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)[0] ?? "";
      summary = summary.replace(/^[-*•]\s*/, "");
      if (summary.length > 80) {
        summary = summary.slice(0, 77) + "…";
      }

      const hint = new vscode.InlayHint(
        position,
        ` ▸ ${summary}`,
      );
      hint.paddingLeft = true;
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**${chunk.title}** _(${chunk.confidence})_\n\n`);
      tooltip.appendMarkdown(chunk.english);
      if (chunk.note) {
        tooltip.appendMarkdown(`\n\n> ⚠ ${chunk.note}`);
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
  state.statusBar.text = `${icons[mode]} CodeLumeAI: ${mode}`;
  state.statusBar.tooltip = "Click to cycle CodeLumeAI mode (Off → Hover → Always-on)";
  state.statusBar.command = "codelumeai.toggleMode";
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
  const state: ExtensionState = {
    context,
    cache: new MemoryCache<Translation>(),
    inlayHintsEmitter: new vscode.EventEmitter<void>(),
    statusBar: vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    ),
    inFlight: new Map(),
  };

  context.subscriptions.push(
    state.inlayHintsEmitter,
    state.statusBar,

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
      void vscode.window.showInformationMessage("CodeLumeAI: API key saved.");
    }),

    vscode.commands.registerCommand("codelumeai.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      state.cache.clear();
      state.inlayHintsEmitter.fire();
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

    vscode.workspace.onDidSaveTextDocument(() => {
      // Coarse but correct: any save invalidates the whole cache.
      // Per-chunk invalidation is a v0.2 optimization.
      state.cache.clear();
      state.inlayHintsEmitter.fire();
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically.
}
