import { elizaLogger } from "@elizaos/core";
import {
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  type Action,
} from "@elizaos/core";
import { TelegramClient } from "telegram";
import { sessions } from 'telegram';
import { TelegramClientBase } from "./utils/base.ts";

// ✅ Telegram API-Daten
const apiId = parseInt(process.env.TELEGRAM_APP_ID || "0");
const apiHash = process.env.TELEGRAM_API_HASH || "";
const channelUsername = process.env.TELEGRAM_BOSSMAN_CHANNEL || ""; // Trading-Gruppe/Kanal

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

      // ✅ Initialisiere den Scraper mit API-Daten und Eliza-Runtime
      const scraper = new TelegramClientBase(apiId, apiHash, _runtime);

      elizaLogger.log("📡 Scraper initialisiert...");

      // 🔥 WICHTIG: Hier MUSS await stehen, sonst läuft der Code weiter, bevor init() fertig ist!
      await scraper.init();

      elizaLogger.log("✅ Erfolgreich mit Telegram verbunden!");

      const summary =  await scraper.fetchLatestMessages(channelUsername)

      _callback({
        text: `🚀 Telegram Scraper läuft und überwacht ${summary}`,
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
