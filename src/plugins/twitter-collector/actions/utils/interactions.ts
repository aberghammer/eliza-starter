import { SearchMode, Tweet } from "agent-twitter-client";
import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ModelClass,
  State,
  stringToUuid,
  elizaLogger,
  getEmbeddingZeroVector,
  generateText,
  embed,
  MemoryManager,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import { actions } from "@elizaos/plugin-bootstrap";

const SCRAPE_BATCH_SIZE = 5; // Anzahl der Twitter-Accounts pro Durchlauf
const SCRAPE_INTERVAL_MS = 4 * 60 * 1000; // Alle 4 Minuten wird ein Batch verarbeitet (3–5 Minuten je nach Wunsch)
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // Alle 30 Minuten wird eine Zusammenfassung erstellt

export const twitterMessageHandlerTemplate =
  `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
  `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  collectedTweets: Tweet[];
  targetUserChunks: string[][];

  currentChunkIndex: number;
  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.collectedTweets = [];

    // Aufteilen der konfigurierten User in Batches
    this.targetUserChunks = [];
    if (this.client.twitterConfig.TWITTER_TARGET_USERS?.length) {
      this.targetUserChunks = chunkArray(
        this.client.twitterConfig.TWITTER_TARGET_USERS,
        SCRAPE_BATCH_SIZE
      );
    }
    // Index, welcher Chunk als nächstes verarbeitet wird
    this.currentChunkIndex = 0;
  }

  sendSummaryToTelegram = async (message: string) => {
    const token = process.env.TELEGRAM_BOT_TOKEN; // Dein Bot-Token
    const channel = process.env.TELEGRAM_NEWS_CHANNEL; // Kanal-ID oder @Benutzername

    if (!token) {
      throw new Error(
        "API-Token fehlt. Bitte setzen Sie TELEGRAM_BOT_TOKEN in Ihrer .env-Datei."
      );
    }

    if (!channel) {
      throw new Error(
        "Kanal-ID fehlt. Bitte setzen Sie TELEGRAM_NEWS_CHANNEL in Ihrer .env-Datei."
      );
    }

    try {
      // Sendeanfrage an die Telegram-API
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: channel, // ID oder Benutzername des Kanals
            text: message, // Nachricht, die gesendet werden soll
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Fehler beim Senden an Telegram: ${response.status} ${response.statusText}`
        );
      }

      const result = await response.json();
      console.log("Nachricht erfolgreich gesendet:", result);
      return result;
    } catch (error) {
      console.error("Fehler beim Senden an Telegram:", error);
      throw error;
    }
  };

  /**
   * Startet alle notwendigen Loops:
   * 1) Scraping-Loop: sammelt alle 3–5 (im Beispiel 4) Minuten neue Tweets von einer Teilmenge von Accounts.
   * 2) Summary-Loop: fasst alle 30 Minuten die gesammelten Tweets zusammen.
   */
  async start() {
    // Loop zum regelmäßigen Scrapen in Batches
    this.startScrapingLoop();

    // Loop zum regelmäßigen Erstellen einer Zusammenfassung
    this.startSummaryLoop();
  }

  /**
   * Startet den Loop, der in definierten Intervallen (z.B. alle 4 Minuten)
   * jeweils einen Teil (Batch) der Twitter-Accounts abfragt.
   */
  startScrapingLoop() {
    // Einmal beim Start direkt aufrufen
    this.handleTwitterBatch();

    // Anschließend per setInterval alle 3–5 Minuten
    setInterval(() => {
      this.handleTwitterBatch();
    }, SCRAPE_INTERVAL_MS);
  }

  /**
   * Ruft den nächsten Batch von Twitter-Usern ab, holt deren Tweets,
   * filtert sie und speichert sie in `this.collectedTweets`.
   */
  async handleTwitterBatch() {
    // Falls es keine konfigurierten User gibt, nur Mentions oder Abbruch
    if (!this.targetUserChunks.length) {
      elizaLogger.log("Keine TWITTER_TARGET_USERS konfiguriert, breche ab.");
      return;
    }

    // Bestimmen, welcher Chunk als nächstes dran ist
    const usersToFetch = this.targetUserChunks[this.currentChunkIndex] || [];
    elizaLogger.log(
      `Verarbeite Chunk ${this.currentChunkIndex + 1}/${
        this.targetUserChunks.length
      }:`,
      usersToFetch
    );

    try {
      // Sammle die Tweets des aktuellen Batches
      const newTweets = await this.fetchAndFilterTweets(usersToFetch);

      // Für Logging/Debugging
      elizaLogger.log(
        `Anzahl neuer Tweets aus dem Batch ${this.currentChunkIndex + 1}:`,
        newTweets.length
      );

      // Neue Tweets in gesammelten Pool übernehmen
      this.collectedTweets.push(...newTweets);
    } catch (error) {
      elizaLogger.error("Fehler beim Abfragen der Tweets:", error);
    }

    // Index inkrementieren, wenn wir das Ende erreicht haben, wieder auf 0 setzen
    this.currentChunkIndex++;
    if (this.currentChunkIndex >= this.targetUserChunks.length) {
      this.currentChunkIndex = 0;
    }
  }

  /**
   * Startet den Loop, der alle 30 Minuten eine Zusammenfassung erstellt.
   */
  startSummaryLoop() {
    // Optional: Beim Start kannst du einmalig direkt eine Zusammenfassung erstellen
    // this.processAndSummarizeCollectedTweets();

    setInterval(() => {
      this.processAndSummarizeCollectedTweets();
    }, SUMMARY_INTERVAL_MS);
  }

  /**
   * Fragt Twitter nach neuesten Tweets der gegebenen User ab,
   * filtert sie anhand deiner Kriterien (z.B. isReply, isRetweet, Zeitfenster)
   * und gibt die validen Tweets zurück.
   */
  async fetchAndFilterTweets(usersArray) {
    const allValidTweets = [];

    for (const username of usersArray) {
      try {
        // Beispiel: Fetch 3 neueste Tweets des Nutzers
        const userTweets = (
          await this.client.twitterClient.fetchSearchTweets(
            `from:${username}`,
            3,
            SearchMode.Latest
          )
        ).tweets;

        // Filterkriterien
        const validTweets = userTweets.filter((tweet) => {
          const isUnprocessed =
            !this.client.lastCheckedTweetId ||
            BigInt(tweet.id) > this.client.lastCheckedTweetId;
          const isRecent =
            Date.now() - tweet.timestamp * 1000 < 2 * 60 * 60 * 1000;

          elizaLogger.log(`Tweet ${tweet.id} checks:`, {
            isUnprocessed,
            isRecent,
            isReply: tweet.isReply,
            isRetweet: tweet.isRetweet,
          });

          return (
            isUnprocessed && !tweet.isReply && !tweet.isRetweet && isRecent
          );
        });

        if (validTweets.length > 0) {
          elizaLogger.log(
            `Gefundene gültige Tweets von ${username}:`,
            validTweets.length
          );
          allValidTweets.push(...validTweets);
        }
      } catch (error) {
        elizaLogger.error(
          `Fehler beim Abfragen der Tweets für ${username}:`,
          error
        );
        continue;
      }
    }

    // Sortiere gefundene Tweets aufsteigend nach ID und entferne ggf. eigene
    const tweetCandidates = allValidTweets
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((tweet) => tweet.userId !== this.client.profile.id);

    return tweetCandidates;
  }

  async buildConversationThread(tweet, maxReplies = 10) {
    const thread = [];
    const visited = new Set();

    const processThread = async (currentTweet, depth = 0) => {
      if (!currentTweet || depth >= maxReplies) return;

      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
      );

      if (!memory && !visited.has(currentTweet.id)) {
        visited.add(currentTweet.id);
        thread.unshift(currentTweet);

        if (currentTweet.inReplyToStatusId) {
          try {
            const parentTweet = await this.client.twitterClient.getTweet(
              currentTweet.inReplyToStatusId
            );
            await processThread(parentTweet, depth + 1);
          } catch (error) {
            elizaLogger.error("Error fetching parent tweet:", error);
          }
        }
      }
    };

    await processThread(tweet);
    return thread;
  }

  /**
   * Wird alle 30 Minuten aufgerufen:
   * - verarbeitet (bei Bedarf) die gesammelten Tweets weiter,
   * - baut Threads (Conversation Thread),
   * - generiert eine Zusammenfassung,
   * - speichert Embeddings im Memory.
   * Anschließend können die gesammelten Tweets geleert werden, falls gewünscht.
   */
  async processAndSummarizeCollectedTweets() {
    elizaLogger.log("Starte Prozessierung der gesammelten Tweets.");

    // Wenn keine neuen Tweets vorliegen, abbrechen
    if (this.collectedTweets.length === 0) {
      elizaLogger.log(
        "Keine gesammelten Tweets vorhanden, keine Zusammenfassung."
      );
      return;
    }

    // 1) Baue für jeden neuen Tweet optional den Conversation-Thread
    // 2) Erstelle State, Memory-Einträge, etc.

    const processedTweets = [];
    for (const tweet of this.collectedTweets) {
      // Check, ob Tweet bereits verarbeitet wurde
      const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
      const existingResponse = await this.runtime.messageManager.getMemoryById(
        tweetId
      );

      if (existingResponse) {
        elizaLogger.log(
          `Tweet ${tweet.id} wurde bereits verarbeitet, überspringe.`
        );
        continue;
      }

      // Baue Conversation-Thread (falls gewünscht/erforderlich)
      const thread = await this.buildConversationThread(tweet);

      elizaLogger.log("Neuer Tweet gefunden:", tweet.permanentUrl);

      if (thread.length === 1 && thread[0].id === tweet.id) {
        elizaLogger.log("Einzel-Tweet ohne vorherige Konversation:", tweet.id);
        processedTweets.push({ tweet, thread: null });
      } else {
        elizaLogger.log("Thread aufgebaut:", thread);
        processedTweets.push({ tweet, thread });
      }

      // Vorbereiten einer Connection und State
      const roomId = stringToUuid(
        tweet.conversationId + "-" + this.runtime.agentId
      );
      const userIdUUID =
        tweet.userId === this.client.profile.id
          ? this.runtime.agentId
          : stringToUuid(tweet.userId);

      await this.runtime.ensureConnection(
        userIdUUID,
        roomId,
        tweet.username,
        tweet.name,
        "twitter"
      );

      const state = await this.runtime.composeState(
        {
          id: tweetId,
          agentId: this.runtime.agentId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
          },
          userId: userIdUUID,
          roomId,
          createdAt: tweet.timestamp * 1000,
        },
        {
          twitterClient: this.client.twitterClient,
          twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
          currentPost: tweet.text,
          formattedConversation: thread
            .map(
              (twt) =>
                `@${twt.username} (${new Date(
                  twt.timestamp * 1000
                ).toLocaleString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                })}):\n${twt.text}`
            )
            .join("\n\n"),
        }
      );

      // Speichere die Anfrage im internen System
      this.client.saveRequestMessage(
        {
          id: tweetId,
          agentId: this.runtime.agentId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
          },
          userId: userIdUUID,
          roomId,
          createdAt: tweet.timestamp * 1000,
        },
        state
      );
    }

    // Alle verarbeiteten Tweets in einem String zusammenfassen
    const allTexts = processedTweets.map(
      (item) =>
        `${item.tweet.username}: ${item.tweet.text} [Link](${item.tweet.permanentUrl})`
    );

    const combinedText = allTexts.join("\n\n");

    if (!combinedText) {
      elizaLogger.log(
        "Keine neuen verarbeiteten Tweets vorhanden, Zusammenfassung entfällt."
      );
      return;
    }

    // Relevante Daten extrahieren
    const relevantData = processedTweets.map((tweetObj) => {
      const tweet = tweetObj.tweet;
      return {
        username: tweet.username,
        text: tweet.text,
      };
    });

    // Embeddings generieren und ggf. ins Memory einpflegen
    // const embeddings = await Promise.all(
    //   relevantData.map((tweet) => embed(this.runtime, tweet.text))
    // );

    const tweetMemory = new MemoryManager({
      runtime: this.runtime,
      tableName: "tweetMemory",
    });

    // Optionale Suche nach ähnlichen Inhalten im Memory:
    // (im Beispiel führen wir das pro relevanten Tweet durch)
    const roomId = stringToUuid(
      "twitter_generate_room-" + this.client.profile.username
    );
    // const searchResults = await Promise.all(
    //   embeddings.map((embedding) =>
    //     tweetMemory.searchMemoriesByEmbedding(embedding, {
    //       match_threshold: 0.8,
    //       count: 5,
    //       roomId,
    //     })
    //   )
    // );

    // State für den Summarizer erzeugen (kombinierter Text).
    const state = await this.runtime.composeState({
      userId: this.runtime.agentId,
      roomId: roomId,
      agentId: this.runtime.agentId,
      content: { text: combinedText },
    });

    const context = composeContext({
      state,
      template: `
      Here are some recent tweets:
      ${combinedText}
      
      Task:
      
      1. Analyze each tweet in detail and extract the specific information mentioned (e.g., data points, quotes, claims, or observations).
      2. Organize the topics by relevance, scoring the relevance based on the number of mentions or depth of discussion.
      3. Summarize each relevant topic by providing specific details mentioned in the tweets.
      4. Identify the authors of the tweets and attribute the details to them.
      5. Make the summary concise yet detailed enough to understand the key takeaways of each tweet.
      
      
      Output format (Telegram-ready):
      🔥 Ordered Topics (with relevance score):
      1️⃣ Topic 1 (Relevance: ⭐⭐⭐⭐)
          - Key point 1
          - Key point 2
      2️⃣ Topic 2 (Relevance: ⭐⭐⭐)
          - Key point 1
          - Key point 2
      
      📋 Detailed Summary:
      🔹 Topic 1: 
          - Specific detail 1
          - Specific detail 2
      🔹 Topic 2: 
          - Specific detail 1
          - Specific detail 2
      
      👤 Authors and Details:
      - @Author1: Mentioned *Topic 1* with [Tweet Link](link)
      - @Author2: Mentioned *Topic 2* with [Tweet Link](link)
      

      `,
    });

    // Generiere eine Zusammenfassung mit dem LLM/Modell deiner Wahl
    const summary = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL, // hier ggf. anpassen
    });

    // Verschicke die Summary z.B. via Telegram (oder an anderes Ziel)
    await this.sendSummaryToTelegram(summary);

    // Speichere Embeddings ins Memory
    // for (const [index, embedding] of embeddings.entries()) {
    //   const tweet = relevantData[index];

    //   const memory = {
    //     userId: this.runtime.agentId,
    //     agentId: this.runtime.agentId,
    //     content: {
    //       text: tweet.text,
    //       username: tweet.username,
    //     },
    //     roomId: stringToUuid(`twitter_memory-${tweet.username}`),
    //     embedding: embedding,
    //   };

    //   try {
    //     const savedMemory = await tweetMemory.addEmbeddingToMemory(memory);
    //     elizaLogger.log("Embedding erfolgreich gespeichert:", savedMemory);
    //   } catch (error) {
    //     elizaLogger.error("Fehler beim Speichern des Embeddings:", error);
    //   }
    // }

    // Optional: Nachdem die Tweets verarbeitet und die Zusammenfassung erstellt wurde,
    // können wir das Array leeren, damit bei der nächsten Zusammenfassung
    // nur neue Tweets einfließen.
    this.collectedTweets = [];

    elizaLogger.log("Zusammenfassung erstellt und Embeddings gespeichert.");
  }

  // async handleTwitterInteractions() {
  //   elizaLogger.log("Checking Twitter interactions");

  //   const twitterUsername = this.client.profile.username;
  //   try {
  //     let uniqueTweetCandidates = [];
  //     // Only process target users if configured
  //     if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
  //       const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;

  //       elizaLogger.log("Processing target users:", TARGET_USERS);

  //       if (TARGET_USERS.length > 0) {
  //         // Create a map to store tweets by user
  //         const tweetsByUser = new Map<string, Tweet[]>();

  //         // Fetch tweets from all target users
  //         for (const username of TARGET_USERS) {
  //           try {
  //             const userTweets = (
  //               await this.client.twitterClient.fetchSearchTweets(
  //                 `from:${username}`,
  //                 3,
  //                 SearchMode.Latest
  //               )
  //             ).tweets;

  //             // Filter for unprocessed, non-reply, recent tweets
  //             const validTweets = userTweets.filter((tweet) => {
  //               const isUnprocessed =
  //                 !this.client.lastCheckedTweetId ||
  //                 parseInt(tweet.id) > this.client.lastCheckedTweetId;
  //               const isRecent =
  //                 Date.now() - tweet.timestamp * 1000 < 2 * 60 * 60 * 1000;

  //               elizaLogger.log(`Tweet ${tweet.id} checks:`, {
  //                 isUnprocessed,
  //                 isRecent,
  //                 isReply: tweet.isReply,
  //                 isRetweet: tweet.isRetweet,
  //               });

  //               return (
  //                 isUnprocessed &&
  //                 !tweet.isReply &&
  //                 !tweet.isRetweet &&
  //                 isRecent
  //               );
  //             });

  //             if (validTweets.length > 0) {
  //               tweetsByUser.set(username, validTweets);
  //               elizaLogger.log(
  //                 `Found ${validTweets.length} valid tweets from ${username}`
  //               );
  //             }
  //           } catch (error) {
  //             elizaLogger.error(
  //               `Error fetching tweets for ${username}:`,
  //               error
  //             );
  //             continue;
  //           }
  //         }

  //         //DAS BRAUCHE ICH NICHT ICH WILL ALLE BEHALTEN

  //         // Select one tweet from each user that has tweets
  //         const selectedTweets: Tweet[] = [];
  //         for (const [username, tweets] of tweetsByUser) {
  //           if (tweets.length > 0) {
  //             //TODO: HERE NO RANDOM TWEET - WE WANT TO KEEP ALL TWEETS
  //             const randomTweet =
  //               tweets[Math.floor(Math.random() * tweets.length)];
  //             selectedTweets.push(randomTweet);
  //             elizaLogger.log(
  //               `Selected tweet from ${username}: ${randomTweet.text?.substring(
  //                 0,
  //                 100
  //               )}`
  //             );
  //           }
  //         }

  //         // Add selected tweets to candidates
  //         uniqueTweetCandidates = [...selectedTweets];
  //       }
  //     } else {
  //       elizaLogger.log("No target users configured, processing only mentions");
  //     }

  //     // Sort tweet candidates by ID in ascending order
  //     uniqueTweetCandidates
  //       .sort((a, b) => a.id.localeCompare(b.id))
  //       .filter((tweet) => tweet.userId !== this.client.profile.id);

  //     // for each tweet candidate, handle the tweet
  //     // I WANT TO GET A CONVERSATION THREAD FOR EACH TWEET BUT NOT RESPOND
  //     // BRING THE TWEET BACK INTO A FINAL FORM FOR STORING IN MEMORY
  //     // RESULTING SHOULD BE A OBJECT CONTAINING ALL TWEETS
  //     for (const tweet of uniqueTweetCandidates) {
  //       if (
  //         !this.client.lastCheckedTweetId ||
  //         BigInt(tweet.id) > this.client.lastCheckedTweetId
  //       ) {
  //         // Generate the tweetId UUID the same way it's done in handleTweet
  //         const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

  //         // Check if we've already processed this tweet
  //         const existingResponse =
  //           await this.runtime.messageManager.getMemoryById(tweetId);

  //         if (existingResponse) {
  //           elizaLogger.log(`Already responded to tweet ${tweet.id}, skipping`);
  //           continue;
  //         }
  //         elizaLogger.log("New Tweet found", tweet.permanentUrl);

  //         const roomId = stringToUuid(
  //           tweet.conversationId + "-" + this.runtime.agentId
  //         );

  //         const userIdUUID =
  //           tweet.userId === this.client.profile.id
  //             ? this.runtime.agentId
  //             : stringToUuid(tweet.userId!);

  //         await this.runtime.ensureConnection(
  //           userIdUUID,
  //           roomId,
  //           tweet.username,
  //           tweet.name,
  //           "twitter"
  //         );

  //         const thread = await buildConversationThread(tweet, this.client);

  //         const message = {
  //           content: { text: tweet.text },
  //           agentId: this.runtime.agentId,
  //           userId: userIdUUID,
  //           roomId,
  //         };

  //         await this.handleTweet({
  //           tweet,
  //           message,
  //           thread,
  //         });

  //         // Update the last checked tweet ID after processing each tweet
  //         this.client.lastCheckedTweetId = BigInt(tweet.id);
  //       }
  //     }

  //     // Save the latest checked tweet ID to the file
  //     await this.client.cacheLatestCheckedTweetId();

  //     elizaLogger.log("Finished checking Twitter interactions");
  //   } catch (error) {
  //     elizaLogger.error("Error handling Twitter interactions:", error);
  //   }
  // }

  // private async handleTweet({
  //   tweet,
  //   message,
  //   thread,
  // }: {
  //   tweet: Tweet;
  //   message: Memory;
  //   thread: Tweet[];
  // }) {
  //   if (tweet.userId === this.client.profile.id) {
  //     // console.log("skipping tweet from bot itself", tweet.id);
  //     // Skip processing if the tweet is from the bot itself
  //     return;
  //   }

  //   if (!message.content.text) {
  //     elizaLogger.log("Skipping Tweet with no text", tweet.id);
  //     return { text: "", action: "IGNORE" };
  //   }

  //   elizaLogger.log("Processing Tweet: ", tweet.id);
  //   const formatTweet = (tweet: Tweet) => {
  //     return `  ID: ${tweet.id}
  // From: ${tweet.name} (@${tweet.username})
  // Text: ${tweet.text}`;
  //   };
  //   const currentPost = formatTweet(tweet);

  //   elizaLogger.debug("Thread: ", thread);
  //   const formattedConversation = thread
  //     .map(
  //       (tweet) => `@${tweet.username} (${new Date(
  //         tweet.timestamp * 1000
  //       ).toLocaleString("en-US", {
  //         hour: "2-digit",
  //         minute: "2-digit",
  //         month: "short",
  //         day: "numeric",
  //       })}):
  //       ${tweet.text}`
  //     )
  //     .join("\n\n");

  //   elizaLogger.debug("formattedConversation: ", formattedConversation);

  //   let state = await this.runtime.composeState(message, {
  //     twitterClient: this.client.twitterClient,
  //     twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
  //     currentPost,
  //     formattedConversation,
  //   });

  //   // check if the tweet exists, save if it doesn't
  //   const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
  //   const tweetExists = await this.runtime.messageManager.getMemoryById(
  //     tweetId
  //   );

  //   if (!tweetExists) {
  //     elizaLogger.log("tweet does not exist, saving");
  //     const userIdUUID = stringToUuid(tweet.userId as string);
  //     const roomId = stringToUuid(tweet.conversationId);

  //     const message = {
  //       id: tweetId,
  //       agentId: this.runtime.agentId,
  //       content: {
  //         text: tweet.text,
  //         url: tweet.permanentUrl,
  //         inReplyTo: tweet.inReplyToStatusId
  //           ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
  //           : undefined,
  //       },
  //       userId: userIdUUID,
  //       roomId,
  //       createdAt: tweet.timestamp * 1000,
  //     };
  //     this.client.saveRequestMessage(message, state);
  //   }

  //   // get usernames into str
  //   const validTargetUsersStr =
  //     this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

  //   const shouldRespondContext = composeContext({
  //     state,
  //     template:
  //       this.runtime.character.templates?.twitterShouldRespondTemplate ||
  //       this.runtime.character?.templates?.shouldRespondTemplate ||
  //       twitterShouldRespondTemplate(validTargetUsersStr),
  //   });

  //   const shouldRespond = await generateShouldRespond({
  //     runtime: this.runtime,
  //     context: shouldRespondContext,
  //     modelClass: ModelClass.MEDIUM,
  //   });

  //   // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
  //   if (shouldRespond !== "RESPOND") {
  //     elizaLogger.log("Not responding to message");
  //     return { text: "Response Decision:", action: shouldRespond };
  //   }

  //   const context = composeContext({
  //     state,
  //     template:
  //       this.runtime.character.templates?.twitterMessageHandlerTemplate ||
  //       this.runtime.character?.templates?.messageHandlerTemplate ||
  //       twitterMessageHandlerTemplate,
  //   });

  //   elizaLogger.debug("Interactions prompt:\n" + context);

  //   const response = await generateMessageResponse({
  //     runtime: this.runtime,
  //     context,
  //     modelClass: ModelClass.LARGE,
  //   });

  //   const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");

  //   const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

  //   response.inReplyTo = stringId;

  //   response.text = removeQuotes(response.text);

  //   if (response.text) {
  //     try {
  //       const callback: HandlerCallback = async (response: Content) => {
  //         const memories = await sendTweet(
  //           this.client,
  //           response,
  //           message.roomId,
  //           this.client.twitterConfig.TWITTER_USERNAME,
  //           tweet.id
  //         );
  //         return memories;
  //       };

  //       const responseMessages = await callback(response);

  //       state = (await this.runtime.updateRecentMessageState(state)) as State;

  //       for (const responseMessage of responseMessages) {
  //         if (
  //           responseMessage === responseMessages[responseMessages.length - 1]
  //         ) {
  //           responseMessage.content.action = response.action;
  //         } else {
  //           responseMessage.content.action = "CONTINUE";
  //         }
  //         await this.runtime.messageManager.createMemory(responseMessage);
  //       }

  //       await this.runtime.processActions(
  //         message,
  //         responseMessages,
  //         state,
  //         callback
  //       );

  //       const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

  //       await this.runtime.cacheManager.set(
  //         `twitter/tweet_generation_${tweet.id}.txt`,
  //         responseInfo
  //       );
  //       await wait();
  //     } catch (error) {
  //       elizaLogger.error(`Error sending response tweet: ${error}`);
  //     }
  //   }
  // }

  // async buildConversationThread(
  //   tweet: Tweet,
  //   maxReplies: number = 10
  // ): Promise<Tweet[]> {
  //   const thread: Tweet[] = [];
  //   const visited: Set<string> = new Set();

  //   async function processThread(currentTweet: Tweet, depth: number = 0) {
  //     elizaLogger.log("Processing tweet:", {
  //       id: currentTweet.id,
  //       inReplyToStatusId: currentTweet.inReplyToStatusId,
  //       depth: depth,
  //     });

  //     if (!currentTweet) {
  //       elizaLogger.log("No current tweet found for thread building");
  //       return;
  //     }

  //     if (depth >= maxReplies) {
  //       elizaLogger.log("Reached maximum reply depth", depth);
  //       return;
  //     }

  //     // Handle memory storage
  //     const memory = await this.runtime.messageManager.getMemoryById(
  //       stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
  //     );
  //     if (!memory) {
  //       const roomId = stringToUuid(
  //         currentTweet.conversationId + "-" + this.runtime.agentId
  //       );
  //       const userId = stringToUuid(currentTweet.userId);

  //       await this.runtime.ensureConnection(
  //         userId,
  //         roomId,
  //         currentTweet.username,
  //         currentTweet.name,
  //         "twitter"
  //       );

  //       this.runtime.messageManager.createMemory({
  //         id: stringToUuid(currentTweet.id + "-" + this.runtime.agentId),
  //         agentId: this.runtime.agentId,
  //         content: {
  //           text: currentTweet.text,
  //           source: "twitter",
  //           url: currentTweet.permanentUrl,
  //           inReplyTo: currentTweet.inReplyToStatusId
  //             ? stringToUuid(
  //                 currentTweet.inReplyToStatusId + "-" + this.runtime.agentId
  //               )
  //             : undefined,
  //         },
  //         createdAt: currentTweet.timestamp * 1000,
  //         roomId,
  //         userId:
  //           currentTweet.userId === this.twitterUserId
  //             ? this.runtime.agentId
  //             : stringToUuid(currentTweet.userId),
  //         embedding: getEmbeddingZeroVector(),
  //       });
  //     }

  //     if (visited.has(currentTweet.id)) {
  //       elizaLogger.log("Already visited tweet:", currentTweet.id);
  //       return;
  //     }

  //     visited.add(currentTweet.id);
  //     thread.unshift(currentTweet);

  //     elizaLogger.debug("Current thread state:", {
  //       length: thread.length,
  //       currentDepth: depth,
  //       tweetId: currentTweet.id,
  //     });

  //     if (currentTweet.inReplyToStatusId) {
  //       elizaLogger.log(
  //         "Fetching parent tweet:",
  //         currentTweet.inReplyToStatusId
  //       );
  //       try {
  //         const parentTweet = await this.twitterClient.getTweet(
  //           currentTweet.inReplyToStatusId
  //         );

  //         if (parentTweet) {
  //           elizaLogger.log("Found parent tweet:", {
  //             id: parentTweet.id,
  //             text: parentTweet.text?.slice(0, 50),
  //           });
  //           await processThread(parentTweet, depth + 1);
  //         } else {
  //           elizaLogger.log(
  //             "No parent tweet found for:",
  //             currentTweet.inReplyToStatusId
  //           );
  //         }
  //       } catch (error) {
  //         elizaLogger.log("Error fetching parent tweet:", {
  //           tweetId: currentTweet.inReplyToStatusId,
  //           error,
  //         });
  //       }
  //     } else {
  //       elizaLogger.log("Reached end of reply chain at:", currentTweet.id);
  //     }
  //   }

  //   // Need to bind this context for the inner function
  //   await processThread.bind(this)(tweet, 0);

  //   elizaLogger.debug("Final thread built:", {
  //     totalTweets: thread.length,
  //     tweetIds: thread.map((t) => ({
  //       id: t.id,
  //       text: t.text?.slice(0, 50),
  //     })),
  //   });

  //   return thread;
  // }
}
