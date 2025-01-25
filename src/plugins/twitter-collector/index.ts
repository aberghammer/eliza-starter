import { Plugin } from "@elizaos/core";
import { collectTweets } from "./actions/collectTwitter.ts";

export * as actions from "./actions/index.ts";
export * as evaluators from "./evaluators/index.ts";
export * as providers from "./providers/index.ts";

export const collectTwitter: Plugin = {
  name: "collectTwitter",
  description: "Agent collects tweets from Twitter",
  actions: [collectTweets],
  // evaluators: [factEvaluator],
  // providers: [timeProvider],
};
