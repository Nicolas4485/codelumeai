import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TranslationError } from "./translator";

// ── Schemas ──────────────────────────────────────────────────────────────────

const KeyConceptSchema = z
  .object({
    name: z.string(),
    what: z.string(),
    why: z.string(),
    file: z.string(),
    line: z.number().int().min(1).default(1),
  })
  .passthrough();

export const BriefingSchema = z
  .object({
    headline: z.string(),
    overview: z.string(),
    keyConcepts: z.array(KeyConceptSchema).min(1).max(6),
    architecture: z.string(),
    startHere: z.object({
      file: z.string(),
      line: z.number().int().min(1).default(1),
      reason: z.string(),
    }),
  })
  .passthrough();

export type Briefing = z.infer<typeof BriefingSchema>;
export type KeyConcept = z.infer<typeof KeyConceptSchema>;

const BRIEFING_TOOL_NAME = "submit_briefing";

const BRIEFING_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["headline", "overview", "keyConcepts", "architecture", "startHere"],
  properties: {
    headline: {
      type: "string",
      description: "One sentence. What does this software DO? (not what it is called)",
    },
    overview: {
      type: "string",
      description: "2-3 sentences expanding the headline. Name the main components.",
    },
    keyConcepts: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      description: "The 5 things a new dev must understand before touching the code.",
      items: {
        type: "object",
        required: ["name", "what", "why", "file", "line"],
        properties: {
          name: { type: "string", description: "The exact identifier from the codebase." },
          what: { type: "string", description: "One plain-English sentence — what IS this thing?" },
          why: { type: "string", description: "One sentence — why must a new dev know this first?" },
          file: { type: "string", description: "The file path where this is defined." },
          line: { type: "integer", minimum: 1, description: "Starting line number." },
        },
      },
    },
    architecture: {
      type: "string",
      description: "2-3 sentences. Use verbs like 'calls', 'depends on', 'transforms'. Mention actual file names.",
    },
    startHere: {
      type: "object",
      required: ["file", "line", "reason"],
      description: "The single best file for a new dev to open first.",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "One sentence — why is this the best starting point?" },
      },
    },
  },
} as const;

// ── System prompt ─────────────────────────────────────────────────────────────

const BRIEFING_SYSTEM_PROMPT = `You are a senior engineer writing a briefing document for a developer who just joined the team and is seeing this codebase for the first time. Your goal: get them oriented in 5 minutes.

Use the codebase data in the user message to generate an accurate, specific briefing using the ${BRIEFING_TOOL_NAME} tool.

# RULES

- Be specific. Always reference real symbol names, real file names, and real patterns from the data provided.
- Do NOT be generic. A briefing that could apply to any codebase is useless.
- headline: what the software DOES, not what it is called. "Manages a team's bug tracker" not "A project management system".
- keyConcepts: pick the symbols with the highest cross-file ref counts — those are the things everything else builds on.
- architecture: describe the FLOW. What produces what? What calls what? Use verbs.
- startHere: must be a real file from the foundations tier (high incomingRefs). Prefer a data-model or core-logic file over a utility or config file.`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TopSymbolInput {
  name: string;
  kind: string;
  file: string;
  startLine: number;
  totalRefs: number;
}

export interface FileStructureInput {
  foundations: string[];
  features: string[];
  entryPoints: string[];
}

export interface TranslationSummary {
  file: string;
  /** The summary field from the top chunk of the file's translation. */
  summary: string;
}

export interface GenerateBriefingOptions {
  apiKey: string;
  workspaceName: string;
  topSymbols: TopSymbolInput[];
  fileStructure: FileStructureInput;
  translationSummaries: TranslationSummary[];
  model?: string;
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function generateBriefing(opts: GenerateBriefingOptions): Promise<Briefing> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const symbolLines = opts.topSymbols
    .map((s) => `  - ${s.kind} \`${s.name}\` in ${s.file}:${s.startLine} (used by ${s.totalRefs} other file${s.totalRefs === 1 ? "" : "s"})`)
    .join("\n");

  const translationLines =
    opts.translationSummaries.length > 0
      ? opts.translationSummaries
          .map((t) => `  **${t.file}:** ${t.summary}`)
          .join("\n\n  ")
      : "  (no translations available yet — infer from symbol names and structure)";

  const userMessage = [
    `Workspace: ${opts.workspaceName}`,
    "",
    `Most cross-referenced symbols (descending by usage):`,
    symbolLines || "  (none — workspace may not be fully indexed)",
    "",
    `File structure:`,
    `  Foundations (many files depend on these): ${opts.fileStructure.foundations.slice(0, 8).join(", ") || "none identified"}`,
    `  Features (main logic): ${opts.fileStructure.features.slice(0, 8).join(", ") || "none identified"}`,
    `  Entry points (nothing imports these): ${opts.fileStructure.entryPoints.slice(0, 6).join(", ") || "none identified"}`,
    "",
    `Plain-English summaries of key files:`,
    translationLines,
  ].join("\n");

  let response;
  try {
    const stream = client.messages.stream({
      model: opts.model ?? "claude-haiku-4-5",
      max_tokens: 2048,
      system: BRIEFING_SYSTEM_PROMPT,
      tools: [
        {
          name: BRIEFING_TOOL_NAME,
          description: "Submit the new developer briefing. Call this tool exactly once.",
          input_schema: BRIEFING_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: BRIEFING_TOOL_NAME },
      messages: [{ role: "user", content: userMessage }],
    });
    response = await stream.finalMessage();
  } catch (err) {
    throw new TranslationError(
      `Briefing generation failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new TranslationError("Model did not return a briefing tool_use block.");
  }

  const parsed = BriefingSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 2)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new TranslationError(`Briefing schema validation failed — ${issues}`, parsed.error);
  }

  return parsed.data;
}
