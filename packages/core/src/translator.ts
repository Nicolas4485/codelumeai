import Anthropic from "@anthropic-ai/sdk";
import { FAITHFUL_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from "./prompts";
import {
  TRANSLATION_TOOL_INPUT_SCHEMA,
  TranslationSchema,
  type Translation,
} from "./schemas";

const TOOL_NAME = "submit_translation";

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
const DEFAULT_MAX_TOKENS = 4096;

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

  const userMessage = [
    `Language: ${opts.language}`,
    `File: ${opts.filename ?? "(unnamed)"}`,
    "",
    "Source:",
    "```" + opts.language,
    opts.source,
    "```",
  ].join("\n");

  let response;
  try {
    response = await client.messages.create({
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
  } catch (err) {
    throw new TranslationError(
      `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new TranslationError(
      "Model did not return a tool_use block. Response was: " +
        JSON.stringify(response.content).slice(0, 200),
    );
  }

  const parsed = TranslationSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new TranslationError(
      `Model output failed schema validation: ${parsed.error.message}`,
      parsed.error,
    );
  }

  return parsed.data;
}
