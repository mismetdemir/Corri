import { EmbedBuilder } from "discord.js";
import { loadConfig, saveConfig } from "../config.js";

export async function runLogCommand(interaction) {
  const logEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("Corri Help Menu")
    .setDescription(
      "Use these commands to get information about corresponding systems.",
    )
    .addFields(
      {
        name: "/log set",
        value: "Sets a log channel",
        inline: false
      },
      {
        name: "/log remove",
        value: "Removes the log system",
        inline: false
      },
      {
        name: "/log level",
        value: "Changes the log level",
        inline: false,
      }
    )
}