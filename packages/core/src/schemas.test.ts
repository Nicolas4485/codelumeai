import { describe, it, expect } from "vitest";
import {
  ChunkSchema,
  LineEntrySchema,
  TranslationSchema,
  ConfidenceSchema,
} from "./schemas";

describe("ConfidenceSchema", () => {
  it("accepts the three valid values", () => {
    expect(ConfidenceSchema.parse("high")).toBe("high");
    expect(ConfidenceSchema.parse("medium")).toBe("medium");
    expect(ConfidenceSchema.parse("low")).toBe("low");
  });

  it("rejects unknown values", () => {
    expect(ConfidenceSchema.safeParse("very-high").success).toBe(false);
    expect(ConfidenceSchema.safeParse("").success).toBe(false);
  });
});

describe("LineEntrySchema", () => {
  it("accepts a minimal valid entry", () => {
    const entry = LineEntrySchema.parse({
      startLine: 1,
      endLine: 1,
      english: "Bring in the os module.",
    });
    expect(entry.startLine).toBe(1);
  });

  it("rejects startLine of 0", () => {
    expect(
      LineEntrySchema.safeParse({
        startLine: 0,
        endLine: 1,
        english: "x",
      }).success,
    ).toBe(false);
  });

  it("strips extra fields via passthrough but does not error", () => {
    const result = LineEntrySchema.safeParse({
      startLine: 5,
      endLine: 5,
      english: "x",
      extraNonsense: "should-not-fail",
    });
    expect(result.success).toBe(true);
  });
});

describe("ChunkSchema", () => {
  const validChunk = {
    startLine: 1,
    endLine: 5,
    title: "Imports",
    summary: "Load the tools we need.",
    lines: [{ startLine: 1, endLine: 1, english: "Import os." }],
    confidence: "high" as const,
  };

  it("accepts a minimal valid chunk", () => {
    expect(ChunkSchema.safeParse(validChunk).success).toBe(true);
  });

  it("accepts note as a string", () => {
    expect(
      ChunkSchema.safeParse({ ...validChunk, note: "warning" }).success,
    ).toBe(true);
  });

  it("accepts note as null and transforms to undefined", () => {
    const parsed = ChunkSchema.parse({ ...validChunk, note: null });
    expect(parsed.note).toBeUndefined();
  });

  it("accepts note as missing entirely", () => {
    const { ...withoutNote } = validChunk;
    expect(ChunkSchema.parse(withoutNote).note).toBeUndefined();
  });

  it("rejects an invalid confidence value", () => {
    expect(
      ChunkSchema.safeParse({ ...validChunk, confidence: "very-high" })
        .success,
    ).toBe(false);
  });

  it("rejects when chunks startLine < 1", () => {
    expect(
      ChunkSchema.safeParse({ ...validChunk, startLine: 0 }).success,
    ).toBe(false);
  });
});

describe("TranslationSchema", () => {
  it("accepts a minimal valid translation", () => {
    const result = TranslationSchema.parse({
      primer: "## Notes\n- Class is a template.",
      chunks: [
        {
          startLine: 1,
          endLine: 1,
          title: "Imports",
          summary: "Load the os module.",
          lines: [
            { startLine: 1, endLine: 1, english: "Bring in os." },
          ],
          confidence: "high",
        },
      ],
    });
    expect(result.chunks).toHaveLength(1);
  });

  it("rejects when chunks is missing entirely", () => {
    expect(
      TranslationSchema.safeParse({ primer: "..." }).success,
    ).toBe(false);
  });

  it("accepts an empty chunks array", () => {
    expect(
      TranslationSchema.parse({ primer: "x", chunks: [] }).chunks,
    ).toEqual([]);
  });
});
