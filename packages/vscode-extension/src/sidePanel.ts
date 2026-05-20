import * as path from "node:path";
import * as vscode from "vscode";
import type { Translation } from "@codelumeai/core";
import type { EditFlow } from "./editFlow";
import type { ConnectedSymbols } from "./graph/types";

interface WebviewMessage {
  type:
    | "highlightLines"
    | "clearHighlight"
    | "revealLines"
    | "panelScrolled"
    | "applyEdit"
    | "navigateTo"
    | "reviewImpact"
    | "previewImpact";
  startLine?: number;
  endLine?: number;
  chunkIndex?: number;
  originalEnglish?: string;
  newEnglish?: string;
  file?: string;
  line?: number;
  files?: string[];
}

/**
 * The plain-English side panel. A VS Code webview that renders the
 * Translation as a readable document and stays in sync with the editor:
 *
 * - Editor cursor moves → matching chunk in panel highlights and scrolls into view.
 * - Panel chunk hovered → matching line range in editor gets a soft highlight.
 * - Panel chunk clicked → editor jumps to that line.
 * - Editor file saved or switched → panel updates automatically (driven from extension.ts).
 * - If the workspace has been indexed, each chunk shows a "Connected" section with
 *   outgoing symbol references and incoming usage counts.
 */
export class SidePanel {
  /** Set by extension.ts — called when the user clicks "Review impact" in the panel. */
  onReviewImpact: (() => void) | undefined;

  /**
   * Set by extension.ts — called when a chunk is hovered in the side panel.
   * Receives the list of connected file paths so the graph panel can highlight
   * the blast radius. Called with an empty array when hover ends.
   */
  onPreviewImpact: ((files: string[]) => void) | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private currentDocument: vscode.TextDocument | undefined;
  private currentTranslation: Translation | undefined;
  private currentGraphConnections: Array<ConnectedSymbols | null> | undefined;
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly flashDecorationType: vscode.TextEditorDecorationType;
  private flashTimer: NodeJS.Timeout | undefined;

  // Loop-prevention for bidirectional scroll sync.
  // When we sync editor -> panel, we scroll the panel programmatically; that
  // triggers a panel scroll event which would otherwise sync back to the
  // editor. The same in reverse. Each suppressXUntil timestamp says
  // "ignore X-direction scroll events until this Date.now() value".
  private suppressEditorSyncUntil = 0;
  private suppressPanelSyncUntil = 0;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly editFlow: EditFlow,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    // A more prominent flash for click-to-jump. Auto-clears after 1.5s.
    this.flashDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
  }

  private log(message: string): void {
    this.output.appendLine(
      `[${new Date().toISOString()}] [side-panel] ${message}`,
    );
  }

  /** Open or reveal the panel. If already open, brings it to focus. */
  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, /* preserveFocus */ true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codelumeai.sidePanel",
      "CodeLumeAI · Plain English",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.clearEditorHighlights();
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.log(
        `recv ${msg.type} ` +
          `start=${String(msg.startLine)} end=${String(msg.endLine)} ` +
          `chunk=${String(msg.chunkIndex)}`,
      );
      switch (msg.type) {
        case "highlightLines":
          if (msg.startLine !== undefined && msg.endLine !== undefined) {
            this.highlightLinesInEditor(msg.startLine, msg.endLine);
          }
          return;
        case "clearHighlight":
          this.clearEditorHighlights();
          this.onPreviewImpact?.([]); // restore graph when chunk hover ends
          return;
        case "revealLines":
          if (msg.startLine !== undefined && msg.endLine !== undefined) {
            // The editor scroll caused by revealRange would otherwise echo
            // back to us as a panel-sync request. Suppress that echo.
            this.suppressEditorSyncUntil = Date.now() + 300;
            this.revealLinesInEditor(msg.startLine, msg.endLine);
          }
          return;
        case "panelScrolled":
          if (msg.chunkIndex !== undefined) {
            if (Date.now() < this.suppressPanelSyncUntil) {
              return; // this scroll was caused by us syncing editor -> panel
            }
            this.suppressEditorSyncUntil = Date.now() + 300;
            this.alignEditorWithChunk(msg.chunkIndex);
          }
          return;
        case "applyEdit":
          if (
            msg.startLine !== undefined &&
            msg.endLine !== undefined &&
            msg.originalEnglish !== undefined &&
            msg.newEnglish !== undefined &&
            this.currentDocument
          ) {
            void this.editFlow.apply({
              document: this.currentDocument,
              startLine: msg.startLine,
              endLine: msg.endLine,
              originalEnglish: msg.originalEnglish,
              newEnglish: msg.newEnglish,
            });
          }
          return;
        case "navigateTo":
          if (msg.file !== undefined && msg.line !== undefined) {
            void this.navigateToSymbol(msg.file, msg.line);
          }
          return;
        case "reviewImpact":
          this.onReviewImpact?.();
          return;
        case "previewImpact":
          this.onPreviewImpact?.(msg.files ?? []);
          return;
      }
    });

    // If a translation was already cached before the panel opened, send it now.
    if (this.currentTranslation) {
      this.update(this.currentTranslation, this.currentDocument, this.currentGraphConnections);
    }
  }

  /** Render a translation. Updates the panel title to reflect the file. */
  update(
    translation: Translation,
    document?: vscode.TextDocument,
    graphConnections?: Array<ConnectedSymbols | null>,
  ): void {
    this.currentTranslation = translation;
    this.currentGraphConnections = graphConnections;
    if (document) {
      this.currentDocument = document;
    }
    if (this.panel) {
      const filename = this.currentDocument?.fileName.split(/[\\/]/).pop();
      if (filename) {
        this.panel.title = `${filename} · Plain English`;
      }
      void this.panel.webview.postMessage({ type: "update", translation, graphConnections: graphConnections ?? null });
    }
  }

  /** Tell the panel to highlight whichever chunk contains this 0-indexed editor line. */
  highlightChunkForEditorLine(zeroBasedLine: number): void {
    if (!this.panel || !this.currentTranslation) {
      return;
    }
    const oneBased = zeroBasedLine + 1;
    const chunkIndex = this.currentTranslation.chunks.findIndex(
      (c) => c.startLine <= oneBased && c.endLine >= oneBased,
    );
    if (chunkIndex >= 0) {
      void this.panel.webview.postMessage({ type: "highlightChunk", chunkIndex });
    }
  }

  /**
   * Editor scrolled — sync the panel to follow.
   * Called from extension.ts on every onDidChangeTextEditorVisibleRanges.
   */
  syncPanelToEditorScroll(zeroBasedTopLine: number): void {
    if (!this.panel || !this.currentTranslation) {
      return;
    }
    if (Date.now() < this.suppressEditorSyncUntil) {
      return; // this scroll was caused by us syncing panel -> editor
    }
    const oneBased = zeroBasedTopLine + 1;
    // Find the chunk that contains the top visible line, falling back to the
    // first chunk that starts after if we're between chunks.
    let chunkIndex = this.currentTranslation.chunks.findIndex(
      (c) => c.startLine <= oneBased && c.endLine >= oneBased,
    );
    if (chunkIndex < 0) {
      chunkIndex = this.currentTranslation.chunks.findIndex(
        (c) => c.endLine >= oneBased,
      );
    }
    if (chunkIndex < 0) {
      return;
    }
    this.suppressPanelSyncUntil = Date.now() + 300;
    void this.panel.webview.postMessage({ type: "scrollToChunk", chunkIndex });
  }

  /**
   * Highlight connected files in the panel that may need updating after a recent
   * code change. Pass an empty Set to clear all impact markers.
   */
  setImpactedFiles(files: Set<string>): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: "setImpact", affectedFiles: [...files] });
  }

  /** Immediately clear the panel and show a translating spinner for the new file. */
  showLoading(filename: string): void {
    if (!this.panel) return;
    this.panel.title = `${filename} · Plain English`;
    void this.panel.webview.postMessage({ type: "loading", filename });
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.decorationType.dispose();
    this.flashDecorationType.dispose();
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
  }

  private highlightLinesInEditor(startLine: number, endLine: number): void {
    if (!this.currentDocument) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.currentDocument,
    );
    if (!editor) {
      return;
    }
    const start = Math.max(0, startLine - 1);
    const end = Math.min(editor.document.lineCount - 1, endLine - 1);
    if (end < start) {
      return;
    }
    const endChar = editor.document.lineAt(end).text.length;
    const range = new vscode.Range(start, 0, end, endChar);
    editor.setDecorations(this.decorationType, [range]);
  }

  private clearEditorHighlights(): void {
    vscode.window.visibleTextEditors.forEach((e) => {
      e.setDecorations(this.decorationType, []);
    });
  }

  /**
   * Panel scrolled past chunk N — scroll the editor so chunk N's first line
   * sits at the top of the viewport. Called when the panel sends a
   * panelScrolled message.
   */
  private alignEditorWithChunk(chunkIndex: number): void {
    if (!this.currentDocument || !this.currentTranslation) {
      return;
    }
    const chunk = this.currentTranslation.chunks[chunkIndex];
    if (!chunk) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.currentDocument,
    );
    if (!editor) {
      return;
    }
    const lineIdx = Math.max(0, Math.min(editor.document.lineCount - 1, chunk.startLine - 1));
    const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
  }

  private revealLinesInEditor(
    startOneBased: number,
    endOneBased: number,
  ): void {
    this.log(`revealLines L${startOneBased}–L${endOneBased}`);
    if (!this.currentDocument) {
      this.log(`  no currentDocument set; click ignored`);
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.currentDocument,
    );
    if (!editor) {
      this.log(
        `  no visible editor for ${this.currentDocument.fileName}; ` +
          `visibleTextEditors had ${vscode.window.visibleTextEditors.length} entries`,
      );
      return;
    }
    const start = Math.max(0, startOneBased - 1);
    const end = Math.min(editor.document.lineCount - 1, endOneBased - 1);
    if (end < start) {
      this.log(`  invalid range start=${start} end=${end}`);
      return;
    }
    const endChar = editor.document.lineAt(end).text.length;
    const range = new vscode.Range(start, 0, end, endChar);

    // 1) Scroll the chunk's range to the centre of the editor viewport.
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    // 2) Move the cursor to the start of the chunk.
    editor.selection = new vscode.Selection(start, 0, start, 0);
    // 3) Flash highlight auto-clears after 1.5s.
    editor.setDecorations(this.flashDecorationType, [range]);
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      vscode.window.visibleTextEditors.forEach((e) => {
        e.setDecorations(this.flashDecorationType, []);
      });
      this.flashTimer = undefined;
    }, 1500);

    this.log(`  scrolled + flashed range`);
  }

  private async navigateToSymbol(workspaceRelFile: string, oneBased: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const absPath = path.join(folder.uri.fsPath, workspaceRelFile.replace(/\//g, path.sep));
    const uri = vscode.Uri.file(absPath);
    const pos = new vscode.Position(Math.max(0, oneBased - 1), 0);
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
  }

  private buildHtml(): string {
    const nonce = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>CodeLumeAI</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 20px;
      line-height: 1.55;
      font-size: var(--vscode-font-size);
    }
    h1, h2, h3 { color: var(--vscode-foreground); }
    a { color: var(--vscode-textLink-foreground); }
    code, .mono {
      font-family: var(--vscode-editor-font-family, "Cascadia Code", Menlo, monospace);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .empty-state {
      color: var(--vscode-descriptionForeground);
      padding: 48px 16px;
      text-align: center;
      font-style: italic;
    }
    .primer {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 12px 16px;
      margin-bottom: 24px;
      font-size: 0.93em;
      white-space: pre-wrap;
    }
    .primer-title {
      font-weight: 600;
      margin-bottom: 6px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }
    .chunk {
      margin-bottom: 18px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid transparent;
      transition: background 0.12s ease, border-color 0.12s ease;
      cursor: pointer;
    }
    .chunk:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .chunk.highlighted {
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }
    .chunk-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .chunk-title {
      font-weight: 600;
      flex: 1;
    }
    .chunk-range {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
    }
    .confidence {
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.78em;
      font-weight: 500;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .confidence-high {
      background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 22%, transparent);
      color: var(--vscode-charts-green, #4caf50);
    }
    .confidence-medium {
      background: color-mix(in srgb, var(--vscode-charts-yellow, #ffb300) 22%, transparent);
      color: var(--vscode-charts-yellow, #ffb300);
    }
    .confidence-low {
      background: color-mix(in srgb, var(--vscode-charts-red, #e53935) 22%, transparent);
      color: var(--vscode-charts-red, #e53935);
    }
    .chunk-summary {
      margin: 6px 0 10px;
    }
    .chunk-lines {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .line-entry {
      padding: 3px 0 3px 10px;
      border-left: 2px solid transparent;
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    .line-entry:hover {
      border-left-color: var(--vscode-charts-blue, #4f9bff);
      background: var(--vscode-list-hoverBackground);
    }
    .line-range {
      display: inline-block;
      min-width: 56px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82em;
    }
    .note {
      margin-top: 8px;
      padding: 6px 10px;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,165,0,0.12));
      border-left: 3px solid var(--vscode-inputValidation-warningBorder, #ffb300);
      font-size: 0.9em;
    }

    /* ---- Impact markers ---- */
    .impact-banner {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px; padding: 5px 8px;
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #ff9d3d) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-inputValidation-warningBorder, #ff9d3d) 40%, transparent);
      border-radius: 4px; font-size: 0.82em;
    }
    .impact-banner-text { flex: 1; color: var(--vscode-foreground); }
    .impact-badge {
      font-size: 0.72em; font-weight: 700; padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #ff9d3d) 25%, transparent);
      color: var(--vscode-inputValidation-warningForeground, #e8a735);
      border: 1px solid color-mix(in srgb, var(--vscode-inputValidation-warningBorder, #ff9d3d) 50%, transparent);
    }
    .btn-impact {
      padding: 2px 8px; font-size: 0.78em; border-radius: 3px; cursor: pointer; border: 1px solid transparent;
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      font-family: var(--vscode-font-family);
    }
    .btn-impact:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }

    /* ---- Loading state ---- */
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 64px 16px;
      gap: 16px;
      color: var(--vscode-descriptionForeground);
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-top-color: var(--vscode-progressBar-background, #0e70c0);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-label {
      font-size: 0.9em;
      font-style: italic;
    }

    /* ---- Inline edit UI ---- */
    .edit-btn {
      display: inline-block;
      margin-left: 10px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      border: 1px solid var(--vscode-button-border, var(--vscode-focusBorder));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font-size: 0.95em;
      line-height: 1;
      padding: 2px 8px;
      border-radius: 3px;
      opacity: 0.85;
      transition: opacity 0.12s ease, background 0.12s ease, transform 0.12s ease;
      vertical-align: baseline;
      font-family: inherit;
    }
    .line-entry:hover .edit-btn { opacity: 1; }
    .edit-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
      transform: scale(1.05);
    }
    .edit-btn:active {
      transform: scale(0.95);
    }
    .edit-mode {
      margin-top: 6px;
      padding: 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 4px;
    }
    .edit-textarea {
      display: block;
      width: 100%;
      min-height: 56px;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: vertical;
      box-sizing: border-box;
    }
    .edit-textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
    .edit-hint {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      margin-top: 6px;
    }
    .edit-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .edit-btn-apply, .edit-btn-cancel {
      padding: 3px 12px;
      font-size: 0.85em;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid transparent;
      font-family: var(--vscode-font-family);
    }
    .edit-btn-apply {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .edit-btn-apply:hover { background: var(--vscode-button-hoverBackground); }
    .edit-btn-cancel {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .edit-btn-cancel:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }

    /* ---- Connected section ---- */
    .connected {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
    }
    .connected-group {
      margin-bottom: 8px;
    }
    .connected-label {
      font-size: 0.72em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .connected-sym {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 0;
      font-size: 0.86em;
      border-radius: 3px;
    }
    .connected-sym.outgoing {
      cursor: pointer;
    }
    .connected-sym.outgoing:hover .sym-name {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    .connected-sym.incoming.expandable {
      cursor: pointer;
    }
    .connected-sym.incoming.expandable:hover .sym-name {
      color: var(--vscode-textLink-foreground);
    }
    .sym-toggle {
      width: 10px;
      font-size: 0.65em;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      transition: transform 0.15s ease;
      display: inline-block;
      line-height: 1;
      user-select: none;
    }
    .sym-kind {
      color: var(--vscode-descriptionForeground);
      font-size: 0.78em;
      font-family: var(--vscode-editor-font-family, monospace);
      min-width: 36px;
      flex-shrink: 0;
    }
    .sym-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.93em;
      background: var(--vscode-textCodeBlock-background);
      padding: 0 3px;
      border-radius: 2px;
    }
    .sym-loc {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      margin-left: auto;
      flex-shrink: 0;
    }
    .sym-refcount {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      margin-left: auto;
      flex-shrink: 0;
    }
    .ref-list {
      display: none;
      margin: 2px 0 4px 22px;
      border-left: 2px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
      padding-left: 8px;
    }
    .ref-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 4px;
      font-size: 0.82em;
      cursor: pointer;
      border-radius: 2px;
    }
    .ref-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .ref-item:hover .ref-loc {
      text-decoration: underline;
    }
    .ref-loc {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-textLink-foreground);
      flex-shrink: 0;
    }
    .ref-context {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty-state">Open a code file in the editor and run "CodeLumeAI: Translate Current File", or hover any line to populate this panel.</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function fmtRange(start, end) {
      return start === end ? 'L' + start : 'L' + start + '\\u2013' + end;
    }

    function kindLabel(kind) {
      const map = {
        'function': 'fn',
        'method': 'fn',
        'constructor': 'new',
        'class': 'class',
        'interface': 'iface',
        'struct': 'struct',
        'enum': 'enum',
        'enumMember': 'enum',
        'variable': 'var',
        'constant': 'const',
        'property': 'prop',
        'field': 'field',
        'namespace': 'ns',
        'module': 'mod',
        'typeParameter': 'type',
      };
      return map[kind] || kind.slice(0, 5);
    }

    function renderConnected(conn) {
      // conn === undefined: graph not indexed yet — show nothing (clean, no noise)
      // conn === null: query failed — show nothing
      if (!conn) return '';
      const { outgoing, incoming } = conn;
      if (!outgoing.length && !incoming.length) return '';

      // Collect all files reachable from this chunk and intersect with impacted set
      const connectedFileSet = new Set([
        ...outgoing.map(s => s.file),
        ...incoming.flatMap(i => (i.refs || []).map(r => r.file)),
      ]);
      const impactedConnected = [...connectedFileSet].filter(f => impactedFiles.has(f));

      let html = '<div class="connected">';

      // Impact banner — shown when the user just applied an edit that touches connected files
      if (impactedConnected.length > 0) {
        const n = impactedConnected.length;
        html += '<div class="impact-banner">' +
          '<span class="impact-badge">⚠ Needs review</span>' +
          '<span class="impact-banner-text">' + n + ' connected file' + (n !== 1 ? 's' : '') + ' may need updating</span>' +
          '<button class="btn-impact" id="btn-review-impact">Review impact</button>' +
        '</div>';
      }

      if (outgoing.length) {
        html += '<div class="connected-group"><div class="connected-label">Uses</div>';
        for (const sym of outgoing) {
          const filename = sym.file.split('/').pop() || sym.file;
          const isImpacted = impactedFiles.has(sym.file);
          html += '<div class="connected-sym outgoing" data-file="' + escapeHtml(sym.file) + '" data-line="' + sym.startLine + '">' +
            '<span class="sym-kind">' + escapeHtml(kindLabel(sym.kind)) + '</span>' +
            '<span class="sym-name">' + escapeHtml(sym.name) + '</span>' +
            (isImpacted ? '<span class="impact-badge" style="margin-left:4px">⚠</span>' : '') +
            '<span class="sym-loc">' + escapeHtml(filename) + ':' + sym.startLine + '</span>' +
          '</div>';
        }
        html += '</div>';
      }
      if (incoming.length) {
        html += '<div class="connected-group"><div class="connected-label">Used by</div>';
        for (const item of incoming) {
          const sym = item.symbol;
          const hasRefs = item.refs && item.refs.length > 0;
          const symId = escapeHtml(sym.id);
          const symImpacted = hasRefs && item.refs.some(r => impactedFiles.has(r.file));
          html += '<div class="connected-sym incoming' + (hasRefs ? ' expandable' : '') + '" data-sym-id="' + symId + '">' +
            '<span class="sym-toggle">' + (hasRefs ? '\\u25b6' : '') + '</span>' +
            '<span class="sym-kind">' + escapeHtml(kindLabel(sym.kind)) + '</span>' +
            '<span class="sym-name">' + escapeHtml(sym.name) + '</span>' +
            (symImpacted ? '<span class="impact-badge" style="margin-left:4px">⚠</span>' : '') +
            '<span class="sym-refcount">\\u00d7' + item.refCount + '</span>' +
          '</div>';
          if (hasRefs) {
            html += '<div class="ref-list" data-for="' + symId + '">';
            for (const ref of item.refs) {
              const refFilename = ref.file.split('/').pop() || ref.file;
              const refImpacted = impactedFiles.has(ref.file);
              const context = ref.inSymbol
                ? ' <span class="ref-context">in ' + escapeHtml(ref.inSymbol.name) + '</span>'
                : '';
              html += '<div class="ref-item" data-file="' + escapeHtml(ref.file) + '" data-line="' + ref.line + '">' +
                '<span class="ref-loc">' + escapeHtml(refFilename) + ':' + ref.line + '</span>' +
                context +
                (refImpacted ? '<span class="impact-badge" style="margin-left:auto">⚠</span>' : '') +
              '</div>';
            }
            html += '</div>';
          }
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    function render(translation, graphConnections) {
      if (!translation || !translation.chunks || translation.chunks.length === 0) {
        root.innerHTML = '<div class="empty-state">No translation available yet. Hover any line in the editor to start.</div>';
        return;
      }
      let html = '';
      if (translation.primer && translation.primer.trim()) {
        html += '<div class="primer">' +
          '<div class="primer-title">Notes on this file&apos;s language</div>' +
          escapeHtml(translation.primer) +
        '</div>';
      }
      for (let i = 0; i < translation.chunks.length; i++) {
        const c = translation.chunks[i];
        const conn = graphConnections ? graphConnections[i] : undefined;
        const linesHtml = (c.lines || []).map(l => {
          return '<li class="line-entry" data-start="' + l.startLine + '" data-end="' + l.endLine + '">' +
            '<span class="line-range">' + fmtRange(l.startLine, l.endLine) + '</span>' +
            '<span class="line-text">' + escapeHtml(l.english) + '</span>' +
            '<button class="edit-btn" title="Edit and apply to code">\\u270e</button>' +
          '</li>';
        }).join('');
        const noteHtml = c.note ? '<div class="note">\\u26a0 ' + escapeHtml(c.note) + '</div>' : '';
        const conf = c.confidence || 'high';
        html += '<div class="chunk" data-chunk="' + i + '" data-start="' + c.startLine + '" data-end="' + c.endLine + '">' +
          '<div class="chunk-header">' +
            '<span class="chunk-title">' + escapeHtml(c.title) + '</span>' +
            '<span class="chunk-range">' + fmtRange(c.startLine, c.endLine) + '</span>' +
            '<span class="confidence confidence-' + conf + '">' + conf + '</span>' +
          '</div>' +
          '<div class="chunk-summary">' + escapeHtml(c.summary || '') + '</div>' +
          '<ul class="chunk-lines">' + linesHtml + '</ul>' +
          noteHtml +
          renderConnected(conn) +
        '</div>';
      }
      root.innerHTML = html;
      attachHandlers();
    }

    function attachHandlers() {
      document.querySelectorAll('.chunk').forEach(el => {
        el.addEventListener('mouseenter', () => {
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          vscode.postMessage({ type: 'highlightLines', startLine: start, endLine: end });
          // Blast-radius preview: collect connected files for the graph panel
          const chunkIdx = parseInt(el.dataset.chunk, 10);
          const conn = (currentGraphConnections && !isNaN(chunkIdx)) ? currentGraphConnections[chunkIdx] : null;
          if (conn) {
            const files = new Set([
              ...(conn.outgoing || []).map(s => s.file),
              ...(conn.incoming || []).flatMap(i => (i.refs || []).map(r => r.file)),
            ]);
            if (files.size > 0) {
              vscode.postMessage({ type: 'previewImpact', files: [...files] });
            }
          }
        });
        el.addEventListener('mouseleave', () => {
          vscode.postMessage({ type: 'clearHighlight' }); // also clears graph preview via onPreviewImpact
        });
        el.addEventListener('click', () => {
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          vscode.postMessage({ type: 'revealLines', startLine: start, endLine: end });
        });
      });
      document.querySelectorAll('.line-entry').forEach(el => {
        el.addEventListener('mouseenter', e => {
          e.stopPropagation();
          if (el.querySelector('.edit-mode')) return;
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          vscode.postMessage({ type: 'highlightLines', startLine: start, endLine: end });
        });
        el.addEventListener('click', e => {
          e.stopPropagation();
          if (el.querySelector('.edit-mode')) return;
          if (e.target && e.target.closest && e.target.closest('.edit-btn')) return;
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          vscode.postMessage({ type: 'revealLines', startLine: start, endLine: end });
        });
        el.addEventListener('dblclick', e => {
          e.stopPropagation();
          e.preventDefault();
          if (el.querySelector('.edit-mode')) return;
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          const textSpan = el.querySelector('.line-text');
          const original = textSpan ? textSpan.textContent : '';
          enterEditMode(el, start, end, original);
        });
      });

      document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          const lineEntry = btn.closest('.line-entry');
          if (!lineEntry || lineEntry.querySelector('.edit-mode')) return;
          const start = parseInt(lineEntry.dataset.start, 10);
          const end = parseInt(lineEntry.dataset.end, 10);
          const textSpan = lineEntry.querySelector('.line-text');
          const original = textSpan ? textSpan.textContent : '';
          enterEditMode(lineEntry, start, end, original);
        });
      });

      // Outgoing symbol → navigate to its definition in the editor.
      document.querySelectorAll('.connected-sym.outgoing').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const file = el.dataset.file;
          const line = parseInt(el.dataset.line, 10);
          if (file && line) {
            vscode.postMessage({ type: 'navigateTo', file, line });
          }
        });
      });

      // Incoming symbol → toggle the ref-location dropdown.
      document.querySelectorAll('.connected-sym.incoming.expandable').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const symId = el.dataset.symId;
          const refList = document.querySelector('.ref-list[data-for="' + symId + '"]');
          const toggle = el.querySelector('.sym-toggle');
          if (!refList) return;
          const isOpen = refList.style.display === 'block';
          refList.style.display = isOpen ? 'none' : 'block';
          if (toggle) toggle.style.transform = isOpen ? '' : 'rotate(90deg)';
        });
      });

      // Ref item → navigate to that specific usage location.
      document.querySelectorAll('.ref-item').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const file = el.dataset.file;
          const line = parseInt(el.dataset.line, 10);
          if (file && line) {
            vscode.postMessage({ type: 'navigateTo', file, line });
          }
        });
      });

      // "Review impact" button → open VS Code Quick Pick with affected files.
      const reviewBtn = document.getElementById('btn-review-impact');
      if (reviewBtn) {
        reviewBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'reviewImpact' });
        });
      }
    }

    let activeEditCleanup = null;

    function enterEditMode(lineEntry, startLine, endLine, originalText) {
      if (activeEditCleanup) activeEditCleanup();

      const textSpan = lineEntry.querySelector('.line-text');
      const editBtn = lineEntry.querySelector('.edit-btn');
      if (textSpan) textSpan.style.display = 'none';
      if (editBtn) editBtn.style.display = 'none';

      const wrap = document.createElement('div');
      wrap.className = 'edit-mode';

      const textarea = document.createElement('textarea');
      textarea.className = 'edit-textarea';
      textarea.rows = 3;
      textarea.value = originalText;

      const hint = document.createElement('div');
      hint.className = 'edit-hint';
      hint.textContent = 'Describe what you want this code to do. Cmd/Ctrl+Enter to apply, Esc to cancel.';

      const actions = document.createElement('div');
      actions.className = 'edit-actions';
      const apply = document.createElement('button');
      apply.className = 'edit-btn-apply';
      apply.textContent = 'Apply';
      const cancel = document.createElement('button');
      cancel.className = 'edit-btn-cancel';
      cancel.textContent = 'Cancel';
      actions.appendChild(apply);
      actions.appendChild(cancel);

      wrap.appendChild(textarea);
      wrap.appendChild(hint);
      wrap.appendChild(actions);
      lineEntry.appendChild(wrap);

      setTimeout(() => { textarea.focus(); textarea.select(); }, 0);

      function cleanup() {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (textSpan) textSpan.style.display = '';
        if (editBtn) editBtn.style.display = '';
        activeEditCleanup = null;
      }
      activeEditCleanup = cleanup;

      function doApply() {
        const newEnglish = textarea.value.trim();
        if (!newEnglish || newEnglish === originalText.trim()) {
          cleanup();
          return;
        }
        vscode.postMessage({
          type: 'applyEdit',
          startLine: startLine,
          endLine: endLine,
          originalEnglish: originalText,
          newEnglish: newEnglish
        });
        cleanup();
      }

      apply.addEventListener('click', doApply);
      cancel.addEventListener('click', cleanup);
      textarea.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          doApply();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
        }
      });
    }

    function highlightChunk(index) {
      document.querySelectorAll('.chunk.highlighted').forEach(e => e.classList.remove('highlighted'));
      const el = document.querySelector('[data-chunk="' + index + '"]');
      if (el) {
        el.classList.add('highlighted');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    // ---- Scroll sync ----
    let scrollSyncing = false;
    let scrollDebounce = null;

    function scrollToChunk(index) {
      const el = document.querySelector('[data-chunk="' + index + '"]');
      if (!el) return;
      scrollSyncing = true;
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      setTimeout(() => { scrollSyncing = false; }, 250);
    }

    function topMostVisibleChunkIndex() {
      const chunks = document.querySelectorAll('.chunk');
      for (let i = 0; i < chunks.length; i++) {
        const rect = chunks[i].getBoundingClientRect();
        if (rect.bottom > 0) return i;
      }
      return -1;
    }

    document.addEventListener('scroll', () => {
      if (scrollSyncing) return;
      if (scrollDebounce) clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(() => {
        const idx = topMostVisibleChunkIndex();
        if (idx >= 0) {
          vscode.postMessage({ type: 'panelScrolled', chunkIndex: idx });
        }
      }, 80);
    }, { passive: true });

    // ---- Impact state (cross-file review) ----
    let currentTranslation = null;
    let currentGraphConnections = null;
    let impactedFiles = new Set();

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'update') {
        currentTranslation = msg.translation;
        currentGraphConnections = msg.graphConnections || null;
        impactedFiles = new Set(); // clear impact markers on every file switch
        render(currentTranslation, currentGraphConnections);
      } else if (msg.type === 'setImpact') {
        impactedFiles = new Set(msg.affectedFiles || []);
        if (currentTranslation) render(currentTranslation, currentGraphConnections);
      } else if (msg.type === 'loading') {
        currentTranslation = null;
        currentGraphConnections = null;
        impactedFiles = new Set();
        root.innerHTML =
          '<div class="loading-state">' +
            '<div class="spinner"></div>' +
            '<div class="loading-label">Translating ' + escapeHtml(msg.filename) + '…</div>' +
          '</div>';
      } else if (msg.type === 'highlightChunk') {
        highlightChunk(msg.chunkIndex);
      } else if (msg.type === 'scrollToChunk') {
        scrollToChunk(msg.chunkIndex);
      }
    });
  </script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
