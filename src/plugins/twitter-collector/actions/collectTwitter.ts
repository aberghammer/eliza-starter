import { elizaLogger, ModelClass } from "@elizaos/core";
import {
  ActionExample,
  generateText,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  type Action,
} from "@elizaos/core";

import { ClientBase, TwitterConfig, TwitterPostClient } from "./utils/index.ts";
import { validateTwitterConfig } from "./utils/index.ts";
import { TwitterInteractionClient } from "./utils/index.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 */
class TwitterManager {
  client: ClientBase;
  post: TwitterPostClient;
  interaction: TwitterInteractionClient;

  constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
    // Pass twitterConfig to the base client
    this.client = new ClientBase(runtime, twitterConfig);
    // Posting logic
    this.post = new TwitterPostClient(this.client, runtime);
    //interaction logic
    this.interaction = new TwitterInteractionClient(this.client, runtime);
  }
}

export const collectTweets: Action = {
  name: "COLLECT_TWITTER",
  similes: ["COLLECT TWEETS", "TWITTER COLLECTOR"],
  description:
    "Erstellt und bereitet einen Blogpost auf und lädt ihn direkt zu Storyblok hoch.",

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
      const twitterConfig: TwitterConfig = await validateTwitterConfig(
        _runtime
      );

      elizaLogger.log("Twitter client started");

      const manager = new TwitterManager(_runtime, twitterConfig);

      // Initialize login/session
      await manager.client.init();

      // Initialize login/session
      await manager.interaction.start();

      // Callback mit Erfolgsmeldung
      _callback({
        text: `RUNNING NOW`,
        action: "TWITTER_COLLECTOR_SUCCESS",
      });
      return true;
    } catch (error) {
      console.error("Fehler bei der Action:", error);
      _callback({
        text: "Es gab einen Fehler. Bitte versuche es später erneut.",
        action: "TWITTER_COLLECTOR_ERROR",
      });
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you collect and summarize the latest tweets about NFTs and Web3?",
        },
      },
      {
        user: "{{bernd}}",
        content: {
          text: "I have collected and summarized the latest tweets about NFTs and Web3.",
          action: "COLLECT_TWITTER",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Please gather the latest tweets about crypto trends and provide a summary.",
        },
      },
      {
        user: "{{bernd}}",
        content: {
          text: "I have gathered the latest tweets about crypto trends and summarized them.",
          action: "COLLECT_TWITTER",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you collect tweets about the newest developments in Web3?",
        },
      },
      {
        user: "{{bernd}}",
        content: {
          text: "I have collected tweets about the newest developments in Web3 and summarized them for you.",
          action: "COLLECT_TWITTER",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Summarize tweets related to the latest NFT trends.",
        },
      },
      {
        user: "{{bernd}}",
        content: {
          text: "I have summarized tweets related to the latest NFT trends.",
          action: "COLLECT_TWITTER",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you gather tweets about the benefits of decentralized finance (DeFi) and summarize them?",
        },
      },
      {
        user: "{{bernd}}",
        content: {
          text: "I have gathered tweets about the benefits of decentralized finance (DeFi) and summarized them.",
          action: "COLLECT_TWITTER",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
