import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";

const inputSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    .optional()
    .default("GET")
    .describe("HTTP method (default GET)"),
});

type WebFetchInput = z.infer<typeof inputSchema>;

interface WebFetchOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export const webFetchTool: Tool<WebFetchInput, WebFetchOutput> = {
  name: "web_fetch",
  description:
    "Fetch content from a URL using HTTP. Returns the response status, headers, " +
    "and body as text. Useful for reading web pages, API responses, " +
    "and downloading text-based content.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return true;
  },

  isReadOnly(): boolean {
    return true;
  },

  async execute(
    input: WebFetchInput,
    context: ToolContext,
  ): Promise<ToolResult<WebFetchOutput>> {
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method ?? "GET",
        signal: context.abortSignal,
        headers: {
          "User-Agent": "Nexus/1.0",
          Accept: "text/html, application/json, text/plain, */*",
        },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown fetch error";
      throw new Error(`Failed to fetch ${input.url}: ${message}`);
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      body = "[Failed to read response body]";
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      data: {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        url: response.url,
      },
    };
  },

  renderToolUse(input: Partial<WebFetchInput>): string {
    return `${input.method ?? "GET"} ${input.url ?? ""}`;
  },

  renderResult(output: WebFetchOutput): string {
    const preview =
      output.body.length > 500
        ? output.body.slice(0, 500) + "..."
        : output.body;
    return `${output.status} ${output.statusText}\n${preview}`;
  },

  maxResultSize: 200_000,
};
