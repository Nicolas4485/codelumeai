import Anthropic from "@anthropic-ai/sdk";
import {
  ENGLISH_TO_CODE_SYSTEM_PROMPT,
  FAITHFUL_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
} from "./prompts";
import {
  CODE_CHANGE_TOOL_INPUT_SCHEMA,
  CodeChangeSchema,
  TRANSLATION_TOOL_INPUT_SCHEMA,
  TranslationSchema,
  type CodeChange,
  type Translation,
} from "./schemas";

const TOOL_NAME = "submit_translation";
const CODE_CHANGE_TOOL_NAME = "submit_code_change";

export type TranslationMode = "faithful" | "summary";

export interface TranslateOptions {
  apiKey: string;
  source: string;
  language: string;
  filename?: string;
  model?: string;
  maxTokens?: number;
  mode?: TranslationMode;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
// Faithful translations include a primer + chunks * (summary + per-line bullets).
// A 250-line file with rich per-declaration breakdown can easily exceed 16K.
// Claude Haiku 4.5 supports up to 64K output tokens, so we set a generous
// 32K default — well below the model cap, well above what most files need.
const DEFAULT_MAX_TOKENS = 32768;

export class TranslationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TranslationError";
  }
}

/**
 * Translate a source file to plain English via Anthropic's API.
 *
 * Uses tool_use with a forced tool choice so the model output is guaranteed
 * to match TRANSLATION_TOOL_INPUT_SCHEMA. The result is then validated with
 * Zod before returning, defending against schema drift.
 */
export async function translate(opts: TranslateOptions): Promise<Translation> {
  const mode: TranslationMode = opts.mode ?? "faithful";
  const system =
    mode === "summary" ? SUMMARY_SYSTEM_PROMPT : FAITHFUL_SYSTEM_PROMPT;

  const client = new Anthropic({ apiKey: opts.apiKey });

  const numberedSource = opts.source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}: ${line}`)
    .join("\n");

  const userMessage = [
    `Language: ${opts.language}`,
    `File: ${opts.filename ?? "(unnamed)"}`,
    "",
    "Source (each line is prefixed with its 1-indexed line number followed by `: `):",
    "```",
    numberedSource,
    "```",
  ].join("\n");

  // Use streaming (.stream + .finalMessage) instead of .create. With our 32K
  // max_tokens budget, the API rejects non-streaming requests as the worst-case
  // generation could exceed 10 minutes. Streaming bypasses that restriction;
  // the response shape from finalMessage() is identical to .create's return.
  let response;
  try {
    const stream = client.messages.stream({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Submit the translation for the provided source file. Always call this tool exactly once.",
          input_schema: TRANSLATION_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: userMessage }],
    });
    response = await stream.finalMessage();
  } catch (err) {
    throw new TranslationError(
      `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new TranslationError(
      "Model hit the max_tokens limit before finishing the translation. " +
        "Try a smaller file, or raise the maxTokens option in core.translate().",
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new TranslationError(
      `Model did not return a tool_use block (stop_reason=${String(response.stop_reason)}). ` +
        `Response: ${JSON.stringify(response.content).slice(0, 200)}`,
    );
  }

  const parsed = TranslationSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    // Surface the first 2 issues compactly; full details go via cause for logging.
    const issues = parsed.error.issues
      .slice(0, 2)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    const more =
      parsed.error.issues.length > 2
        ? ` (+${String(parsed.error.issues.length - 2)} more)`
        : "";
    // Include stop_reason and the keys actually present so we know WHY chunks
    // is missing — was the response truncated, or did the model just skip it?
    const presentKeys =
      toolUse.input && typeof toolUse.input === "object"
        ? Object.keys(toolUse.input).join(",")
        : "(none)";
    throw new TranslationError(
      `Model output failed schema validation — ${issues}${more} ` +
        `[stop_reason=${String(response.stop_reason)}, keys_present=${presentKeys}]`,
      parsed.error,
    );
  }

  return parsed.data;
}

// ============================================================
// English → Code
// ============================================================

export interface EnglishToCodeOptions {
  apiKey: string;
  source: string;
  language: string;
  filename?: string;
  /** 1-indexed inclusive line range to replace. */
  startLine: number;
  /** 1-indexed inclusive line range to replace. */
  endLine: number;
  /** The English that was previously generated for this range. */
  originalEnglish: string;
  /** The user's edited English — what they now want this range to do. */
  newEnglish: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_CODE_CHANGE_MAX_TOKENS = 8192;

/**
 * Translate a user's edited English instruction back into source code that
 * replaces a specific line range. Used by the side panel's edit flow:
 * user changes the English, we generate a code change, the extension
 * shows it as a diff for the user to confirm.
 */
export async function englishToCode(
  opts: EnglishToCodeOptions,
): Promise<CodeChange> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const numberedSource = opts.source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}: ${line}`)
    .join("\n");

  const userMessage = [
    `Language: ${opts.language}`,
    `File: ${opts.filename ?? "(unnamed)"}`,
    `Range to replace: lines ${String(opts.startLine)} to ${String(opts.endLine)} (1-indexed, inclusive).`,
    "",
    "Original English (what was generated for this range before):",
    "```",
    opts.originalEnglish,
    "```",
    "",
    "User's edited English (what they want this range to do now):",
    "```",
    opts.newEnglish,
    "```",
    "",
    "Source (each line prefixed with its 1-indexed line number followed by `: `):",
    "```",
    numberedSource,
    "```",
  ].join("\n");

  let response;
  try {
    const stream = client.messages.stream({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_CODE_CHANGE_MAX_TOKENS,
      system: ENGLISH_TO_CODE_SYSTEM_PROMPT,
      tools: [
        {
          name: CODE_CHANGE_TOOL_NAME,
          description:
            "Submit the proposed code change for the given line range. Always call this tool exactly once.",
          input_schema:
            CODE_CHANGE_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: CODE_CHANGE_TOOL_NAME },
      messages: [{ role: "user", content: userMessage }],
    });
    response = await stream.finalMessage();
  } catch (err) {
    throw new TranslationError(
      `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new TranslationError(
      "Model hit max_tokens before finishing the change. Try a shorter instruction.",
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new TranslationError(
      `Model did not return a tool_use block (stop_reason=${String(response.stop_reason)}).`,
    );
  }

  const parsed = CodeChangeSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 2)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new TranslationError(
      `Model output failed schema validation — ${issues}`,
      parsed.error,
    );
  }

  return parsed.data;
}
