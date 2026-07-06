import { EmbedBuilder } from "discord.js";
import { client } from "../client.js";
import { loadConfig } from "../config.js";
import { log } from "console";

export async function sendLog(guildId, logData) {
  const config = loadConfig();
  const logChannelId = config[guildId]?.logChannelId;

  if (!logChannelId) {
    return false;
  }

  try {
    const channel = await client.channels.fetch(logChannelId);

    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const embed = new EmbedBuilder()
      .setColor(logData.color || 0x3498db)
      .setTitle(logData.title)
      .setDescription(logData.description)
      .setTimestamp();

    if (logData.fields) {
      embed.addFields(logData.fields);
    }

    if (logData.footer) {
      embed.setFooter({ text: logData.footer });
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error("Log could not be sent:", error);
    return false;
  }
}
