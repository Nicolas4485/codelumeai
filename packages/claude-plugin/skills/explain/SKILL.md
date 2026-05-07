---
description: Deep-dive explanation of a function, class, or line range — more thorough than translate. Use this when the user is stuck on a section and wants to understand it, not just read it.
---

# CodeLumeAI — Explain

When `/codelumeai:translate` is not enough and the user wants to *understand* a section, not just read it word-for-word.

## Your task

Parse `$ARGUMENTS` for:

- A file path
- A target: function name, class name, or line range like `42-58`

Then produce an explanation in this exact structure:

```markdown
# Explaining `<target>` in `<file>`

## What it does (one sentence)
{plain-English summary, max 25 words}

## Step by step
1. {what happens first}
2. {what happens next}
…

## Why it is written this way
{the intent — what problem the author was solving, what alternative approaches were possible, why this one was chosen}

## What it depends on
- {imports, external functions, globals, env vars it relies on}

## What can go wrong
- {edge cases, errors, surprising behaviors, race conditions}

## Plain-English equivalent
{a paragraph rewriting the function's behavior in conversational English, as if explaining over coffee}
```

## Style rules

- **Treat the reader as a smart non-engineer.** Translate every concept; assume nothing.
- **Prefer concrete examples.** _"If `text` is `'hello world'`, this becomes `['hello', 'world']`."_
- **Surface non-obvious assumptions.** _"This assumes the API key is set. If not, line 12 raises `KeyError`."_
- **400 words total, max.** This is a deep dive, not a textbook.

## Anti-patterns

- ❌ Do not just paraphrase the code — explain *why* it is shaped this way.
- ❌ Do not switch into code-review mode ("could be simplified by..."). That is not the ask.
- ❌ Do not exceed 400 words.
- ❌ Do not write a translation — that is `/codelumeai:translate`. Explain, don't translate.
