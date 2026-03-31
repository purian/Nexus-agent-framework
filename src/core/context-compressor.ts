import type { LLMProvider, Message, TextBlock } from "../types/index.js";

/**
 * ContextCompressor — manages context window size by summarizing older messages.
 *
 * When the conversation history grows too large, the compressor:
 * 1. Keeps the first message (system context) and last N messages intact
 * 2. Summarizes the middle messages into a single system message
 * 3. Uses the LLM provider itself to generate the summary
 */
export class ContextCompressor {
  private maxContextTokens: number;
  private compressionThreshold: number;

  constructor(maxContextTokens: number = 100_000) {
    this.maxContextTokens = maxContextTokens;
    this.compressionThreshold = maxContextTokens * 0.8;
  }

  /**
   * Estimate token count for a set of messages.
   * Uses the rough heuristic of 1 token ≈ 4 characters.
   */
  static estimateTokens(messages: Message[]): number {
    let totalChars = 0;

    for (const message of messages) {
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            totalChars += block.text.length;
            break;
          case "thinking":
            totalChars += block.thinking.length;
            break;
          case "tool_use":
            totalChars += block.name.length + JSON.stringify(block.input).length;
            break;
          case "tool_result": {
            const content = block.content;
            if (typeof content === "string") {
              totalChars += content.length;
            } else if (Array.isArray(content)) {
              for (const sub of content) {
                if (sub.type === "text") {
                  totalChars += sub.text.length;
                }
              }
            }
            break;
          }
          case "image":
            // Images are large but we just estimate a flat cost
            totalChars += 1000;
            break;
        }
      }
    }

    return Math.ceil(totalChars / 4);
  }

  /**
   * Returns true when total estimated tokens exceed 80% of maxContextTokens.
   */
  shouldCompress(messages: Message[]): boolean {
    const tokens = ContextCompressor.estimateTokens(messages);
    return tokens > this.compressionThreshold;
  }

  /**
   * Compress the conversation by summarizing middle messages.
   *
   * - Keeps the first message (system context) and last 10 messages intact.
   * - Summarizes everything in between into a single system message.
   * - Uses the LLM provider to generate the summary.
   *
   * If there are 12 or fewer messages, returns them unchanged (nothing to compress).
   */
  async compress(
    messages: Message[],
    provider: LLMProvider,
  ): Promise<Message[]> {
    // Need more than 12 messages to have something to compress
    // (1 first + 10 last + at least 2 middle)
    if (messages.length <= 12) {
      return messages;
    }

    const firstMessage = messages[0];
    const middleMessages = messages.slice(1, messages.length - 10);
    const lastMessages = messages.slice(messages.length - 10);

    // Build a summarization request
    const summarizationMessages: Message[] = [
      ...middleMessages,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Summarize the above conversation concisely. Focus on key decisions, facts established, actions taken, and any important context that would be needed to continue the conversation. Be thorough but brief.",
          },
        ],
      },
    ];

    // Use the provider to generate the summary
    let summaryText = "";
    const stream = provider.chat(
      {
        model: "claude-sonnet-4-20250514",
        messages: summarizationMessages,
        systemPrompt:
          "You are a conversation summarizer. Produce a concise summary of the conversation that preserves all important context, decisions, and facts.",
        maxTokens: 4096,
      },
      new AbortController().signal,
    );

    for await (const event of stream) {
      if (event.type === "text_delta") {
        summaryText += event.text;
      }
    }

    // Build the summary message
    const summaryMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Summary of prior conversation: ${summaryText}`,
        },
      ],
    };

    return [firstMessage, summaryMessage, ...lastMessages];
  }
}
