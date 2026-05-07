# CodeLumeAI

Read your code in plain English. Edit your code by editing the English.

CodeLumeAI is a bidirectional translator between source code and plain English. It ships as:

- **A Claude Code plugin** — works in Claude Code CLI, the VS Code Claude extension, the Claude desktop app, JetBrains, and claude.ai/code. Install once, use anywhere.
- **A VS Code extension** — adds in-editor inline hints, a synced English side panel, and a safe diff-preview for editing code by editing its English description.

## Status

Pre-release. Currently building Phase 0 (Claude Code plugin) and Phase 1 (VS Code extension MVP, hover mode).

## Repository layout

```
packages/
├── core/              shared translation logic (no VS Code deps)
├── vscode-extension/  the .vsix
└── claude-plugin/     the SKILL.md plugin

apps/
└── landing/           Next.js marketing site
```

## Development

Requires Node.js 18+, pnpm 10+. Set `ANTHROPIC_API_KEY` in your environment before running.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## License

MIT — see [LICENSE](LICENSE).
