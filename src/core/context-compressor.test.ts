import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, Message } from "../types/index.js";
import { ContextCompressor } from "./context-compressor.js";

function makeTextMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

function makeMockProvider(summaryText: string): LLMProvider {
  return {
    name: "mock",
    async *chat() {
      yield { type: "text_delta" as const, text: summaryText };
      yield {
        type: "message_end" as const,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

describe("ContextCompressor", () => {
  // ---------------------------------------------------------------------------
  // estimateTokens
  // ---------------------------------------------------------------------------

  describe("estimateTokens", () => {
    it("estimates roughly 4 chars per token", () => {
      // 40 characters -> 10 tokens
      const messages: Message[] = [
        makeTextMessage("user", "a".repeat(40)),
      ];
      expect(ContextCompressor.estimateTokens(messages)).toBe(10);
    });

    it("rounds up fractional tokens", () => {
      // 5 characters -> ceil(5/4) = 2 tokens
      const messages: Message[] = [makeTextMessage("user", "hello")];
      expect(ContextCompressor.estimateTokens(messages)).toBe(2);
    });

    it("sums across multiple messages and blocks", () => {
      const messages: Message[] = [
        makeTextMessage("user", "a".repeat(100)), // 25 tokens
        makeTextMessage("assistant", "b".repeat(200)), // 50 tokens
      ];
      expect(ContextCompressor.estimateTokens(messages)).toBe(75);
    });

    it("handles tool_use blocks", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "read",
              input: { path: "/foo/bar" },
            },
          ],
        },
      ];
      const tokens = ContextCompressor.estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it("handles tool_result blocks with string content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "x".repeat(80),
            },
          ],
        },
      ];
      expect(ContextCompressor.estimateTokens(messages)).toBe(20);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldCompress
  // ---------------------------------------------------------------------------

  describe("shouldCompress", () => {
    it("returns false when under threshold", () => {
      const compressor = new ContextCompressor(1000);
      // 80% of 1000 = 800 tokens = 3200 chars
      const messages: Message[] = [
        makeTextMessage("user", "a".repeat(2000)), // 500 tokens
      ];
      expect(compressor.shouldCompress(messages)).toBe(false);
    });

    it("returns true when over threshold", () => {
      const compressor = new ContextCompressor(1000);
      // 80% of 1000 = 800 tokens = 3200 chars
      const messages: Message[] = [
        makeTextMessage("user", "a".repeat(4000)), // 1000 tokens > 800
      ];
      expect(compressor.shouldCompress(messages)).toBe(true);
    });

    it("returns false at exactly the threshold", () => {
      const compressor = new ContextCompressor(1000);
      // 800 tokens = 3200 chars exactly
      const messages: Message[] = [
        makeTextMessage("user", "a".repeat(3200)), // exactly 800 tokens
      ];
      expect(compressor.shouldCompress(messages)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // compress
  // ---------------------------------------------------------------------------

  describe("compress", () => {
    it("keeps first and last 10 messages intact", async () => {
      const provider = makeMockProvider("This is a summary.");
      const compressor = new ContextCompressor();

      // Create 20 messages: first + 9 middle + last 10
      const messages: Message[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push(makeTextMessage("user", `Message ${i}`));
      }

      const result = await compressor.compress(messages, provider);

      // Should be: first message + summary + last 10 = 12
      expect(result.length).toBe(12);

      // First message preserved
      expect(result[0]).toBe(messages[0]);

      // Summary message
      const summaryBlock = result[1].content[0];
      expect(summaryBlock.type).toBe("text");
      expect((summaryBlock as { type: "text"; text: string }).text).toContain(
        "Summary of prior conversation:",
      );
      expect((summaryBlock as { type: "text"; text: string }).text).toContain(
        "This is a summary.",
      );

      // Last 10 messages preserved (by reference)
      for (let i = 0; i < 10; i++) {
        expect(result[i + 2]).toBe(messages[10 + i]);
      }
    });

    it("generates summary for middle messages via provider", async () => {
      const provider = makeMockProvider("Key facts from the middle.");
      const chatSpy = vi.spyOn(provider, "chat");
      const compressor = new ContextCompressor();

      const messages: Message[] = [];
      for (let i = 0; i < 15; i++) {
        messages.push(makeTextMessage("user", `Message ${i}`));
      }

      const result = await compressor.compress(messages, provider);

      // Provider should have been called once for summarization
      expect(chatSpy).toHaveBeenCalledOnce();

      // The summarization request should include the middle messages
      const callArgs = chatSpy.mock.calls[0][0];
      // Middle messages are messages[1..4] (indices 1,2,3,4) = 4 messages
      // Plus the summarization instruction = 5 messages total
      expect(callArgs.messages.length).toBe(5);

      // Summary should appear in the result
      const summaryBlock = result[1].content[0] as { type: "text"; text: string };
      expect(summaryBlock.text).toContain("Key facts from the middle.");
    });

    it("handles edge case of fewer than 12 messages (nothing to compress)", async () => {
      const provider = makeMockProvider("should not be called");
      const chatSpy = vi.spyOn(provider, "chat");
      const compressor = new ContextCompressor();

      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeTextMessage("user", `Message ${i}`));
      }

      const result = await compressor.compress(messages, provider);

      // Should return original messages unchanged
      expect(result).toBe(messages);
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("handles exactly 12 messages (nothing to compress)", async () => {
      const provider = makeMockProvider("should not be called");
      const chatSpy = vi.spyOn(provider, "chat");
      const compressor = new ContextCompressor();

      const messages: Message[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push(makeTextMessage("user", `Message ${i}`));
      }

      const result = await compressor.compress(messages, provider);

      expect(result).toBe(messages);
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("handles 13 messages (minimal compression)", async () => {
      const provider = makeMockProvider("Two messages summarized.");
      const compressor = new ContextCompressor();

      const messages: Message[] = [];
      for (let i = 0; i < 13; i++) {
        messages.push(makeTextMessage("user", `Message ${i}`));
      }

      const result = await compressor.compress(messages, provider);

      // first + summary + last 10 = 12
      expect(result.length).toBe(12);
      expect(result[0]).toBe(messages[0]);
      expect(result[2]).toBe(messages[3]); // messages[3] is the first of last 10
    });
  });
});
