import { z } from "zod";

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Schemas are intentionally permissive: LLMs frequently return null for optional
// fields, occasionally add an extra field, and produce empty strings instead of
// omitting. We strip surprises with .passthrough() and accept null/empty where
// safe — the alternative is users seeing a hard error for a translation we
// could have rendered fine.
export const LineEntrySchema = z
  .object({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    english: z.string(),
  })
  .passthrough();
export type LineEntry = z.infer<typeof LineEntrySchema>;

export const ChunkSchema = z
  .object({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    title: z.string(),
    summary: z.string(),
    lines: z.array(LineEntrySchema),
    confidence: ConfidenceSchema,
    note: z.string().nullable().optional().transform((v) => v ?? undefined),
  })
  .passthrough();
export type Chunk = z.infer<typeof ChunkSchema>;

export const TranslationSchema = z
  .object({
    primer: z.string(),
    chunks: z.array(ChunkSchema),
  })
  .passthrough();
export type Translation = z.infer<typeof TranslationSchema>;

export const TRANSLATION_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["primer", "chunks"],
  properties: {
    primer: {
      type: "string",
      description:
        "Markdown bullets explaining the syntactic constructs in this file's language. 3-8 bullets. Skip constructs a layperson knows from English.",
    },
    chunks: {
      type: "array",
      items: {
        type: "object",
        required: [
          "startLine",
          "endLine",
          "title",
          "summary",
          "lines",
          "confidence",
        ],
        properties: {
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          title: { type: "string", description: "3-6 word section header." },
          summary: {
            type: "string",
            description:
              "1-2 sentence plain-English overview of the chunk. Shown first, before line-by-line detail.",
          },
          lines: {
            type: "array",
            description:
              "Per-line (or per-multi-line-statement) translations. Skip pure-boilerplate lines like blank lines or solo closing braces.",
            items: {
              type: "object",
              required: ["startLine", "endLine", "english"],
              properties: {
                startLine: { type: "integer", minimum: 1 },
                endLine: { type: "integer", minimum: 1 },
                english: {
                  type: "string",
                  description: "Translation for this line range. 15 words max.",
                },
              },
            },
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          note: { type: "string" },
        },
      },
    },
  },
} as const;
