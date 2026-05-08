# Changelog

All notable changes to CodeLumeAI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-08

First public release.

### Added

- **Hover mode.** Mouse over any line in a supported file (Python, JavaScript, TypeScript, Go, Rust, Java, C#, Ruby, PHP, HTML, CSS) and a tooltip shows the current line in plain English plus the surrounding chunk for context. First hover translates the file (~25–30 s); subsequent hovers are instant from cache.
- **Always-on inline hints.** A second mode renders a one-line summary at the end of every chunk. Toggle via the `CodeLumeAI: hover` status bar item — cycles Off → Hover → Always-on.
- **Plain-English side panel.** `CodeLumeAI: Open Side Panel` opens a webview alongside the editor showing the whole file as a readable document — primer, then per-chunk cards with title, summary, and per-line bullets.
- **Bidirectional sync.** Hover a line in the editor → matching chunk highlights in the panel. Hover or click a chunk in the panel → matching lines highlight or scroll into view in the editor. Continuous scroll sync in both directions.
- **Bidirectional edit (per-workspace opt-in).** Click the ✎ pencil on any English bullet (or double-click the bullet) → edit the English in a textarea → Cmd/Ctrl+Enter → Claude generates a code change → diff editor shows original ↔ proposed → confirm Apply, or close to discard. Refuses low-confidence changes; surfaces warnings about undefined references.
- **First-run walkthrough.** Three-step onboarding via VS Code's Walkthrough API: set API key → pick a default mode → try it on a real file.
- **Diagnostics.** `CodeLumeAI: Show Logs` opens a dedicated Output channel with timestamped entries for every translation request, error, and panel interaction.
- **Coverage check.** After every translation, the extension warns in the log if the model skipped any non-blank source lines, with the missing line ranges and a suggestion to re-translate or switch to `claude-sonnet-4-6`.

### Configuration

- `codelumeai.mode` — `off` | `hover` (default) | `always-on`
- `codelumeai.model` — `claude-haiku-4-5` (default) or `claude-sonnet-4-6`
- `codelumeai.maxFileLines` — skip files larger than this (default `2000`)
- `codelumeai.editEnabled` — opt-in for bidirectional edit (default `false`, scope `resource`)

### Privacy

CodeLumeAI sends source code to Anthropic's API to generate translations and code changes. The Anthropic API key is stored in VS Code's `SecretStorage` — never written to `settings.json`, never logged, never committed. Bring your own key.

### Companion Claude Code plugin

A separate `@codelumeai/claude-plugin` adds `/codelumeai:translate`, `/codelumeai:summary`, `/codelumeai:edit`, `/codelumeai:explain`, and `/codelumeai:update` slash commands to any Claude Code surface (CLI, VS Code, JetBrains, desktop, web).

[Unreleased]: https://github.com/Nicolas4485/codelumeai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nicolas4485/codelumeai/releases/tag/v0.1.0
