import { elizaLogger, ModelClass } from "@elizaos/core";
import {
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  type Action,
} from "@elizaos/core";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// ✅ Telegram API-Daten
const apiId = parseInt(process.env.API_ID || "0");
const apiHash = process.env.API_HASH || "";
const sessionString = process.env.TG_SESSION || "";
const channelUsername = process.env.TG_CHANNEL || ""; // Trading-Gruppe/Kanal

const client = new TelegramClient(
  new StringSession(sessionString),
  apiId,
  apiHash,
  {
    connectionRetries: 5,
  }
);

export const scrapeTelegram: Action = {
  name: "SCRAPE_TELEGRAM",
  similes: ["SCRAPE TELEGRAM", "TELEGRAM SCRAPING"],
  description: "Scraping Telegram for trading signals and crypto discussions.",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: { [key: string]: unknown },
    _callback: HandlerCallback
  ): Promise<boolean> => {
    try {
      elizaLogger.log("📡 Telegram Scraper gestartet...");

      await client.start({
        phoneNumber: async () => process.env.TG_PHONE || "",
        password: async () => process.env.TG_PASSWORD || "",
        phoneCode: async () => {
          throw new Error("Manual login required. Use session string.");
        },
        onError: (err) => console.error(err),
      });

      elizaLogger.log("✅ Erfolgreich mit Telegram verbunden!");

   

      _callback({
        text: `🚀 Telegram Scraper läuft und überwacht ${channelUsername}`,
        action: "TELEGRAM_SCRAPER_ACTIVE",
      });
      return true;
    } catch (error) {
      console.error("❌ Fehler beim Telegram Scraper:", error);
      _callback({
        text: "Es gab einen Fehler. Bitte versuche es später erneut.",
        action: "TELEGRAM_SCRAPER_ERROR",
      });
      return false;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you collect trading signals from Telegram?",
        },
      },
      {
        user: "{{eliza}}",
        content: {
          text: "I am monitoring Telegram for trading signals and will notify you of new updates.",
          action: "SCRAPE_TELEGRAM",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Find the latest crypto signals in Telegram.",
        },
      },
      {
        user: "{{eliza}}",
        content: {
          text: "I have started monitoring Telegram for the latest crypto signals.",
          action: "SCRAPE_TELEGRAM",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
