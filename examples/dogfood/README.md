# Dogfood examples

Real-world translations produced by following the `/codelumeai:translate` SKILL.md against actual code from the user's other projects. Used during Phase 0 to validate prompt quality before any TypeScript is written.

Each `*.codelumeai.md` here is the output of running the Faithful-mode prompt against the corresponding `*.py` source. Source files are not included — only the translation.

| File | Source | Lines (source) | Notes |
|---|---|---|---|
| `memory.py.codelumeai.md` | `Chris-ai/core/memory.py` | 245 | Triple-based memory store. Tests imports, dataclass, properties, backward-compat aliases, fuzzy match, two-format JSON persistence. |
