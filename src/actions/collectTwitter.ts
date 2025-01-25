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
// import { Scraper } from "agent-twitter-client";

// async function readTweets(): Promise<boolean> {
//   try {
//     const scraper = new Scraper();
//     const username = process.env.TWITTER_USERNAME;
//     const password = process.env.TWITTER_PASSWORD;
//     const email = process.env.TWITTER_EMAIL;
//     const twitter2faSecret = process.env.TWITTER_2FA_SECRET;

//     if (!username || !password) {
//       elizaLogger.error("Twitter credentials not configured in environment");
//       return false;
//     }

//     // Login with credentials
//     await scraper.login(username, password, email, twitter2faSecret);
//     if (!(await scraper.isLoggedIn())) {
//       elizaLogger.error("Failed to login to Twitter");
//       return false;
//     }

//     // const tweets = await scraper.getUserTweets("bmaster_crypto", 10);

//     // console.log(tweets);

//     return true;
//   } catch (error) {
//     // Log the full error details
//     elizaLogger.error("Error posting tweet:", {
//       message: error.message,
//       stack: error.stack,
//       name: error.name,
//       cause: error.cause,
//     });
//     return false;
//   }
// }

export const collectTweets: Action = {
  name: "COLLECT TWITTER",
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
      // await readTweets();

      // Callback mit Erfolgsmeldung
      _callback({
        text: `Finished Successfully`,
        action: "BLOGPOST_RESPONSE",
      });
      return true;
    } catch (error) {
      console.error("Fehler bei der Blogpost-Action:", error);
      _callback({
        text: "Es gab einen Fehler beim Hochladen des Blogposts. Bitte versuche es später erneut.",
        action: "BLOGPOST_ERROR",
      });
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Schreibe bitte einen Blogpost zum THema Social Media in der Gastronmie und veröffentliche diesen Blogpost.",
        },
      },
      {
        user: "{{laura}}",
        content: {
          text: "Ich habe einen Blogpost erstellt und ihn veröffentlicht.",
          action: "PUBLISH_BLOGPOST",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Kannst du einen Artikel zum Thema Reservierungssysteme hochladen?",
        },
      },
      {
        user: "{{laura}}",
        content: {
          text: "Ich habe den Artikel zum Thema Reservierungssysteme erstellt lade den Artikel jetzt hoch.",
          action: "PUBLISH_BLOGPOST",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Poste bitte einen Blogbeitrag zum Thema Reduzierung von No Show bei Gästen.",
        },
      },
      {
        user: "{{laura}}",
        content: {
          text: "Ich erstelle den Beitrag und poste ihn jetzt.",
          action: "PUBLISH_BLOGPOST",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
