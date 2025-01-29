import { Api, TelegramClient, sessions } from "telegram";
const { StringSession } = sessions;
import { AgentRuntime, composeContext, elizaLogger, generateText, IAgentRuntime, ModelClass, stringToUuid } from "@elizaos/core";
import readline from "readline";

export class TelegramClientBase {
  private client!: TelegramClient; // <-- `!` weil wir es in `init()` setzen
  private session: any;
  private sessionId: string;
  private messageManager: any;
  private cacheManager: any;

  constructor(private apiId: number, private apiHash: string, private runtime: IAgentRuntime) {
    this.sessionId = `telegram-session-${this.runtime.agentId}`;

    // ✅ Prüfen, ob Message- & CacheManager existieren
    this.messageManager = this.runtime?.messageManager ?? this.runtime?.getMemoryManager ?? null;
    this.cacheManager = this.runtime?.cacheManager || null;

    if (!this.messageManager) {
      throw new Error("❌ Weder `messageManager` noch `memoryManager` existieren!");
    }
    if (!this.cacheManager) {
      throw new Error("❌ cacheManager existiert nicht in runtime!");
    }

    // ✅ Session bleibt erstmal leer (wird in `init()` gesetzt)
    this.session = new StringSession("");
  }

  /** 📡 **Initialisiert den Client & speichert Session nach Login** */
  public async init(): Promise<void> {
    try {

      const savedSession = await this.getStoredSession();
      this.session = new StringSession(savedSession.length > 10 ? savedSession : "");
  
      // ✅ TelegramClient erst JETZT erstellen
      this.client = new TelegramClient(this.session, this.apiId, this.apiHash, {
        connectionRetries: 1,
      });

      // console.log(this.session)

      if (this.session.getAuthKey()) {
        elizaLogger.log("✅ Verwende gespeicherte Telegram-Session.");
        await this.client.connect();
        return;
      }

      elizaLogger.log("⚠️ Keine gespeicherte Session gefunden. Melde an...");

      const phoneNumber = process.env.TELEGRAM_PHONE || "";
      if (!phoneNumber) throw new Error("❌ TELEGRAM_PHONE nicht gesetzt!");

      // ✅ Hol den Code von der Konsole

      console.log(this.runtime)


     
      await this.client.start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => await this.askQuestion("Code eingeben: "),
        password: async () => "",
        onError: (err) => {throw err}
     
      });

      elizaLogger.log("🎉 Login erfolgreich!");

      // ✅ Session speichern (mit `StringSession` geprüft)
      const newSessionString = this.session instanceof StringSession ? this.session.save() : "";
      await this.storeSession(newSessionString);
    } catch (error) {
      console.error("❌ Fehler beim Telegram Scraper:", error);
      throw error
      
    }
  }

/** 🔄 **Liest Nachrichten aus einem Telegram-Kanal und erstellt eine Zusammenfassung** */
/** 🔄 **Liest Nachrichten aus einem Telegram-Kanal und analysiert den Kontext** */
public async fetchLatestMessages(channelUsername: string, limit = 100) {
  try {
      // 📡 Telegram-Entity für den Kanal oder die Gruppe abrufen
      const entity = await this.client.getEntity(channelUsername);

      // 📥 Nachrichten abrufen
      const messages = await this.client.getMessages(entity, { limit, reverse: true });

      // 🔍 Extrahiere Solana-Adressen + Nutzer
      const solanaRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
      const extractedAddresses: { user: string; address: string }[] = [];
      let fullMessageContext = ""; // Hier speichern wir alle Nachrichten für die Analyse

      for (const msg of messages) {
        let user = `ID-${msg.senderId}`; // Fallback zu senderId

        if (msg.sender instanceof Api.User) {
            user = msg.sender.username || msg.sender.firstName || msg.sender.lastName || user;
        }

        // Speichere die vollständige Nachricht für KI-Analyse
        fullMessageContext += `👤 ${user} (${msg.date}): ${msg.message}\n`;

        // Extrahiere Solana-Adressen
        const matches = msg.message?.match(solanaRegex) || [];
        matches.forEach((address) => {
            extractedAddresses.push({ user, address });
        });
      }

      // 📝 Formatierte Solana-Adressen-Liste
      const formattedAddresses = extractedAddresses
          .map(({ user, address }) => `👤 ${user} → ${address}`)
          .join("\n");

      if (extractedAddresses.length === 0) {
          console.log("🚫 Keine Solana-Adressen gefunden.");
      }

      // 🔍 Erstelle den State für die KI
      const state = await this.runtime.composeState({
          userId: this.runtime.agentId,
          roomId: stringToUuid(`telegram_summary_${channelUsername}`),
          agentId: this.runtime.agentId,
          content: { text: fullMessageContext }, // GANZER MESSAGE CONTEXT!
      });

      console.log("-----------------")
      console.log(formattedAddresses)
      console.log("-----------------")

      // 📋 Kontext für die AI-Zusammenfassung
      const context = composeContext({
          state,
          template: `
📢 *Telegram Solana Sentiment Report (${channelUsername})*

🔍 *Extracted Solana Addresses:*
${formattedAddresses || "🚫 No addresses detected."}

📝 *Message Context:*
"${fullMessageContext}"

💡 *Task:*
1️⃣ Identify Solana contract addresses and extract relevant discussions.
2️⃣ Analyze user sentiment related to each contract.
3️⃣ Rank addresses based on popularity, engagement, and sentiment.
4️⃣ Summarize the context for each contract.

✅ *Automatically extracted and formatted for deep analysis.*
          `,
      });

      // ✨ Optional: AI-gestützte Analyse
      const summary = await generateText({
          runtime: this.runtime,
          context,
          modelClass: ModelClass.SMALL, // ggf. Modell anpassen
      });

      // 📤 Konsolenausgabe
      console.log("📢 Sentiment Analysis:", summary);

      return summary;
  } catch (error) {
      console.error("❌ Fehler beim Abrufen der Telegram-Nachrichten:", error);
      return null;
  }
}



  /** 💾 **Speichert die Telegram-Session persistent** */
  private async storeSession(sessionString: string): Promise<void> {
    if (!sessionString || sessionString.length <= 10) {
      elizaLogger.log("❌ Ungültige Session, wird nicht gespeichert.");
      return;
    }

    try {
      if (this.messageManager && typeof this.messageManager.saveMemory === "function") {
        await this.messageManager.saveMemory(this.sessionId, sessionString);
        elizaLogger.log("✅ Session gespeichert in messageManager.");
      } else {
        elizaLogger.log("⚠️ `saveMemory` nicht verfügbar, speichere Session in cacheManager...");
        await this.cacheManager.set(`telegram/${this.sessionId}`, sessionString, {
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        elizaLogger.log("✅ Session gespeichert in cacheManager.");
      }
    } catch (error) {
      elizaLogger.log("❌ Fehler beim Speichern der Session:", error);
    }
  }

/** 📂 **Lädt eine gespeicherte Telegram-Session** */
private async getStoredSession(): Promise<string> {
  let session = "";

  try {
      // 🔍 1️⃣ Zuerst aus dem cacheManager abrufen (da dort gespeichert)
      const cachedSession = await this.cacheManager.get(`telegram/${this.sessionId}`);

      if (typeof cachedSession === "string" && cachedSession.length > 10) {
          session = cachedSession;
      } 

      // 🔍 2️⃣ Falls nichts im cacheManager, versuche messageManager
      if (!session || session.length <= 10) {
          session = await this.messageManager?.getMemoryById(this.sessionId) || "";
      }

      elizaLogger.log("📌 Geladene Session:", session.length > 10 ? "✅ OK" : "❌ Keine gültige Session gefunden.");
  } catch (error) {
      elizaLogger.log("❌ Fehler beim Abrufen der Session:", error);
  }

  return session;
}






  /** ⌨️ **Fragt Nutzer nach einer Eingabe in der Konsole** */
  private async askQuestion(question: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}
