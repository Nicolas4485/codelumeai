import { describe, it, expect, vi, beforeEach } from "vitest";
import { translate, englishToCode, TranslationError } from "./translator";

type StreamParams = {
  model?: string;
  max_tokens?: number;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  [key: string]: unknown;
};

const mockFinalMessage = vi.fn();
const mockStream = vi.fn<(p: StreamParams) => { finalMessage: typeof mockFinalMessage }>(
  () => ({ finalMessage: mockFinalMessage }),
);

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { stream: mockStream },
    })),
  };
});

const validToolInput = {
  primer: "## Notes\n- Class is a template.",
  chunks: [
    {
      startLine: 1,
      endLine: 3,
      title: "Imports",
      summary: "Load the os module and time.",
      lines: [
        { startLine: 1, endLine: 1, english: "Bring in os." },
        { startLine: 2, endLine: 2, english: "Bring in time." },
      ],
      confidence: "high" as const,
    },
  ],
};

describe("translate", () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockStream.mockClear();
  });

  it("returns the parsed translation on a clean tool_use response", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });

    const result = await translate({
      apiKey: "sk-test",
      source: "import os\nimport time\n",
      language: "python",
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.title).toBe("Imports");
  });

  it("throws TranslationError when stop_reason is max_tokens", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "text", text: "..." }],
      stop_reason: "max_tokens",
    });

    await expect(
      translate({
        apiKey: "sk-test",
        source: "x",
        language: "python",
      }),
    ).rejects.toThrow(TranslationError);
  });

  it("throws TranslationError when no tool_use block is returned", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "text", text: "I refuse" }],
      stop_reason: "end_turn",
    });

    await expect(
      translate({
        apiKey: "sk-test",
        source: "x",
        language: "python",
      }),
    ).rejects.toThrow(TranslationError);
  });

  it("throws TranslationError with a readable path on schema mismatch", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [
        { type: "tool_use", input: { primer: "..." /* chunks missing */ } },
      ],
      stop_reason: "end_turn",
    });

    await expect(
      translate({
        apiKey: "sk-test",
        source: "x",
        language: "python",
      }),
    ).rejects.toThrowError(/chunks/);
  });

  it("wraps SDK errors in TranslationError", async () => {
    mockFinalMessage.mockRejectedValue(new Error("network down"));

    await expect(
      translate({
        apiKey: "sk-test",
        source: "x",
        language: "python",
      }),
    ).rejects.toThrowError(/network down/);
  });

  it("passes the chosen model and max_tokens through to the SDK", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });

    await translate({
      apiKey: "sk-test",
      source: "x",
      language: "python",
      model: "claude-sonnet-4-6",
      maxTokens: 8192,
    });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
      }),
    );
  });

  it("prefixes source lines with 1-indexed line numbers", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });

    await translate({
      apiKey: "sk-test",
      source: "alpha\nbeta",
      language: "python",
    });

    const content = mockStream.mock.calls[0]?.[0]?.messages[0]?.content;
    expect(content).toContain("   1: alpha");
    expect(content).toContain("   2: beta");
  });
});

describe("englishToCode", () => {
  const baseOpts = {
    apiKey: "sk-test",
    source: "def foo():\n    return 0\n",
    language: "python",
    startLine: 2,
    endLine: 2,
    originalEnglish: "Return zero.",
    newEnglish: "Return one instead.",
  };

  const validToolInput = {
    startLine: 2,
    endLine: 2,
    newCode: "    return 1",
    confidence: "high" as const,
  };

  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockStream.mockClear();
  });

  it("returns the parsed change on a clean tool_use response", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });
    const change = await englishToCode(baseOpts);
    expect(change.newCode).toBe("    return 1");
    expect(change.confidence).toBe("high");
    expect(change.startLine).toBe(2);
  });

  it("preserves optional warnings array", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          input: {
            ...validToolInput,
            confidence: "medium",
            note: "Style is mixed.",
            warnings: ["EmptyInputError is not defined or imported"],
          },
        },
      ],
      stop_reason: "end_turn",
    });
    const change = await englishToCode(baseOpts);
    expect(change.warnings).toEqual([
      "EmptyInputError is not defined or imported",
    ]);
    expect(change.note).toBe("Style is mixed.");
  });

  it("transforms null note/warnings to undefined (LLM null-quirk)", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          input: { ...validToolInput, note: null, warnings: null },
        },
      ],
      stop_reason: "end_turn",
    });
    const change = await englishToCode(baseOpts);
    expect(change.note).toBeUndefined();
    expect(change.warnings).toBeUndefined();
  });

  it("throws TranslationError when stop_reason is max_tokens", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "text", text: "..." }],
      stop_reason: "max_tokens",
    });
    await expect(englishToCode(baseOpts)).rejects.toThrow(TranslationError);
  });

  it("throws TranslationError when no tool_use block is returned", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "text", text: "I refuse" }],
      stop_reason: "end_turn",
    });
    await expect(englishToCode(baseOpts)).rejects.toThrow(TranslationError);
  });

  it("wraps SDK errors in TranslationError", async () => {
    mockFinalMessage.mockRejectedValue(new Error("rate limit"));
    await expect(englishToCode(baseOpts)).rejects.toThrowError(/rate limit/);
  });

  it("uses ENGLISH_TO_CODE_SYSTEM_PROMPT and submit_code_change tool", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });
    await englishToCode(baseOpts);
    const call = mockStream.mock.calls[0]?.[0];
    expect(call?.system).toContain("English-to-code engine");
    // Tools include submit_code_change with the right tool_choice.
    const tools = (call as unknown as { tools?: Array<{ name: string }> })
      ?.tools;
    expect(tools?.[0]?.name).toBe("submit_code_change");
  });

  it("includes range, original English, new English, and numbered source in user message", async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: "tool_use", input: validToolInput }],
      stop_reason: "end_turn",
    });
    await englishToCode(baseOpts);
    const content = mockStream.mock.calls[0]?.[0]?.messages[0]?.content ?? "";
    expect(content).toContain("Range to replace: lines 2 to 2");
    expect(content).toContain("Return zero.");
    expect(content).toContain("Return one instead.");
    expect(content).toContain("   1: def foo():");
    expect(content).toContain("   2:     return 0");
  });
});
