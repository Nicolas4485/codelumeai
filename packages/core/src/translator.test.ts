import { describe, it, expect, vi, beforeEach } from "vitest";
import { translate, TranslationError } from "./translator";

type StreamParams = {
  model?: string;
  max_tokens?: number;
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
