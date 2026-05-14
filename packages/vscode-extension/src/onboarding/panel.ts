import * as path from "node:path";
import * as vscode from "vscode";
import type { GraphStore, FileStat, TopSymbol } from "../graph/store";
import type { Briefing, ChatMessage } from "@codelumeai/core";

type InboundMessage =
  | { type: "navigateTo"; file: string; line: number }
  | { type: "generateBriefing" }
  | { type: "regenerateBriefing" }
  | { type: "chat"; message: string };

export interface OnboardingCallbacks {
  generateBriefing: () => Promise<Briefing>;
  chat: (message: string, history: ChatMessage[]) => Promise<string>;
}

/**
 * Onboarding panel for new developers.
 *
 * Three sections, rendered top-to-bottom:
 *  1. Briefing — AI-generated codebase overview. Loads async on first open.
 *  2. Reading order — graph-derived file tiers (foundations / features / entry points).
 *  3. Chat — persistent Q&A grounded in the knowledge graph and briefing.
 */
export class OnboardingPanel {
  private panel: vscode.WebviewPanel | undefined;
  private chatHistory: ChatMessage[] = [];
  private cachedBriefing: Briefing | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspaceFolderUri: vscode.Uri,
    private readonly callbacks: OnboardingCallbacks,
  ) {}

  show(store: GraphStore): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.sendGraphData(store);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codelumeai.onboarding",
      "CodeLumeAI · New Dev Guide",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => {
      switch (msg.type) {
        case "navigateTo":
          void this.navigateTo(msg.file, msg.line);
          break;
        case "generateBriefing":
        case "regenerateBriefing":
          void this.runBriefing(msg.type === "regenerateBriefing");
          break;
        case "chat":
          void this.runChat(msg.message);
          break;
      }
    });

    this.panel.webview.html = this.buildHtml();
    this.sendGraphData(store);

    // Auto-trigger briefing if we have a cached one already, otherwise prompt
    if (this.cachedBriefing) {
      void this.panel.webview.postMessage({ type: "briefingReady", briefing: this.cachedBriefing });
    }
  }

  /** Called after re-indexing to refresh the reading-order data without rebuilding the whole panel. */
  refresh(store: GraphStore): void {
    this.sendGraphData(store);
  }

  setCachedBriefing(briefing: Briefing): void {
    this.cachedBriefing = briefing;
    if (this.panel) {
      void this.panel.webview.postMessage({ type: "briefingReady", briefing });
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private sendGraphData(store: GraphStore): void {
    if (!this.panel) return;
    const stats = store.stats();
    const topSymbols = store.getTopSymbols(12);
    const fileStats = store.getFileStats();
    const workspaceName = path.basename(this.workspaceFolderUri.fsPath);
    void this.panel.webview.postMessage({ type: "graphData", stats, topSymbols, fileStats, workspaceName });
  }

  private async runBriefing(force: boolean): Promise<void> {
    if (!this.panel) return;
    if (this.cachedBriefing && !force) {
      void this.panel.webview.postMessage({ type: "briefingReady", briefing: this.cachedBriefing });
      return;
    }
    void this.panel.webview.postMessage({ type: "briefingLoading" });
    try {
      const briefing = await this.callbacks.generateBriefing();
      this.cachedBriefing = briefing;
      void this.panel.webview.postMessage({ type: "briefingReady", briefing });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[onboarding] briefing failed: ${msg}`);
      void this.panel.webview.postMessage({ type: "briefingError", message: msg });
    }
  }

  private async runChat(userMessage: string): Promise<void> {
    if (!this.panel) return;
    this.chatHistory.push({ role: "user", content: userMessage });
    void this.panel.webview.postMessage({ type: "chatLoading" });
    try {
      const reply = await this.callbacks.chat(userMessage, this.chatHistory);
      this.chatHistory.push({ role: "assistant", content: reply });
      void this.panel.webview.postMessage({ type: "chatResponse", message: reply });
    } catch (err) {
      // Remove the user message we already pushed so history stays consistent
      this.chatHistory.pop();
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[onboarding] chat failed: ${msg}`);
      void this.panel.webview.postMessage({ type: "chatError", message: msg });
    }
  }

  private async navigateTo(workspaceRelFile: string, oneBased: number): Promise<void> {
    const absPath = path.join(
      this.workspaceFolderUri.fsPath,
      workspaceRelFile.replace(/\//g, path.sep),
    );
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
  <title>CodeLumeAI · New Dev Guide</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0; padding: 0; line-height: 1.55;
    }
    .page { max-width: 820px; margin: 0 auto; padding: 28px 24px 80px; }

    /* ── Section shell ── */
    .section { margin-bottom: 32px; }
    .section-header { margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18)); }
    .section-title { font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--vscode-descriptionForeground); margin: 0 0 2px; }
    .section-sub { font-size: 0.88em; color: var(--vscode-descriptionForeground); margin: 0; }

    /* ── Stats row ── */
    .stats-row { display: flex; gap: 24px; margin-bottom: 28px; flex-wrap: wrap; }
    .stat { display: flex; flex-direction: column; }
    .stat-num { font-size: 1.6em; font-weight: 700; line-height: 1.1; }
    .stat-label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }

    /* ── Briefing section ── */
    .briefing-placeholder {
      padding: 20px;
      border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .briefing-placeholder p { margin: 0 0 12px; }
    .btn {
      display: inline-block;
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: 0.88em;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-ghost {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      font-size: 0.78em;
      padding: 3px 10px;
    }
    .btn-ghost:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .loading-row { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .briefing-headline { font-size: 1.15em; font-weight: 700; margin: 0 0 8px; }
    .briefing-overview { color: var(--vscode-foreground); margin: 0 0 16px; }
    .briefing-arch { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin: 0 0 16px; font-style: italic; border-left: 3px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); padding-left: 10px; }
    .briefing-footer { display: flex; justify-content: space-between; align-items: center; }
    .concepts-grid { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
    .concept-card {
      padding: 10px 12px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s, border-color 0.1s;
    }
    .concept-card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
    .concept-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; font-size: 0.93em; background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
    .concept-what { font-size: 0.88em; margin: 4px 0 0; }
    .concept-why { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
    .concept-loc { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin: 4px 0 0; font-family: var(--vscode-editor-font-family, monospace); }
    .start-here {
      margin-top: 4px;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 30%, transparent);
      border-radius: 5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .start-here:hover { background: color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 18%, transparent); }
    .start-here-label { font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-charts-blue, #4f9bff); flex-shrink: 0; }
    .start-here-file { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; font-size: 0.9em; }
    .start-here-reason { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .briefing-error { color: var(--vscode-errorForeground); font-size: 0.88em; padding: 10px; }

    /* ── Reading order ── */
    .sym-row, .file-row {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 8px; border-radius: 4px; cursor: pointer; transition: background 0.1s;
    }
    .sym-row:hover, .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .sym-kind { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.75em; color: var(--vscode-descriptionForeground); min-width: 38px; flex-shrink: 0; }
    .sym-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
    .sym-meta, .file-meta { color: var(--vscode-descriptionForeground); font-size: 0.83em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sym-refs { font-size: 0.82em; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .tier-label { font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); margin: 14px 0 5px; }
    .tier-hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .file-main { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 0; }
    .file-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; white-space: nowrap; }
    .file-stats { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .stat-pill { font-size: 0.74em; padding: 2px 7px; border-radius: 99px; white-space: nowrap; }
    .stat-pill.in { background: color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 16%, transparent); color: var(--vscode-charts-blue, #4f9bff); }
    .stat-pill.out { background: color-mix(in srgb, var(--vscode-charts-orange, #ff9d3d) 16%, transparent); color: var(--vscode-charts-orange, #ff9d3d); }
    .file-stats-legend { font-size: 0.72em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; display: flex; gap: 10px; padding: 0 8px; }
    .dep-bar { width: 44px; height: 4px; background: var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 2px; overflow: hidden; }
    .dep-fill { height: 100%; background: var(--vscode-charts-blue, #4f9bff); border-radius: 2px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 8px; }

    /* ── Chat section ── */
    .chat-messages { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; min-height: 0; }
    .chat-bubble { padding: 10px 14px; border-radius: 8px; font-size: 0.91em; line-height: 1.5; max-width: 100%; }
    .chat-bubble.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); align-self: flex-end; max-width: 85%; }
    .chat-bubble.assistant { background: color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 8%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #4f9bff) 20%, transparent); white-space: pre-wrap; }
    .chat-bubble.loading { color: var(--vscode-descriptionForeground); font-style: italic; }
    .chat-bubble.error { background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 30%, transparent); color: var(--vscode-errorForeground); }
    .chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
    .chat-input {
      flex: 1; padding: 8px 10px; min-height: 38px; max-height: 120px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 5px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      resize: none; outline: none;
    }
    .chat-input:focus { border-color: var(--vscode-focusBorder); }
    .chat-empty-hint { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
  </style>
</head>
<body>
<div class="page">

  <!-- Stats row -->
  <div class="stats-row" id="stats-row">
    <div class="stat"><span class="stat-num" id="stat-files">—</span><span class="stat-label">Files indexed</span></div>
    <div class="stat"><span class="stat-num" id="stat-symbols">—</span><span class="stat-label">Symbols</span></div>
    <div class="stat"><span class="stat-num" id="stat-refs">—</span><span class="stat-label">Connections</span></div>
  </div>

  <!-- Briefing -->
  <div class="section">
    <div class="section-header">
      <p class="section-title">Codebase Overview</p>
      <p class="section-sub">AI-generated briefing — what this codebase does and where to start.</p>
    </div>
    <div id="briefing-area">
      <div class="briefing-placeholder">
        <p>Generate a plain-English briefing for this codebase.</p>
        <button class="btn" id="btn-generate">Generate Overview</button>
      </div>
    </div>
  </div>

  <!-- Reading order -->
  <div class="section">
    <div class="section-header">
      <p class="section-title">Suggested Reading Order</p>
      <p class="section-sub">Start with foundations — files everything else depends on. Blue bar = how foundational.</p>
    </div>
    <div id="reading-order"><div class="empty">Index the workspace first.</div></div>
  </div>

  <!-- Key symbols -->
  <div class="section" id="concepts-section" style="display:none">
    <div class="section-header">
      <p class="section-title">Most-Referenced Symbols</p>
      <p class="section-sub">Symbols used across the most files — understand these first.</p>
    </div>
    <div id="symbols-list"></div>
  </div>

  <!-- Chat -->
  <div class="section">
    <div class="section-header">
      <p class="section-title">Ask Anything</p>
      <p class="section-sub">Questions are answered in the context of this specific codebase.</p>
    </div>
    <div class="chat-messages" id="chat-messages"></div>
    <p class="chat-empty-hint" id="chat-hint">Try: "How does the data flow from input to storage?" or "What would break if I change Triple?"</p>
    <div class="chat-input-row">
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="Ask about this codebase…"></textarea>
      <button class="btn" id="btn-send">Send</button>
    </div>
  </div>

</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function kindLabel(kind) {
    const m = {function:'fn',method:'fn',constructor:'new',class:'class',interface:'iface',struct:'struct',enum:'enum',enumMember:'enum·m',variable:'var',constant:'const',property:'prop',field:'field',namespace:'ns',module:'mod',typeParameter:'type'};
    return m[kind] || kind.slice(0,5);
  }

  function navigate(file, line) {
    vscode.postMessage({ type: 'navigateTo', file, line: line || 1 });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  function renderStats(stats) {
    document.getElementById('stat-files').textContent = stats.files;
    document.getElementById('stat-symbols').textContent = stats.symbols;
    document.getElementById('stat-refs').textContent = stats.refs;
  }

  // ── Symbols list ───────────────────────────────────────────────────────────

  function renderSymbols(topSymbols) {
    const section = document.getElementById('concepts-section');
    const list = document.getElementById('symbols-list');
    if (!topSymbols || topSymbols.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    list.innerHTML = topSymbols.map(s => {
      const filename = s.file.split('/').pop() || s.file;
      return '<div class="sym-row" data-file="' + esc(s.file) + '" data-line="' + s.startLine + '">' +
        '<span class="sym-kind">' + esc(kindLabel(s.kind)) + '</span>' +
        '<span class="sym-name">' + esc(s.name) + '</span>' +
        '<span class="sym-meta">' + esc(filename) + '</span>' +
        '<span class="sym-refs">&times;' + s.totalRefs + ' files</span>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.sym-row').forEach(el => {
      el.addEventListener('click', () => navigate(el.dataset.file, parseInt(el.dataset.line, 10)));
    });
  }

  // ── Reading order ──────────────────────────────────────────────────────────

  function renderReadingOrder(fileStats) {
    const container = document.getElementById('reading-order');
    if (!fileStats || fileStats.length === 0) { container.innerHTML = '<div class="empty">Index the workspace first.</div>'; return; }
    const indexed = fileStats.filter(f => f.symbolCount > 0);
    if (indexed.length === 0) { container.innerHTML = '<div class="empty">No symbols found yet.</div>'; return; }
    const maxIn = Math.max(...indexed.map(f => f.incomingRefs), 1);
    const foundations = indexed.filter(f => f.incomingRefs >= Math.max(2, Math.ceil(maxIn * 0.4)));
    const entryPoints = indexed.filter(f => f.incomingRefs === 0 && f.outgoingDeps > 0);
    const features = indexed.filter(f => !foundations.includes(f) && !entryPoints.includes(f));

    function fileRow(f) {
      const filename = f.path.split('/').pop() || f.path;
      const total = f.incomingRefs + f.outgoingDeps;
      const pct = total > 0 ? Math.round((f.incomingRefs / total) * 100) : 0;
      return '<div class="file-row" data-file="' + esc(f.path) + '" data-line="1">' +
        '<div class="file-main">' +
          '<span class="file-name">' + esc(filename) + '</span>' +
          '<span class="file-meta">' + f.symbolCount + ' symbols</span>' +
        '</div>' +
        '<div class="file-stats">' +
          '<span class="stat-pill in" title="' + f.incomingRefs + ' other file(s) import from this one">used by ' + f.incomingRefs + '</span>' +
          '<span class="stat-pill out" title="This file imports from ' + f.outgoingDeps + ' other file(s)">uses ' + f.outgoingDeps + '</span>' +
          '<div class="dep-bar" title="Foundational score: ' + pct + '%"><div class="dep-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>';
    }

    let html = '';
    if (foundations.length > 0) html += '<div class="tier-label">Foundations <span class="tier-hint">— read these first</span></div>' + foundations.map(fileRow).join('');
    if (features.length > 0) html += '<div class="tier-label">Features <span class="tier-hint">— main logic</span></div>' + features.map(fileRow).join('');
    if (entryPoints.length > 0) html += '<div class="tier-label">Entry Points <span class="tier-hint">— where execution starts</span></div>' + entryPoints.map(fileRow).join('');
    container.innerHTML = html;
    container.querySelectorAll('.file-row').forEach(el => {
      el.addEventListener('click', () => navigate(el.dataset.file, 1));
    });
  }

  // ── Briefing ───────────────────────────────────────────────────────────────

  function renderBriefingLoading() {
    document.getElementById('briefing-area').innerHTML =
      '<div class="loading-row"><span class="spinner"></span> Generating overview… this takes a few seconds.</div>';
  }

  function renderBriefingReady(briefing) {
    const conceptsHtml = briefing.keyConcepts.map(c =>
      '<div class="concept-card" data-file="' + esc(c.file) + '" data-line="' + (c.line || 1) + '">' +
        '<span class="concept-name">' + esc(c.name) + '</span>' +
        '<p class="concept-what">' + esc(c.what) + '</p>' +
        '<p class="concept-why">' + esc(c.why) + '</p>' +
        '<p class="concept-loc">' + esc(c.file) + ':' + (c.line || 1) + '</p>' +
      '</div>'
    ).join('');

    const startHereFilename = briefing.startHere.file.split('/').pop() || briefing.startHere.file;
    const startHereHtml =
      '<div class="start-here" data-file="' + esc(briefing.startHere.file) + '" data-line="' + (briefing.startHere.line || 1) + '">' +
        '<span class="start-here-label">Start Here</span>' +
        '<div><div class="start-here-file">' + esc(startHereFilename) + '</div>' +
        '<div class="start-here-reason">' + esc(briefing.startHere.reason) + '</div></div>' +
      '</div>';

    document.getElementById('briefing-area').innerHTML =
      '<p class="briefing-headline">' + esc(briefing.headline) + '</p>' +
      '<p class="briefing-overview">' + esc(briefing.overview) + '</p>' +
      '<p class="briefing-arch">' + esc(briefing.architecture) + '</p>' +
      '<div class="concepts-grid">' + conceptsHtml + '</div>' +
      startHereHtml +
      '<div class="briefing-footer" style="margin-top:12px">' +
        '<button class="btn btn-ghost" id="btn-regenerate">Regenerate</button>' +
      '</div>';

    document.getElementById('briefing-area').querySelectorAll('.concept-card').forEach(el => {
      el.addEventListener('click', () => navigate(el.dataset.file, parseInt(el.dataset.line, 10)));
    });
    const sh = document.getElementById('briefing-area').querySelector('.start-here');
    if (sh) sh.addEventListener('click', () => navigate(sh.dataset.file, parseInt(sh.dataset.line, 10)));
    const regen = document.getElementById('btn-regenerate');
    if (regen) regen.addEventListener('click', () => vscode.postMessage({ type: 'regenerateBriefing' }));
  }

  function renderBriefingError(message) {
    document.getElementById('briefing-area').innerHTML =
      '<div class="briefing-error">Failed to generate overview: ' + esc(message) + '</div>' +
      '<button class="btn" id="btn-retry" style="margin-top:8px">Retry</button>';
    const btn = document.getElementById('btn-retry');
    if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'generateBriefing' }));
  }

  // Wire generate button
  document.getElementById('btn-generate').addEventListener('click', () => {
    vscode.postMessage({ type: 'generateBriefing' });
  });

  // ── Chat ───────────────────────────────────────────────────────────────────

  let chatLoading = false;

  function appendBubble(role, text) {
    const hint = document.getElementById('chat-hint');
    if (hint) hint.style.display = 'none';
    const msgs = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-bubble ' + role;
    div.textContent = text;
    msgs.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return div;
  }

  let loadingBubble = null;

  function showChatLoading() {
    chatLoading = true;
    document.getElementById('btn-send').disabled = true;
    loadingBubble = appendBubble('assistant loading', 'Thinking…');
  }

  function replaceChatLoading(role, text) {
    chatLoading = false;
    document.getElementById('btn-send').disabled = false;
    if (loadingBubble) {
      loadingBubble.className = 'chat-bubble ' + role;
      loadingBubble.textContent = text;
      loadingBubble = null;
    } else {
      appendBubble(role, text);
    }
  }

  function sendChat() {
    if (chatLoading) return;
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    input.style.height = '';
    appendBubble('user', msg);
    vscode.postMessage({ type: 'chat', message: msg });
  }

  document.getElementById('btn-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  // Auto-resize textarea
  document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // ── Message handler ────────────────────────────────────────────────────────

  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg) return;
    switch (msg.type) {
      case 'graphData':
        renderStats(msg.stats);
        renderSymbols(msg.topSymbols);
        renderReadingOrder(msg.fileStats);
        break;
      case 'briefingLoading':
        renderBriefingLoading();
        break;
      case 'briefingReady':
        renderBriefingReady(msg.briefing);
        break;
      case 'briefingError':
        renderBriefingError(msg.message);
        break;
      case 'chatLoading':
        showChatLoading();
        break;
      case 'chatResponse':
        replaceChatLoading('assistant', msg.message);
        break;
      case 'chatError':
        replaceChatLoading('error', 'Error: ' + msg.message);
        break;
    }
  });
</script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
