import * as vscode from "vscode";
import type { Translation } from "@codelumeai/core";

interface WebviewMessage {
  type:
    | "highlightLines"
    | "clearHighlight"
    | "revealLines"
    | "panelScrolled";
  startLine?: number;
  endLine?: number;
  chunkIndex?: number;
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
  private readonly flashDecorationType: vscode.TextEditorDecorationType;
  private flashTimer: NodeJS.Timeout | undefined;

  // Loop-prevention for bidirectional scroll sync.
  // When we sync editor -> panel, we scroll the panel programmatically; that
  // triggers a panel scroll event which would otherwise sync back to the
  // editor. The same in reverse. Each suppressXUntil timestamp says
  // "ignore X-direction scroll events until this Date.now() value".
  private suppressEditorSyncUntil = 0;
  private suppressPanelSyncUntil = 0;

  constructor(private readonly output: vscode.OutputChannel) {
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
    // 2) Move the cursor to the start of the chunk (a small, non-disruptive
    //    selection just at the first line — full-range selection turned out
    //    to feel too invasive when the user is reading).
    editor.selection = new vscode.Selection(start, 0, start, 0);
    // 3) Apply a high-contrast flash highlight across the whole range so the
    //    user can clearly see WHERE the click landed, then auto-clear after
    //    1.5 seconds so the editor isn't left visually noisy.
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

    // ---- Scroll sync ----
    // We programmatically scroll on 'scrollToChunk' messages from the
    // extension. That programmatic scroll fires our scroll listener; we
    // need to suppress the resulting 'panelScrolled' message to avoid a
    // sync loop. \`scrollSyncing\` is the suppression flag.
    let scrollSyncing = false;
    let scrollDebounce = null;

    function scrollToChunk(index) {
      const el = document.querySelector('[data-chunk="' + index + '"]');
      if (!el) return;
      scrollSyncing = true;
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      // Allow some frames for the scroll to settle, then re-arm.
      setTimeout(() => { scrollSyncing = false; }, 250);
    }

    function topMostVisibleChunkIndex() {
      const chunks = document.querySelectorAll('.chunk');
      for (let i = 0; i < chunks.length; i++) {
        const rect = chunks[i].getBoundingClientRect();
        // Pick the first chunk whose bottom is below the top of the viewport.
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

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'update') {
        render(msg.translation);
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
