export { translate, englishToCode, TranslationError } from "./translator";
export type {
  TranslateOptions,
  TranslationMode,
  EnglishToCodeOptions,
} from "./translator";

export { MemoryCache, hashContent } from "./cache";
export type { Cache, CacheEntry } from "./cache";

export {
  TranslationSchema,
  ChunkSchema,
  LineEntrySchema,
  ConfidenceSchema,
  CodeChangeSchema,
  TRANSLATION_TOOL_INPUT_SCHEMA,
  CODE_CHANGE_TOOL_INPUT_SCHEMA,
} from "./schemas";
export type {
  Translation,
  Chunk,
  LineEntry,
  Confidence,
  CodeChange,
} from "./schemas";

export {
  FAITHFUL_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  ENGLISH_TO_CODE_SYSTEM_PROMPT,
} from "./prompts";

export { generateBriefing, BriefingSchema } from "./briefing";
export type {
  Briefing,
  KeyConcept,
  TopSymbolInput,
  FileStructureInput,
  TranslationSummary,
  GenerateBriefingOptions,
} from "./briefing";

export { chatWithCodebase } from "./chat";
export type { ChatMessage, ChatWithCodebaseOptions } from "./chat";

export const VERSION = "0.0.0";
