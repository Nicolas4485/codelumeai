import * as path from "node:path";
import * as vscode from "vscode";
import type { GraphStore, FileStat } from "./store";

type InboundMessage =
  | { type: "navigateTo"; file: string }
  | { type: "ready" };

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

  dispose(): void {
    this.panel?.dispose();
  }

  private sendData(store: GraphStore): void {
    if (!this.panel) return;
    const stats = store.stats();
    const allFileStats: FileStat[] = store.getFileStats().filter((f) => f.symbolCount > 0);

    // Cap nodes at 120 for rendering performance; keep the most connected ones.
    const fileStats = allFileStats
      .slice(0, 120)
      .map((f) => ({ ...f, id: f.path, label: f.path.split("/").pop() ?? f.path }));

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
  <button class="tb-btn" id="btn-fit">Fit</button>
  <button class="tb-btn" id="btn-reset">Reset layout</button>
  <div class="tb-sep"></div>
  <span class="tb-stat" id="tb-info">Loading…</span>
</div>
<div id="tooltip">
  <div class="tt-name" id="tt-name"></div>
  <div class="tt-row" id="tt-used"></div>
  <div class="tt-row" id="tt-uses"></div>
  <div class="tt-row" id="tt-syms"></div>
  <div class="tt-hint">Click to open file</div>
</div>
<div id="legend">
  <div class="leg-row"><div class="leg-dot" style="background:#3178C6"></div>TypeScript</div>
  <div class="leg-row"><div class="leg-dot" style="background:#3572A5"></div>Python</div>
  <div class="leg-row"><div class="leg-dot" style="background:#00ADD8"></div>Go</div>
  <div class="leg-row"><div class="leg-dot" style="background:#DEA584"></div>Rust</div>
  <div class="leg-row"><div class="leg-dot" style="background:#7B8DB0"></div>Other</div>
  <div style="margin-top:6px;color:var(--vscode-descriptionForeground)">Node size = how many<br>files depend on it</div>
</div>
<div id="empty" style="display:none">
  <div style="font-size:1.1em;font-weight:600">No graph data yet</div>
  <div>Run <strong>CodeLumeAI: Index Workspace for Connections</strong> first.</div>
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');

  // ── State ────────────────────────────────────────────────────────────────────
  let nodes = [], edges = [], activeFile = null;
  let sim = null;
  let transform = { x: 0, y: 0, scale: 1 };
  let dragging = null, dragOffX = 0, dragOffY = 0;
  let panning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
  let hoveredNode = null;
  let animFrame = null;

  // ── Colors ────────────────────────────────────────────────────────────────────
  const LANG_COLOR = {
    typescript: '#3178C6', typescriptreact: '#3178C6',
    javascript: '#c8a800', javascriptreact: '#c8a800',
    python: '#3572A5',
    go: '#00ADD8',
    rust: '#DEA584',
    java: '#B07219',
    csharp: '#178600',
    ruby: '#701516',
    php: '#4F5D95',
    css: '#563d7c', scss: '#563d7c',
    html: '#e34c26',
  };
  function nodeColor(n) { return LANG_COLOR[n.language] || '#7B8DB0'; }
  function nodeRadius(n) { return Math.max(7, Math.min(28, 7 + n.incomingRefs * 1.4)); }

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

    const hov = hoveredNode;
    const hovSet = hov ? new Set([hov.id, ...edges.filter(e => e.from === hov.id || e.to === hov.id).flatMap(e => [e.from, e.to])]) : null;

    // Edges
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) return;
      const highlighted = hov && (e.from === hov.id || e.to === hov.id);
      const dimmed = hov && !highlighted;
      const alpha = dimmed ? 0.05 : highlighted ? 0.7 : 0.18;
      const w = highlighted ? Math.min(e.weight * 0.5 + 1, 3) : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      // Draw arrow toward b
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const br = nodeRadius(b);
      const ex = b.x - Math.cos(angle) * (br + 4);
      const ey = b.y - Math.sin(angle) * (br + 4);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = highlighted ? 'rgba(79,155,255,' + alpha + ')' : 'rgba(150,150,150,' + alpha + ')';
      ctx.lineWidth = w / transform.scale;
      ctx.stroke();
      // Arrowhead
      if (highlighted) {
        const al = 8 / transform.scale;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - al * Math.cos(angle - 0.4), ey - al * Math.sin(angle - 0.4));
        ctx.lineTo(ex - al * Math.cos(angle + 0.4), ey - al * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = 'rgba(79,155,255,' + alpha + ')';
        ctx.fill();
      }
    });

    // Nodes
    nodes.forEach(n => {
      const r = nodeRadius(n);
      const dimmed = hov && !hovSet.has(n.id);
      const isActive = n.id === activeFile;
      const isHov = n === hov;
      ctx.globalAlpha = dimmed ? 0.2 : 1;

      // Shadow for active/hovered
      if (isActive || isHov) {
        ctx.shadowColor = isActive ? 'rgba(79,155,255,0.6)' : 'rgba(255,255,255,0.3)';
        ctx.shadowBlur = 14 / transform.scale;
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n);
      ctx.fill();

      // Active file ring
      if (isActive) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 / transform.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(79,155,255,0.9)';
        ctx.lineWidth = 2 / transform.scale;
        ctx.stroke();
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Label — always show when zoomed in, only show for hovered/active otherwise
      const showLabel = transform.scale > 0.7 || isHov || isActive;
      if (showLabel) {
        const fontSize = Math.max(9, Math.min(13, 11 / transform.scale));
        ctx.font = (isHov || isActive ? '600 ' : '') + fontSize + 'px var(--vscode-editor-font-family, monospace)';
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

      document.getElementById('empty').style.display = nodes.length === 0 ? 'flex' : 'none';
      canvas.style.display = nodes.length === 0 ? 'none' : 'block';
      document.getElementById('toolbar').style.display = nodes.length === 0 ? 'none' : 'flex';
      document.getElementById('legend').style.display = nodes.length === 0 ? 'none' : 'block';

      if (nodes.length > 0) {
        document.getElementById('tb-info').textContent =
          msg.stats.files + ' files · ' + msg.stats.symbols + ' symbols · ' + msg.stats.refs + ' connections';
        resizeCanvas();
        sim = initSim(nodes, edges);
        // Warm up: 250 ticks off-screen before showing
        for (let i = 0; i < 250; i++) sim.tick();
        fitView();
        simRunning = true;
        setTimeout(() => { simRunning = false; }, 3500);
        runSim();
      }
    }

    if (msg.type === 'highlightFile') {
      activeFile = msg.file;
      scheduleFrame();
    }
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
