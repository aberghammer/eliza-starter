import { Plugin } from "@elizaos/core";
import { scrapeTelegram } from "./actions/scrapeTelegram.ts";

export * as actions from "./actions/index.ts";

export const scrapeTelegramChannels: Plugin = {
  name: "scrapeTelegram",
  description: "Agent checks telegram groups",
  actions: [scrapeTelegram],
  // evaluators: [factEvaluator],
  // providers: [timeProvider],
};
