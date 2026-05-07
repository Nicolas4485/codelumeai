# @codelumeai/claude-plugin

The CodeLumeAI Claude Code plugin. Adds the `/codelumeai:*` family of slash commands to any Claude Code surface — CLI, the VS Code Claude extension, JetBrains, the desktop apps, and `claude.ai/code`.

## Skills (slash commands)

| Command | What it does |
|---|---|
| `/codelumeai:translate <file>` | Faithful mode: 1:1 chunk-to-code mapping. Writes `<file>.codelumeai.md`. Safe to round-trip via `/codelumeai:edit`. |
| `/codelumeai:summary <file>` | Summary mode: short narrative grouped by intent. Writes `<file>.codelumeai.summary.md`. **Read-only** — lossy by design. |
| `/codelumeai:edit <instruction>` | English → code. Reads the companion, identifies the target chunk, proposes the change with a diff before applying. |
| `/codelumeai:explain <file> <target>` | Deep-dive explanation of a function, class, or line range. Goes further than translate. |
| `/codelumeai:update <file>` | Refresh the companion after the source changed. Preserves manual edits to chunks whose source is unchanged. |

## Install (local development)

From the repo root:

```bash
claude --plugin-dir ./packages/claude-plugin
```

Once Claude Code is running, the `/codelumeai:*` commands are available. After editing a SKILL.md, run `/reload-plugins` inside Claude Code to pick up changes without restarting.

## Try it on a real file

```
/codelumeai:translate path/to/your/file.py
```

The plugin will write `path/to/your/file.py.codelumeai.md` next to the source. Open both side by side and read the English alongside the code.

## Layout

```
.claude-plugin/
└── plugin.json          plugin manifest (name, version, author)

skills/
├── translate/SKILL.md   /codelumeai:translate
├── summary/SKILL.md     /codelumeai:summary
├── edit/SKILL.md        /codelumeai:edit
├── explain/SKILL.md     /codelumeai:explain
└── update/SKILL.md      /codelumeai:update
```

The prompts live inline inside each `SKILL.md`. They are intentionally identical (in spirit) to the system prompts the VS Code extension's `@codelumeai/core` package will use — single source of truth for translation behavior across both surfaces.
