import Anthropic from "@anthropic-ai/sdk";
import { TranslationError } from "./translator";
import type { Briefing, TopSymbolInput, FileStructureInput, TranslationSummary } from "./briefing";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatWithCodebaseOptions {
  apiKey: string;
  model?: string;
  workspaceName: string;
  briefing: Briefing | undefined;
  topSymbols: TopSymbolInput[];
  fileStructure: FileStructureInput;
  translationSummaries: TranslationSummary[];
  messages: ChatMessage[];
}

function buildSystemPrompt(opts: Omit<ChatWithCodebaseOptions, "apiKey" | "model" | "messages">): string {
  const { workspaceName, briefing, topSymbols, fileStructure, translationSummaries } = opts;

  const briefingSection = briefing
    ? [
        `## What this codebase does`,
        briefing.headline,
        briefing.overview,
        ``,
        `## Architecture`,
        briefing.architecture,
        ``,
        `## Key concepts`,
        briefing.keyConcepts
          .map((c) => `- \`${c.name}\` (${c.file}:${c.line}): ${c.what}`)
          .join("\n"),
      ].join("\n")
    : `## Workspace\n${workspaceName}`;

  const symbolSection =
    topSymbols.length > 0
      ? [
          `## Most-referenced symbols`,
          topSymbols
            .slice(0, 12)
            .map((s) => `- ${s.kind} \`${s.name}\` in ${s.file} (used by ${s.totalRefs} files)`)
            .join("\n"),
        ].join("\n")
      : "";

  const structureSection = [
    `## File structure`,
    fileStructure.foundations.length > 0
      ? `Foundations: ${fileStructure.foundations.slice(0, 6).join(", ")}`
      : "",
    fileStructure.entryPoints.length > 0
      ? `Entry points: ${fileStructure.entryPoints.slice(0, 4).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const translationSection =
    translationSummaries.length > 0
      ? [
          `## File summaries`,
          translationSummaries
            .map((t) => `**${t.file}:** ${t.summary}`)
            .join("\n\n"),
        ].join("\n")
      : "";

  return [
    `You are a codebase guide for "${workspaceName}". You have detailed knowledge of this codebase's structure, purpose, and design.`,
    ``,
    briefingSection,
    symbolSection,
    structureSection,
    translationSection,
    ``,
    `## How to answer`,
    `- Answer specifically about this codebase. Reference real file names, symbol names, and line numbers when you know them.`,
    `- Be concise. Developers want the answer, not a lecture.`,
    `- If a question asks about code flow, trace it through the actual files in this codebase.`,
    `- If you don't know something with confidence, say so. Don't invent behaviour.`,
    `- When suggesting where to look or make a change, name the specific file.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function chatWithCodebase(opts: ChatWithCodebaseOptions): Promise<string> {
  if (opts.messages.length === 0) {
    throw new TranslationError("No messages provided to chatWithCodebase.");
  }

  const client = new Anthropic({ apiKey: opts.apiKey });
  const system = buildSystemPrompt(opts);

  let response;
  try {
    response = await client.messages.create({
      model: opts.model ?? "claude-haiku-4-5",
      max_tokens: 1024,
      system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (err) {
    throw new TranslationError(
      `Chat request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new TranslationError("Model returned no text content in chat response.");
  }

  return textBlock.text;
}
