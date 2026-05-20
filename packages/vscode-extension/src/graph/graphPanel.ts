import * as path from "node:path";
import * as vscode from "vscode";
import type { GraphStore, FileStat } from "./store";

type InboundMessage =
  | { type: "navigateTo"; file: string }
  | { type: "ready" }
  | { type: "indexWorkspace" };

/**
 * Interactive dependency graph panel.
 * Files → nodes sized by incomingRefs, colored by language.
 * Cross-file refs → directed edges weighted by call count.
 * Force-directed layout, zoom/pan, click to open file.
 */
export class GraphPanel {
  private panel: vscode.WebviewPanel | undefined;
  private activeFile: string | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspaceFolderUri: vscode.Uri,
  ) {}

  show(store: GraphStore): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.sendData(store);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codelumeai.graph",
      "CodeLumeAI · Dependency Graph",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => {
      if (msg.type === "navigateTo") void this.navigateTo(msg.file);
      if (msg.type === "ready") this.sendData(store);
      if (msg.type === "indexWorkspace") {
        void vscode.commands.executeCommand("codelumeai.indexWorkspace");
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  /** Called from extension.ts onDidChangeActiveTextEditor to highlight the active file. */
  highlightFile(workspaceRelFile: string): void {
    this.activeFile = workspaceRelFile;
    if (this.panel) {
      void this.panel.webview.postMessage({ type: "highlightFile", file: workspaceRelFile });
    }
  }

  /**
   * Blast-radius preview: called from the side panel when the user hovers a chunk.
   * Dims all unrelated nodes and highlights the connected files with an amber ring.
   * Pass an empty array to restore normal rendering.
   */
  highlightConnectedFiles(files: string[]): void {
    if (this.panel) {
      void this.panel.webview.postMessage({ type: "highlightConnected", files });
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private sendData(store: GraphStore): void {
    if (!this.panel) return;
    const stats = store.stats();
    const allFileStats: FileStat[] = store.getFileStats().filter((f) => f.symbolCount > 0);

    // Cap nodes at 120 for rendering performance; keep the most connected ones.
    const rawStats = allFileStats.slice(0, 120);

    // ── Architecture clusters: group by first directory segment ────────────────
    const clusterOf = (p: string): string => {
      const parts = p.replace(/\\/g, "/").split("/");
      return parts.length > 1 ? (parts[0] ?? "root") : "root";
    };
    const clusterNames = [...new Set(rawStats.map((f) => clusterOf(f.path)))].sort();
    const clusterIndexMap: Record<string, number> = {};
    clusterNames.forEach((name, i) => { clusterIndexMap[name] = i; });

    const fileStats = rawStats.map((f) => ({
      ...f,
      id: f.path,
      label: f.path.split("/").pop() ?? f.path,
      clusterName: clusterOf(f.path),
      clusterIndex: clusterIndexMap[clusterOf(f.path)] ?? 0,
    }));

    const nodeSet = new Set(fileStats.map((f) => f.path));
    const edges = store.getGraphEdges(400).filter(
      (e) => nodeSet.has(e.from) && nodeSet.has(e.to),
    );

    void this.panel.webview.postMessage({
      type: "setGraph",
      nodes: fileStats,
      edges,
      stats,
      activeFile: this.activeFile,
      clusterNames,
    });
  }

  private async navigateTo(workspaceRelFile: string): Promise<void> {
    const absPath = path.join(
      this.workspaceFolderUri.fsPath,
      workspaceRelFile.replace(/\//g, path.sep),
    );
    const uri = vscode.Uri.file(absPath);
    await vscode.window.showTextDocument(uri, {
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private buildHtml(): string {
    const nonce = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Dependency Graph</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    #canvas { width: 100%; height: 100%; display: block; }
    #toolbar {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 6px; align-items: center;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.92));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 6px; padding: 6px 10px;
      backdrop-filter: blur(8px);
    }
    .tb-btn {
      padding: 3px 10px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 0.82em;
    }
    .tb-btn:hover { background: var(--vscode-list-hoverBackground); }
    .tb-sep { width: 1px; height: 16px; background: var(--vscode-widget-border, rgba(128,128,128,0.3)); margin: 0 2px; }
    .tb-stat { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
    /* Graph / Documents view toggle */
    .view-toggle {
      display: flex; gap: 2px;
      background: var(--vscode-widget-border, rgba(128,128,128,0.18));
      border-radius: 4px; padding: 2px;
    }
    .vt-btn {
      padding: 3px 12px; border: 0; border-radius: 3px;
      background: transparent; color: var(--vscode-descriptionForeground);
      cursor: pointer; font-size: 0.82em; font-family: inherit;
    }
    .vt-btn:hover { color: var(--vscode-foreground); }
    .vt-btn.vt-active {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      box-shadow: 0 1px 2px rgba(0,0,0,0.15);
    }
    /* Documents view — file list with filter + sort */
    #documents-view {
      position: absolute; inset: 0; padding: 64px 32px 32px 32px;
      overflow-y: auto;
    }
    .docs-controls {
      display: flex; gap: 8px; margin-bottom: 16px;
      max-width: 900px;
    }
    #docs-search {
      flex: 1; padding: 7px 12px;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: var(--vscode-font-family); font-size: 0.92em;
    }
    #docs-search:focus { outline: none; border-color: var(--vscode-focusBorder); }
    #docs-sort {
      padding: 7px 12px;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-foreground);
      border-radius: 4px;
      font-family: inherit; font-size: 0.9em;
    }
    #docs-count {
      font-size: 0.82em; color: var(--vscode-descriptionForeground);
      margin-bottom: 8px; max-width: 900px;
    }
    #docs-list {
      display: flex; flex-direction: column; gap: 4px;
      max-width: 900px;
    }
    .doc-item {
      display: flex; align-items: center; gap: 14px;
      padding: 10px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .doc-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .doc-item.doc-active {
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }
    .doc-lang { width: 8px; height: 32px; border-radius: 3px; flex-shrink: 0; }
    .doc-meta { flex: 1; min-width: 0; }
    .doc-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.95em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .doc-stats {
      margin-top: 3px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      display: flex; gap: 14px;
    }
    .doc-stats span::before { opacity: 0.7; margin-right: 3px; }
    .ds-sym::before { content: "□"; }
    .ds-in::before { content: "↓"; }
    .ds-out::before { content: "↑"; }
    .doc-empty {
      padding: 32px; text-align: center;
      color: var(--vscode-descriptionForeground); font-style: italic;
    }
    /* Improved empty state with CTA */
    .empty-icon { font-size: 2.4em; opacity: 0.35; }
    .empty-title { font-size: 1.15em; font-weight: 600; color: var(--vscode-foreground); }
    .empty-desc { max-width: 420px; text-align: center; line-height: 1.55; }
    .empty-cta {
      margin-top: 8px;
      padding: 8px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0; border-radius: 4px;
      font-family: inherit; font-size: 0.95em;
      cursor: pointer;
    }
    .empty-cta:hover { background: var(--vscode-button-hoverBackground); }
    #tooltip {
      position: absolute; pointer-events: none; display: none;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.96));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
      border-radius: 6px; padding: 8px 12px; font-size: 0.82em;
      max-width: 280px; line-height: 1.5; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    #tooltip .tt-name { font-weight: 700; font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 4px; }
    #tooltip .tt-row { color: var(--vscode-descriptionForeground); }
    #tooltip .tt-hint { margin-top: 6px; font-style: italic; color: var(--vscode-descriptionForeground); }
    #legend {
      position: absolute; bottom: 16px; right: 16px;
      background: var(--vscode-editorWidget-background, rgba(30,30,30,0.92));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 6px; padding: 8px 12px; font-size: 0.78em;
    }
    .leg-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .leg-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="toolbar">
  <div class="view-toggle">
    <button class="vt-btn vt-active" data-view="graph">Graph</button>
    <button class="vt-btn" data-view="documents">Documents</button>
  </div>
  <div class="tb-sep"></div>
  <button class="tb-btn graph-only" id="btn-fit">Fit</button>
  <button class="tb-btn graph-only" id="btn-reset">Reset layout</button>
  <div class="tb-sep graph-only"></div>
  <span class="tb-stat" id="tb-info">Loading…</span>
</div>
<div id="documents-view" style="display:none">
  <div class="docs-controls">
    <input type="search" id="docs-search" placeholder="Filter files…" autocomplete="off">
    <select id="docs-sort">
      <option value="incoming">Sort: most depended-on</option>
      <option value="outgoing">Sort: most dependencies</option>
      <option value="symbols">Sort: most symbols</option>
      <option value="path">Sort: path A→Z</option>
    </select>
  </div>
  <div id="docs-count"></div>
  <div id="docs-list"></div>
</div>
<div id="tooltip">
  <div class="tt-name" id="tt-name"></div>
  <div class="tt-row" id="tt-used"></div>
  <div class="tt-row" id="tt-uses"></div>
  <div class="tt-row" id="tt-syms"></div>
  <div class="tt-hint">Click to open file</div>
</div>
<div id="legend">
  <div id="legend-clusters"></div>
  <div style="height:1px;background:var(--vscode-widget-border,rgba(128,128,128,0.3));margin:6px 0"></div>
  <div class="leg-row"><div class="leg-dot" style="background:#e8a735"></div><span style="color:var(--vscode-descriptionForeground)">Moderately depended-on</span></div>
  <div class="leg-row"><div class="leg-dot" style="background:#e05252"></div><span style="color:var(--vscode-descriptionForeground)">Heavily depended-on (risky)</span></div>
  <div style="margin-top:6px;color:var(--vscode-descriptionForeground)">Node size = incoming deps<br>Hover chunk in panel → blast radius</div>
</div>
<div id="empty" style="display:none">
  <div class="empty-icon">🕸️</div>
  <div class="empty-title">No graph data yet</div>
  <div class="empty-desc">Index your workspace to map symbols and references across every file. CodeLumeAI uses your installed language servers — no extra setup.</div>
  <button class="empty-cta" id="empty-cta">Index Workspace</button>
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');

  // ── State ────────────────────────────────────────────────────────────────────
  let nodes = [], edges = [], activeFile = null, clusterNames = [];
  let sim = null;
  let transform = { x: 0, y: 0, scale: 1 };
  let dragging = null, dragOffX = 0, dragOffY = 0;
  let panning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
  let hoveredNode = null;
  let animFrame = null;
  // Blast-radius preview: set of file paths highlighted from side panel chunk hover
  let previewFiles = new Set();
  // View toggle state
  let currentView = 'graph'; // 'graph' | 'documents'
  let docsSearch = '';
  let docsSort = 'incoming';

  // ── Colors ────────────────────────────────────────────────────────────────────
  // Feature 2: cluster palette — 8 distinct colours for module groups
  const CLUSTER_PALETTE = ['#4f9bff','#a78bfa','#34d399','#f59e0b','#f87171','#38bdf8','#fb923c','#c084fc'];

  // Feature 3: lerp two hex colours
  function lerpColor(hex1, hex2, t) {
    const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const a = p(hex1), b = p(hex2);
    const r = Math.round(a[0]+(b[0]-a[0])*t);
    const g = Math.round(a[1]+(b[1]-a[1])*t);
    const bl = Math.round(a[2]+(b[2]-a[2])*t);
    return 'rgb('+r+','+g+','+bl+')';
  }

  // Feature 3: risk-tinted cluster colour
  function nodeColor(n) {
    const base = CLUSTER_PALETTE[(n.clusterIndex || 0) % CLUSTER_PALETTE.length];
    const maxIn = Math.max(...nodes.map(x => x.incomingRefs), 1);
    const score = n.incomingRefs / maxIn;
    if (score < 0.35) return base;
    if (score < 0.65) return lerpColor(base, '#e8a735', (score - 0.35) / 0.3 * 0.4);
    return lerpColor(base, '#e05252', (score - 0.65) / 0.35 * 0.6);
  }

  function nodeRadius(n) { return Math.max(7, Math.min(28, 7 + n.incomingRefs * 1.4)); }

  // ── Cluster halo rendering (Feature 2) ───────────────────────────────────────
  function roundRect(cx, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(cx + r, y);
    ctx.lineTo(cx + w - r, y);
    ctx.quadraticCurveTo(cx + w, y, cx + w, y + r);
    ctx.lineTo(cx + w, y + h - r);
    ctx.quadraticCurveTo(cx + w, y + h, cx + w - r, y + h);
    ctx.lineTo(cx + r, y + h);
    ctx.quadraticCurveTo(cx, y + h, cx, y + h - r);
    ctx.lineTo(cx, y + r);
    ctx.quadraticCurveTo(cx, y, cx + r, y);
    ctx.closePath();
  }

  function drawClusterHalos() {
    if (!nodes.length || !clusterNames.length) return;
    const groups = {};
    nodes.forEach(n => {
      if (!groups[n.clusterName]) groups[n.clusterName] = [];
      groups[n.clusterName].push(n);
    });
    Object.entries(groups).forEach(([name, gNodes]) => {
      const color = CLUSTER_PALETTE[(gNodes[0].clusterIndex || 0) % CLUSTER_PALETTE.length];
      const pad = 50;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      gNodes.forEach(n => {
        const r = nodeRadius(n);
        minX = Math.min(minX, n.x - r - pad); minY = Math.min(minY, n.y - r - pad);
        maxX = Math.max(maxX, n.x + r + pad); maxY = Math.max(maxY, n.y + r + pad);
      });
      const bw = maxX - minX, bh = maxY - minY;
      const rx = Math.min(20, bw / 3, bh / 3);

      ctx.save();
      // Fill
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = color;
      roundRect(minX, minY, bw, bh, rx);
      ctx.fill();
      // Border
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / transform.scale;
      roundRect(minX, minY, bw, bh, rx);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Label — only visible when zoomed out enough to see structure
      if (transform.scale > 0.28) {
        const fs = Math.max(10, Math.min(18, 14 / transform.scale));
        ctx.font = '600 ' + fs + 'px var(--vscode-font-family, sans-serif)';
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.45;
        ctx.textAlign = 'center';
        ctx.fillText(name, (minX + maxX) / 2, minY - 6 / transform.scale);
      }
      ctx.restore();
    });
  }

  // ── Force simulation ──────────────────────────────────────────────────────────
  function initSim(ns, es) {
    const W = canvas.width, H = canvas.height;
    // Place nodes in a circle initially
    ns.forEach((n, i) => {
      const angle = (i / ns.length) * Math.PI * 2;
      const r = Math.min(W, H) * 0.35;
      n.x = W / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 40;
      n.y = H / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 40;
      n.vx = 0; n.vy = 0; n.fx = null; n.fy = null;
    });

    // Build adjacency for faster edge lookups
    const idxMap = {};
    ns.forEach((n, i) => { idxMap[n.id] = i; });

    function tick() {
      const k = 0.85; // damping
      const repulse = 3200;
      const gravity = 0.012;
      const cx = W / 2, cy = H / 2;

      // Reset forces
      ns.forEach(n => { n.ax = 0; n.ay = 0; });

      // Repulsion between all node pairs (O(n²), fine for ≤120 nodes)
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const a = ns[i], b = ns[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist2 = dx * dx + dy * dy + 1;
          const dist = Math.sqrt(dist2);
          const force = repulse / dist2;
          const fx = force * dx / dist, fy = force * dy / dist;
          a.ax -= fx; a.ay -= fy;
          b.ax += fx; b.ay += fy;
        }
      }

      // Spring attraction along edges
      es.forEach(e => {
        const a = ns[idxMap[e.from]], b = ns[idxMap[e.to]];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const target = 120 + 60 / (e.weight || 1);
        const stretch = dist - target;
        const strength = 0.04 * Math.min(e.weight, 5);
        const fx = strength * stretch * dx / dist;
        const fy = strength * stretch * dy / dist;
        a.ax += fx; a.ay += fy;
        b.ax -= fx; b.ay -= fy;
      });

      // Center gravity
      ns.forEach(n => {
        n.ax += gravity * (cx - n.x);
        n.ay += gravity * (cy - n.y);
      });

      // Integrate
      ns.forEach(n => {
        if (n.fx !== null) { n.x = n.fx; n.vx = 0; return; }
        n.vx = (n.vx + n.ax) * k;
        n.vy = (n.vy + n.ay) * k;
        n.x += n.vx;
        n.y += n.vy;
      });
    }

    return { tick, idxMap };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    // Cluster halos drawn first (Feature 2), below edges and nodes
    drawClusterHalos();

    const hov = hoveredNode;
    const hasPreview = previewFiles.size > 0;
    // hovSet: nodes visually connected to the hovered node
    const hovSet = hov ? new Set([hov.id, ...edges.filter(e => e.from === hov.id || e.to === hov.id).flatMap(e => [e.from, e.to])]) : null;

    // Determine highlight mode: hover takes precedence over blast-radius preview
    const useHover = !!hov;
    const usePreview = hasPreview && !useHover;

    // Edges
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) return;
      let highlighted = false, dimmed = false, isAmber = false;
      if (useHover) {
        highlighted = e.from === hov.id || e.to === hov.id;
        dimmed = !highlighted;
      } else if (usePreview) {
        highlighted = previewFiles.has(e.from) && previewFiles.has(e.to);
        dimmed = !highlighted;
        isAmber = highlighted;
      }
      const alpha = dimmed ? 0.05 : highlighted ? 0.7 : 0.18;
      const lw = highlighted ? Math.min(e.weight * 0.5 + 1, 3) : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const br = nodeRadius(b);
      const ex = b.x - Math.cos(angle) * (br + 4);
      const ey = b.y - Math.sin(angle) * (br + 4);
      ctx.lineTo(ex, ey);
      const edgeColor = isAmber ? 'rgba(232,167,53,' : 'rgba(79,155,255,';
      ctx.strokeStyle = highlighted ? (edgeColor + alpha + ')') : ('rgba(150,150,150,' + alpha + ')');
      ctx.lineWidth = lw / transform.scale;
      ctx.stroke();
      // Arrowhead on highlighted edges
      if (highlighted) {
        const al = 8 / transform.scale;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - al * Math.cos(angle - 0.4), ey - al * Math.sin(angle - 0.4));
        ctx.lineTo(ex - al * Math.cos(angle + 0.4), ey - al * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = (isAmber ? 'rgba(232,167,53,' : 'rgba(79,155,255,') + alpha + ')';
        ctx.fill();
      }
    });

    // Nodes
    nodes.forEach(n => {
      const r = nodeRadius(n);
      let dimmed = false;
      if (useHover) {
        dimmed = !hovSet.has(n.id);
      } else if (usePreview) {
        dimmed = !previewFiles.has(n.id);
      }
      const isActive = n.id === activeFile;
      const isHov = n === hov;
      const isPreviewHit = usePreview && previewFiles.has(n.id);
      ctx.globalAlpha = dimmed ? 0.15 : 1;

      // Glow for active / hovered / preview-hit
      if (isActive) {
        ctx.shadowColor = 'rgba(79,155,255,0.6)';
        ctx.shadowBlur = 14 / transform.scale;
      } else if (isHov) {
        ctx.shadowColor = 'rgba(255,255,255,0.3)';
        ctx.shadowBlur = 14 / transform.scale;
      } else if (isPreviewHit) {
        ctx.shadowColor = 'rgba(232,167,53,0.5)';
        ctx.shadowBlur = 12 / transform.scale;
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n);
      ctx.fill();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Active file ring (blue)
      if (isActive) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 / transform.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(79,155,255,0.9)';
        ctx.lineWidth = 2 / transform.scale;
        ctx.stroke();
      }

      // Blast-radius ring (amber) — distinct from active-file ring
      if (isPreviewHit && !isActive) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 / transform.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(232,167,53,0.9)';
        ctx.lineWidth = 2.5 / transform.scale;
        ctx.stroke();
      }

      // Label — always show when zoomed in, only show for hovered/active/preview otherwise
      const showLabel = transform.scale > 0.7 || isHov || isActive || isPreviewHit;
      if (showLabel) {
        const fontSize = Math.max(9, Math.min(13, 11 / transform.scale));
        ctx.font = (isHov || isActive || isPreviewHit ? '600 ' : '') + fontSize + 'px var(--vscode-editor-font-family, monospace)';
        ctx.fillStyle = dimmed ? 'rgba(200,200,200,0.3)' : 'rgba(220,220,220,0.95)';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + r + fontSize + 2);
      }
      ctx.globalAlpha = 1;
    });

    ctx.restore();
  }

  function scheduleFrame() {
    if (animFrame) return;
    animFrame = requestAnimationFrame(() => { animFrame = null; draw(); });
  }

  // ── Simulation loop ────────────────────────────────────────────────────────────
  let simRunning = false;
  function runSim() {
    if (!sim || !simRunning) return;
    for (let i = 0; i < 3; i++) sim.tick();
    draw();
    requestAnimationFrame(runSim);
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────────
  function screenToWorld(sx, sy) {
    return { x: (sx - transform.x) / transform.scale, y: (sy - transform.y) / transform.scale };
  }
  function nodeAt(sx, sy) {
    const w = screenToWorld(sx, sy);
    return nodes.find(n => {
      const dx = n.x - w.x, dy = n.y - w.y;
      return Math.sqrt(dx * dx + dy * dy) <= nodeRadius(n) + 4;
    }) || null;
  }

  // ── Fit view ──────────────────────────────────────────────────────────────────
  function fitView() {
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      const r = nodeRadius(n);
      minX = Math.min(minX, n.x - r); minY = Math.min(minY, n.y - r);
      maxX = Math.max(maxX, n.x + r); maxY = Math.max(maxY, n.y + r);
    });
    const pad = 60;
    const scaleX = (canvas.width - pad * 2) / (maxX - minX + 1);
    const scaleY = (canvas.height - pad * 2) / (maxY - minY + 1);
    transform.scale = Math.min(scaleX, scaleY, 2);
    transform.x = pad + (canvas.width - pad * 2 - (maxX - minX) * transform.scale) / 2 - minX * transform.scale;
    transform.y = pad + (canvas.height - pad * 2 - (maxY - minY) * transform.scale) / 2 - minY * transform.scale;
    scheduleFrame();
  }

  // ── Canvas resize ─────────────────────────────────────────────────────────────
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    scheduleFrame();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ── Mouse events ──────────────────────────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    const n = nodeAt(e.clientX, e.clientY);
    if (n) {
      dragging = n;
      const w = screenToWorld(e.clientX, e.clientY);
      dragOffX = n.x - w.x; dragOffY = n.y - w.y;
      n.fx = n.x; n.fy = n.y;
    } else {
      panning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panOriginX = transform.x; panOriginY = transform.y;
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (dragging) {
      const w = screenToWorld(e.clientX, e.clientY);
      dragging.x = dragging.fx = w.x + dragOffX;
      dragging.y = dragging.fy = w.y + dragOffY;
      scheduleFrame();
      return;
    }
    if (panning) {
      transform.x = panOriginX + e.clientX - panStartX;
      transform.y = panOriginY + e.clientY - panStartY;
      scheduleFrame();
      return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    if (n !== hoveredNode) { hoveredNode = n; scheduleFrame(); }
    if (n) {
      canvas.style.cursor = 'pointer';
      const tt = tooltip;
      document.getElementById('tt-name').textContent = n.label;
      document.getElementById('tt-used').textContent = 'Used by ' + n.incomingRefs + ' file' + (n.incomingRefs === 1 ? '' : 's');
      document.getElementById('tt-uses').textContent = 'Uses ' + n.outgoingDeps + ' file' + (n.outgoingDeps === 1 ? '' : 's');
      document.getElementById('tt-syms').textContent = n.symbolCount + ' symbols';
      tt.style.display = 'block';
      tt.style.left = (e.clientX + 14) + 'px';
      tt.style.top = (e.clientY - 10) + 'px';
    } else {
      canvas.style.cursor = 'default';
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseup', e => {
    if (dragging) { dragging = null; }
    panning = false;
  });

  canvas.addEventListener('dblclick', e => {
    // Unpin node on double-click
    const n = nodeAt(e.clientX, e.clientY);
    if (n) { n.fx = null; n.fy = null; }
  });

  canvas.addEventListener('click', e => {
    const n = nodeAt(e.clientX, e.clientY);
    if (n) vscode.postMessage({ type: 'navigateTo', file: n.id });
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredNode = null; tooltip.style.display = 'none';
    canvas.style.cursor = 'default';
    scheduleFrame();
  });

  // Wheel zoom
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const newScale = Math.max(0.08, Math.min(4, transform.scale * factor));
    // Zoom toward cursor
    transform.x = e.clientX - (e.clientX - transform.x) * (newScale / transform.scale);
    transform.y = e.clientY - (e.clientY - transform.y) * (newScale / transform.scale);
    transform.scale = newScale;
    scheduleFrame();
  }, { passive: false });

  // ── Toolbar ───────────────────────────────────────────────────────────────────
  document.getElementById('btn-fit').addEventListener('click', fitView);
  document.getElementById('btn-reset').addEventListener('click', () => {
    nodes.forEach(n => { n.fx = null; n.fy = null; });
    if (sim) {
      const W = canvas.width, H = canvas.height;
      nodes.forEach((n, i) => {
        const angle = (i / nodes.length) * Math.PI * 2;
        const r = Math.min(W, H) * 0.35;
        n.x = W / 2 + Math.cos(angle) * r;
        n.y = H / 2 + Math.sin(angle) * r;
        n.vx = 0; n.vy = 0;
      });
      simRunning = true;
      setTimeout(() => { simRunning = false; fitView(); }, 4000);
      runSim();
    }
  });

  // ── Message handler ───────────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'setGraph') {
      nodes = msg.nodes;
      edges = msg.edges;
      activeFile = msg.activeFile || null;
      clusterNames = msg.clusterNames || [];
      previewFiles = new Set(); // clear any stale blast-radius state

      const hasData = nodes.length > 0;
      document.getElementById('empty').style.display = hasData ? 'none' : 'flex';
      document.getElementById('toolbar').style.display = hasData ? 'flex' : 'none';
      applyViewVisibility();

      if (hasData) {
        document.getElementById('tb-info').textContent =
          msg.stats.files + ' files · ' + msg.stats.symbols + ' symbols · ' + msg.stats.refs + ' connections';

        // Update legend cluster entries (Feature 2)
        const legendClusters = document.getElementById('legend-clusters');
        if (legendClusters && clusterNames.length) {
          legendClusters.innerHTML = clusterNames.map((name, i) => {
            const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
            return '<div class="leg-row"><div class="leg-dot" style="background:' + color + '"></div>' +
              '<span style="color:var(--vscode-descriptionForeground)">' + escapeHtml(name) + '</span></div>';
          }).join('');
        }

        if (currentView === 'graph') {
          resizeCanvas();
          sim = initSim(nodes, edges);
          for (let i = 0; i < 250; i++) sim.tick();
          fitView();
          simRunning = true;
          setTimeout(() => { simRunning = false; }, 3500);
          runSim();
        } else {
          renderDocsList();
        }
      }
    }

    if (msg.type === 'highlightFile') {
      activeFile = msg.file;
      scheduleFrame();
    }

    // Feature 1: blast-radius preview from side panel chunk hover
    if (msg.type === 'highlightConnected') {
      previewFiles = new Set(msg.files || []);
      scheduleFrame();
    }
  });

  // ── View toggle + Documents list ──────────────────────────────────────────────
  function applyViewVisibility() {
    const hasData = nodes.length > 0;
    canvas.style.display = (hasData && currentView === 'graph') ? 'block' : 'none';
    document.getElementById('legend').style.display = (hasData && currentView === 'graph') ? 'block' : 'none';
    document.getElementById('documents-view').style.display = (hasData && currentView === 'documents') ? 'block' : 'none';
    // Graph-only toolbar items
    document.querySelectorAll('.graph-only').forEach(el => {
      el.style.display = currentView === 'graph' ? '' : 'none';
    });
  }

  function setView(view) {
    if (view === currentView) return;
    currentView = view;
    document.querySelectorAll('.vt-btn').forEach(b => {
      b.classList.toggle('vt-active', b.dataset.view === view);
    });
    applyViewVisibility();
    if (view === 'documents') {
      renderDocsList();
    } else if (view === 'graph' && nodes.length > 0 && !sim) {
      resizeCanvas();
      sim = initSim(nodes, edges);
      for (let i = 0; i < 250; i++) sim.tick();
      fitView();
    } else if (view === 'graph') {
      resizeCanvas();
      scheduleFrame();
    }
  }

  document.querySelectorAll('.vt-btn').forEach(b => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function renderDocsList() {
    const list = document.getElementById('docs-list');
    const countEl = document.getElementById('docs-count');
    if (!nodes.length) {
      list.innerHTML = '<div class="doc-empty">No files indexed yet.</div>';
      countEl.textContent = '';
      return;
    }
    const q = docsSearch.toLowerCase();
    let items = q ? nodes.filter(n => n.path.toLowerCase().includes(q)) : nodes.slice();
    const sorters = {
      incoming: (a, b) => b.incomingRefs - a.incomingRefs || a.path.localeCompare(b.path),
      outgoing: (a, b) => b.outgoingDeps - a.outgoingDeps || a.path.localeCompare(b.path),
      symbols: (a, b) => b.symbolCount - a.symbolCount || a.path.localeCompare(b.path),
      path: (a, b) => a.path.localeCompare(b.path),
    };
    items.sort(sorters[docsSort] || sorters.incoming);

    countEl.textContent = items.length + ' file' + (items.length === 1 ? '' : 's') +
      (q ? ' matching "' + q + '"' : '') + ' · click to open';

    list.innerHTML = items.map(n => {
      const isActive = n.path === activeFile;
      const color = LANG_COLOR[n.language] || '#7B8DB0';
      return '<div class="doc-item' + (isActive ? ' doc-active' : '') + '" data-path="' + escapeHtml(n.path) + '">' +
        '<div class="doc-lang" style="background:' + color + '"></div>' +
        '<div class="doc-meta">' +
          '<div class="doc-path">' + escapeHtml(n.path) + '</div>' +
          '<div class="doc-stats">' +
            '<span class="ds-sym">' + n.symbolCount + ' symbols</span>' +
            '<span class="ds-in">' + n.incomingRefs + ' incoming</span>' +
            '<span class="ds-out">' + n.outgoingDeps + ' outgoing</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.doc-item').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'navigateTo', file: el.dataset.path });
      });
    });
  }

  document.getElementById('docs-search').addEventListener('input', e => {
    docsSearch = e.target.value;
    renderDocsList();
  });
  document.getElementById('docs-sort').addEventListener('change', e => {
    docsSort = e.target.value;
    renderDocsList();
  });

  // Empty-state CTA → trigger the existing index command
  document.getElementById('empty-cta').addEventListener('click', () => {
    vscode.postMessage({ type: 'indexWorkspace' });
  });

  // Signal ready to receive data
  vscode.postMessage({ type: 'ready' });
})();
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
