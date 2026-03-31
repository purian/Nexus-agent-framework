import type { PlatformAdapter } from "../types/index.js";
import { DiscordAdapter } from "./discord.js";
import { SlackAdapter } from "./slack.js";
import { TelegramAdapter } from "./telegram.js";

export { TelegramAdapter } from "./telegram.js";
export { DiscordAdapter } from "./discord.js";
export { SlackAdapter } from "./slack.js";

/**
 * Factory function to create a platform adapter by name.
 */
export function createPlatform(
  name: string,
  _config?: Record<string, unknown>,
): PlatformAdapter {
  switch (name.toLowerCase()) {
    case "telegram":
      return new TelegramAdapter();
    case "discord":
      return new DiscordAdapter();
    case "slack":
      return new SlackAdapter();
    default:
      throw new Error(`Unknown platform: "${name}". Available: telegram, discord, slack`);
  }
}
