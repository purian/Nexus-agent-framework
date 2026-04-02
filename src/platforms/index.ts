import type { PlatformAdapter } from "../types/index.js";
import { DiscordAdapter } from "./discord.js";
import { EmailAdapter } from "./email.js";
import { MatrixAdapter } from "./matrix.js";
import { SlackAdapter } from "./slack.js";
import { TelegramAdapter } from "./telegram.js";
import { WebhookAdapter } from "./webhook.js";
import { WhatsAppAdapter } from "./whatsapp.js";

export { TelegramAdapter } from "./telegram.js";
export { DiscordAdapter } from "./discord.js";
export { SlackAdapter } from "./slack.js";
export { WebhookAdapter } from "./webhook.js";
export { WhatsAppAdapter } from "./whatsapp.js";
export { EmailAdapter } from "./email.js";
export { MatrixAdapter } from "./matrix.js";

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
    case "webhook":
      return new WebhookAdapter();
    case "whatsapp":
      return new WhatsAppAdapter();
    case "email":
      return new EmailAdapter();
    case "matrix":
      return new MatrixAdapter();
    default:
      throw new Error(`Unknown platform: "${name}". Available: telegram, discord, slack, webhook, whatsapp, email, matrix`);
  }
}
