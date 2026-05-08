# Try it on a real file

Open any code file in a supported language: **Python, JavaScript, TypeScript, Go, Rust, Java, C#, Ruby, PHP, HTML, CSS**.

## What happens

1. Move your mouse over a function or class
2. Wait ~5–10 seconds — the first hover translates the whole file
3. A tooltip appears with **two sections**:
   - **Top**: what _this specific line_ does
   - **Bottom**: the surrounding chunk's title, summary, and per-line bullets

Subsequent hovers in the same file are instant — translations are cached until you save the file.

## Confidence pills

Each chunk shows a confidence indicator:
- `✓ high` — literal translation, safe to round-trip in a future edit
- `~ medium` — summary; some interpretation; warning included
- `? low` — refused round-trip; direct code edits recommended

## Cost

Each first-translation of a file is one Anthropic API call. By default we use `claude-haiku-4-5`, the fastest and cheapest model. You can switch to Sonnet in settings if you want higher quality.
