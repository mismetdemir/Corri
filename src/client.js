import { Client, Events, GatewayIntentBits } from "discord.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],

  presence: {
    status: "invisible",
    activities: [],
  },
});

/*
 * Re-apply invisible presence after Discord marks the client ready.
 * setImmediate lets other synchronous ready handlers finish first.
 */
client.once(Events.ClientReady, (readyClient) => {
  setImmediate(() => {
    readyClient.user.setPresence({
      status: "invisible",
      activities: [],
    });

    console.log("[discord] Presence set to invisible.");
  });
});

/*
 * Discord.js can emit Client "error" events for rejected async event
 * handlers. EventEmitter treats an unhandled "error" as fatal, so always
 * keep a listener and log it instead of letting the whole bot process die.
 */
client.on("error", (error) => {
  console.error("[discord] Client error:", error);
});
