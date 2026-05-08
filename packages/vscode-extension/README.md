# CodeLumeAI

**Read your code in plain English. Edit your code by editing the English.**

CodeLumeAI puts a plain-English layer over your source code. Hover any line and a tooltip explains what it does. Open the side panel and the whole file appears as a readable document, scroll-synced with the editor. Edit the English in the panel and an AI proposes the corresponding code change with a diff preview before anything is written.

> ⚠ **Pre-release / beta.** Bring your own [Anthropic API key](https://console.anthropic.com/). Free during beta — you pay Anthropic for the API calls.

---

## Quick start (30 seconds)

1. Install the extension
2. `Ctrl+Shift+P` → **CodeLumeAI: Set Anthropic API Key** → paste your `sk-...` key
3. Open any code file (Python, JavaScript, TypeScript, Go, Rust, Java, C#, Ruby, PHP, HTML, CSS)
4. Hover a line — a tooltip appears with the English translation
5. `Ctrl+Shift+P` → **CodeLumeAI: Open Side Panel** for the full-file view

The first translation of a file takes ~25 seconds. Subsequent hovers are instant — translations are cached until you save the file.

---

## What CodeLumeAI does

### Hover mode

Move your mouse over any line of code. A two-section tooltip appears:

- **Top:** what *this specific line* does, in plain English
- **Bottom:** the surrounding chunk's title, summary, and a bulleted list of every line in the chunk with its own translation

Confidence pills (`✓ high`, `~ medium`, `? low`) tell you how literal the translation is. Low-confidence chunks come with a warning explaining why (regex, framework magic, ambiguity).

### Side panel — read mode

`CodeLumeAI: Open Side Panel` splits the editor and shows the whole file as a readable document on the right:

- A **language primer** at the top explains the syntactic constructs the file uses (class, decorator, type hints, etc.) so non-engineers aren't stuck
- Each **chunk card** shows title, line range, confidence, summary, and per-line bullets
- **Bidirectional sync:** hover or click a card → matching code highlights / scrolls into view in the editor. Move the cursor in the editor → matching card highlights in the panel. Scroll either pane → the other follows.

### Side panel — edit mode (opt-in)

Click the **✎** pencil on any English bullet (or double-click the bullet) → the English becomes editable. Type what you want changed in plain English. Press `Cmd/Ctrl+Enter`.

CodeLumeAI sends your edited English + the original code + the file context to Claude, which proposes a replacement for that line range. A **diff editor opens** showing original ↔ proposed side-by-side. A modal asks **Apply** or **Discard**. Nothing is written until you confirm.

Refusal cases:
- **Low-confidence changes** are refused outright (regex, framework magic, ambiguous instructions)
- **Medium-confidence changes** show a warning before apply (undefined references, missing imports, mixed style)

Edit mode is **off by default**. The first time you try to apply, a modal asks to enable it for the workspace.

### Always-on mode

A third mode renders a one-line summary as an inlay hint at the end of every chunk in the editor. Click the `CodeLumeAI: hover` item in the status bar to cycle Off → Hover → Always-on.

---

## Configuration

| Setting | Default | What it controls |
|---|---|---|
| `codelumeai.mode` | `hover` | Display mode: `off`, `hover`, or `always-on` |
| `codelumeai.model` | `claude-haiku-4-5` | Anthropic model. Switch to `claude-sonnet-4-6` for higher quality at higher cost. |
| `codelumeai.maxFileLines` | `2000` | Skip files larger than this |
| `codelumeai.editEnabled` | `false` | Per-workspace opt-in for bidirectional edit |

---

## Privacy & security

- **Your API key** is stored in VS Code's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — encrypted by your OS, never written to `settings.json`, never committed to a repo, never logged.
- **Source code is sent to Anthropic** when you trigger a translation or apply an edit. Anthropic's data usage is governed by [their Commercial Terms](https://www.anthropic.com/legal/commercial-terms). CodeLumeAI itself doesn't store, log, or transmit your code anywhere else.
- **No telemetry.** v0.1 sends no analytics. Logs stay local in the `CodeLumeAI` Output channel.

---

## Languages supported

Python, JavaScript, TypeScript, JSX, TSX, Go, Rust, Java, C#, Ruby, PHP, HTML, CSS, SCSS.

Other languages may work but aren't activated by default — open an issue if you want one added.

---

## Cost

CodeLumeAI is free during beta. You pay Anthropic for the API calls.

For a 250-line file, a typical translation uses ~6,000 input tokens and ~10,000 output tokens with Claude Haiku 4.5 — roughly **$0.05 per first translation**. Subsequent hovers in the same file are free (cached locally until the file is saved).

Edit-mode applies are smaller, ~3,000 in / ~500 out — about **$0.005 per change**.

Numbers will vary with file size and model choice. Switch to `claude-sonnet-4-6` for higher quality at ~5× the cost.

---

## Companion: Claude Code plugin

Available separately. Adds `/codelumeai:translate`, `/codelumeai:summary`, `/codelumeai:edit`, `/codelumeai:explain`, and `/codelumeai:update` to any Claude Code surface — CLI, the Claude Code VS Code extension, JetBrains, Claude desktop, Claude web. Same prompts, broader reach.

See the [GitHub repo](https://github.com/Nicolas4485/codelumeai) for the plugin code under `packages/claude-plugin/`.

---

## Roadmap

- **Phase 5:** cross-file knowledge graph — "what touches `Triple`?", "what does `query_fuzzy` depend on?", impact analysis before edits
- **Phase 6:** onboarding system for new devs joining a codebase, built on top of the graph

---

## Issues, feedback, contributing

[github.com/Nicolas4485/codelumeai/issues](https://github.com/Nicolas4485/codelumeai/issues)

---

## License

MIT — see [LICENSE](https://github.com/Nicolas4485/codelumeai/blob/main/LICENSE).
