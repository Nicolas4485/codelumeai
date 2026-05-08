import * as vscode from "vscode";
import type { Translation } from "@codelumeai/core";

interface WebviewMessage {
  type: "highlightLines" | "clearHighlight" | "revealLines";
  startLine?: number;
  endLine?: number;
}

/**
 * The plain-English side panel. A VS Code webview that renders the
 * Translation as a readable document and stays in sync with the editor:
 *
 * - Editor cursor moves → matching chunk in panel highlights and scrolls into view.
 * - Panel chunk hovered → matching line range in editor gets a soft highlight.
 * - Panel chunk clicked → editor jumps to that line.
 * - Editor file saved or switched → panel updates automatically (driven from extension.ts).
 */
export class SidePanel {
  private panel: vscode.WebviewPanel | undefined;
  private currentDocument: vscode.TextDocument | undefined;
  private currentTranslation: Translation | undefined;
  private readonly decorationType: vscode.TextEditorDecorationType;

  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
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
      switch (msg.type) {
        case "highlightLines":
          if (msg.startLine !== undefined && msg.endLine !== undefined) {
            this.highlightLinesInEditor(msg.startLine, msg.endLine);
          }
          return;
        case "clearHighlight":
          this.clearEditorHighlights();
          return;
        case "revealLines":
          if (msg.startLine !== undefined && msg.endLine !== undefined) {
            this.revealLinesInEditor(msg.startLine, msg.endLine);
          }
          return;
      }
    });

    // If a translation was already cached before the panel opened, send it now.
    if (this.currentTranslation) {
      this.update(this.currentTranslation, this.currentDocument);
    }
  }

  /** Render a translation. Updates the panel title to reflect the file. */
  update(translation: Translation, document?: vscode.TextDocument): void {
    this.currentTranslation = translation;
    if (document) {
      this.currentDocument = document;
    }
    if (this.panel) {
      const filename = this.currentDocument?.fileName.split(/[\\/]/).pop();
      if (filename) {
        this.panel.title = `${filename} · Plain English`;
      }
      void this.panel.webview.postMessage({ type: "update", translation });
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

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.decorationType.dispose();
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

  private revealLinesInEditor(
    startOneBased: number,
    endOneBased: number,
  ): void {
    if (!this.currentDocument) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.currentDocument,
    );
    if (!editor) {
      return;
    }
    const start = Math.max(0, startOneBased - 1);
    const end = Math.min(editor.document.lineCount - 1, endOneBased - 1);
    if (end < start) {
      return;
    }
    const endChar = editor.document.lineAt(end).text.length;
    const range = new vscode.Range(start, 0, end, endChar);
    // InCenter always scrolls (centers the range), so the user sees movement
    // even if the range was technically already visible.
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    // Selecting the whole range gives clear visible feedback that the click
    // landed on these lines — way more obvious than just placing a cursor.
    editor.selection = new vscode.Selection(start, 0, end, endChar);
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
      return start === end ? 'L' + start : 'L' + start + '–' + end;
    }

    function render(translation) {
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
        const linesHtml = (c.lines || []).map(l => {
          return '<li class="line-entry" data-start="' + l.startLine + '" data-end="' + l.endLine + '">' +
            '<span class="line-range">' + fmtRange(l.startLine, l.endLine) + '</span>' +
            escapeHtml(l.english) +
          '</li>';
        }).join('');
        const noteHtml = c.note ? '<div class="note">⚠ ' + escapeHtml(c.note) + '</div>' : '';
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
        });
        el.addEventListener('mouseleave', () => {
          vscode.postMessage({ type: 'clearHighlight' });
        });
        el.addEventListener('click', () => {
          const start = parseInt(el.dataset.start, 10);
          vscode.postMessage({ type: 'revealLines', startLine: start, endLine: end });
        });
      });
      document.querySelectorAll('.line-entry').forEach(el => {
        el.addEventListener('mouseenter', e => {
          e.stopPropagation();
          const start = parseInt(el.dataset.start, 10);
          const end = parseInt(el.dataset.end, 10);
          vscode.postMessage({ type: 'highlightLines', startLine: start, endLine: end });
        });
        el.addEventListener('click', e => {
          e.stopPropagation();
          const start = parseInt(el.dataset.start, 10);
          vscode.postMessage({ type: 'revealLines', startLine: start, endLine: end });
        });
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

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        render(msg.translation);
      } else if (msg && msg.type === 'highlightChunk') {
        highlightChunk(msg.chunkIndex);
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
