import * as vscode from "vscode";
import { englishToCode, TranslationError } from "@codelumeai/core";
import type { CodeChange } from "@codelumeai/core";

const SECRET_KEY = "codelumeai.apiKey";
const PREVIEW_SCHEME = "codelumeai-preview";

export interface ApplyEditArgs {
  document: vscode.TextDocument;
  startLine: number;
  endLine: number;
  originalEnglish: string;
  newEnglish: string;
}

/**
 * The bidirectional-edit flow. Translates an edited English description
 * into a code change, shows it as a diff, and applies on user confirmation.
 *
 * The flow:
 *   1. Check the per-workspace `codelumeai.editEnabled` setting. If off,
 *      explicitly prompt the user — this writes to their code.
 *   2. Call `englishToCode` to get a proposed change.
 *   3. Refuse low-confidence changes; warn for medium with `warnings`.
 *   4. Build the proposed full-file content and open a diff between the
 *      current file and the proposed version (read-only).
 *   5. Modal: Apply or Discard.
 *   6. On Apply, use a WorkspaceEdit to replace the line range.
 */
export class EditFlow {
  private readonly previewProvider: PreviewContentProvider;

  constructor(
    context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {
    this.previewProvider = new PreviewContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        PREVIEW_SCHEME,
        this.previewProvider,
      ),
    );
  }

  async apply(args: ApplyEditArgs): Promise<void> {
    this.log(
      `apply request L${args.startLine}-L${args.endLine} ` +
        `(${args.document.fileName.split(/[\\/]/).pop() ?? "?"})`,
    );

    if (!(await this.ensureEnabled())) {
      this.log(`  user declined to enable edit mode; aborting`);
      return;
    }

    const apiKey = await this.secrets.get(SECRET_KEY);
    if (!apiKey) {
      void vscode.window.showErrorMessage(
        "CodeLumeAI: set your Anthropic API key first (Command Palette → CodeLumeAI: Set API Key).",
      );
      return;
    }

    const config = vscode.workspace.getConfiguration("codelumeai");
    const filename = args.document.fileName.split(/[\\/]/).pop();

    let change: CodeChange;
    try {
      change = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "CodeLumeAI: generating code change…",
          cancellable: false,
        },
        () =>
          englishToCode({
            apiKey,
            source: args.document.getText(),
            language: args.document.languageId,
            filename,
            startLine: args.startLine,
            endLine: args.endLine,
            originalEnglish: args.originalEnglish,
            newEnglish: args.newEnglish,
            model: config.get<string>("model", "claude-haiku-4-5"),
          }),
      );
    } catch (err) {
      const msg =
        err instanceof TranslationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.log(`  englishToCode failed: ${msg}`);
      void vscode.window.showErrorMessage(`CodeLumeAI: ${msg}`);
      return;
    }

    this.log(
      `  got change: confidence=${change.confidence}, ` +
        `range L${change.startLine}-L${change.endLine}, ` +
        `warnings=${String(change.warnings?.length ?? 0)}`,
    );

    if (change.confidence === "low") {
      void vscode.window.showErrorMessage(
        `CodeLumeAI: refusing to apply (low confidence). ${change.note ?? "Try rewording your instruction."}`,
      );
      return;
    }

    if (change.warnings && change.warnings.length > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `CodeLumeAI: ${change.warnings.join("; ")}`,
        { modal: true },
        "Continue anyway",
      );
      if (proceed !== "Continue anyway") {
        return;
      }
    }

    // Build proposed full-file content. We trust change.startLine/endLine,
    // not the input range, because the model may have legitimately adjusted
    // the range to cover the whole replaced statement.
    const sourceLines = args.document.getText().split("\n");
    const startIdx = Math.max(0, change.startLine - 1);
    const endIdx = Math.min(sourceLines.length - 1, change.endLine - 1);
    const proposedLines = [
      ...sourceLines.slice(0, startIdx),
      ...change.newCode.split("\n"),
      ...sourceLines.slice(endIdx + 1),
    ];
    const proposedText = proposedLines.join("\n");

    // Open a diff: original on the left, proposed on the right (read-only).
    const proposedUri = vscode.Uri.parse(
      `${PREVIEW_SCHEME}:proposed-${String(Date.now())}.${args.document.languageId}`,
    );
    this.previewProvider.setContent(proposedUri, proposedText);

    await vscode.commands.executeCommand(
      "vscode.diff",
      args.document.uri,
      proposedUri,
      `CodeLumeAI · proposed change to ${filename ?? "file"}`,
      { preview: true },
    );

    const noteText = change.note ? `\n\nNote: ${change.note}` : "";
    const choice = await vscode.window.showInformationMessage(
      `CodeLumeAI: apply this change to ${filename ?? "the file"}? ` +
        `Lines ${String(change.startLine)}-${String(change.endLine)}, confidence: ${change.confidence}.${noteText}`,
      { modal: true },
      "Apply",
    );

    if (choice !== "Apply") {
      this.log(`  user discarded`);
      return;
    }

    // Apply using a WorkspaceEdit. Re-read line lengths from the current
    // document state in case it shifted between getText and now.
    const edit = new vscode.WorkspaceEdit();
    const endLineText = args.document.lineAt(endIdx).text;
    edit.replace(
      args.document.uri,
      new vscode.Range(startIdx, 0, endIdx, endLineText.length),
      change.newCode,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      this.log(`  applied L${change.startLine}-L${change.endLine}`);
      void vscode.window.showInformationMessage(
        `CodeLumeAI: applied change to L${String(change.startLine)}-L${String(change.endLine)}.`,
      );
    } else {
      this.log(`  WorkspaceEdit.applyEdit returned false`);
      void vscode.window.showErrorMessage(
        "CodeLumeAI: VS Code rejected the edit. The file may have changed in the meantime.",
      );
    }
  }

  private async ensureEnabled(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("codelumeai");
    if (config.get<boolean>("editEnabled", false)) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      "CodeLumeAI Edit mode is OFF for this workspace. Edit mode lets the AI " +
        "rewrite your code based on plain-English instructions. Enable it for " +
        "this workspace?",
      { modal: true },
      "Enable for this workspace",
    );
    if (choice !== "Enable for this workspace") {
      return false;
    }
    await config.update(
      "editEnabled",
      true,
      vscode.ConfigurationTarget.Workspace,
    );
    return true;
  }

  private log(message: string): void {
    this.output.appendLine(
      `[${new Date().toISOString()}] [edit-flow] ${message}`,
    );
  }
}

class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  setContent(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}
