export { translate, TranslationError } from "./translator";
export type { TranslateOptions, TranslationMode } from "./translator";

export { MemoryCache, hashContent } from "./cache";
export type { Cache, CacheEntry } from "./cache";

export {
  TranslationSchema,
  ChunkSchema,
  ConfidenceSchema,
  TRANSLATION_TOOL_INPUT_SCHEMA,
} from "./schemas";
export type { Translation, Chunk, Confidence } from "./schemas";

export {
  FAITHFUL_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
} from "./prompts";

export const VERSION = "0.0.0";
