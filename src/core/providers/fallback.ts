import type { LLMEvent, LLMProvider, LLMRequest } from "../../types/index.js";

/**
 * FallbackProvider — tries providers in order, falling back on errors.
 *
 * If the primary provider fails (network error, rate limit, etc.),
 * automatically tries the next provider in the chain.
 */
export class FallbackProvider implements LLMProvider {
  name: string;
  private providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
    this.providers = providers;
    this.name = `fallback(${providers.map((p) => p.name).join(" -> ")})`;
  }

  async *chat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    let lastError: Error | undefined;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const isLast = i === this.providers.length - 1;

      try {
        const events: LLMEvent[] = [];
        let hadError = false;

        // Collect events — if an error event appears, try next provider
        for await (const event of provider.chat(request, signal)) {
          if (event.type === "error") {
            lastError = event.error;
            hadError = true;
            break;
          }
          events.push(event);
        }

        if (hadError && !isLast) {
          // Try next provider
          continue;
        }

        // Yield all collected events
        for (const event of events) {
          yield event;
        }

        if (hadError) {
          // Last provider also errored
          yield { type: "error", error: lastError! };
        }

        // Success — stop trying providers
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isLast) {
          yield { type: "error", error: lastError };
          return;
        }
        // Try next provider
      }
    }
  }

  async listModels(): Promise<string[]> {
    const allModels: string[] = [];
    for (const provider of this.providers) {
      if (provider.listModels) {
        try {
          const models = await provider.listModels();
          allModels.push(...models);
        } catch {
          // Skip providers that fail
        }
      }
    }
    return allModels;
  }
}
