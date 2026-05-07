---
description: Refresh the .codelumeai.md companion file after the source changed. Re-translates only the chunks whose content changed, preserving any chunks the user manually edited. Use this after /codelumeai:edit or any other code change.
---

# CodeLumeAI — Update

Keep the `.codelumeai.md` companion in sync with the source, cheaply.

## Your task

1. Resolve the target file from `$ARGUMENTS` (or current file).
2. Read the existing `.codelumeai.md` companion.
   - If none exists, redirect the user to `/codelumeai:translate <file>` and stop.
3. Re-chunk the current source using the same semantic-unit rules as `/codelumeai:translate`.
4. For each chunk, compare with the companion's record:
   - **Unchanged** (same line range, same code) → keep the existing English exactly as-is.
   - **Changed** (same chunk, different code) → re-translate using Faithful mode rules.
   - **New** (no matching chunk in companion) → translate.
   - **Removed** (companion chunk no longer in source) → drop from companion.
5. Write the updated companion file.
6. Report:
   _"Updated `<file>.codelumeai.md`: {N} chunks updated, {M} new, {K} removed."_

## Style rules

Same as `/codelumeai:translate` for any chunk you re-translate. This is a delta update, not a re-translate of the whole file.

## Preserve manual edits

If a chunk is **unchanged in the source** but the English in the companion differs from what `/codelumeai:translate` would produce now (e.g. the user edited it in the side panel), **keep the user's English**. Do not overwrite manual edits during an update.

This is the rule that makes update safe to run frequently.

## When to suggest update

- Right after `/codelumeai:edit` applies a change — suggest update in the same reply.
- When the user says _"the code changed, update the English"_.
- When the user opens a file with an out-of-date companion (timestamps don't match).

## Anti-patterns

- ❌ Do not re-translate unchanged chunks. The point of update is cheap and stable.
- ❌ Do not lose the user's manual edits to the companion. Manual edits to chunks whose source is unchanged are sacred.
- ❌ Do not run on multiple files in parallel from a single invocation. One file at a time, report per-file.
