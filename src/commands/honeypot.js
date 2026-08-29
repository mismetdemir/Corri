import { EmbedBuilder } from "discord.js";
import { loadConfig, saveConfig } from "../config.js";
import {
  applyQuarantinePermissions,
  getOrCreateQuarantineRole,
} from "../roles/quarantine.js";

export async function runHoneypotCommand(interaction) {
  const honeypotEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("Corri Help Menu")
    .setDescription(
      "Use these commands to get information about corresponding systems.",
    )
    .addFields(
      {
        name: "/honeypot-set",
        value: "Sets a honeypot channel with selected mode",
        inline: false,
      },
      {
        name: "/honeypot-mode",
        value: "Changes honeypot systems punishment mode",
        inline: false,
      },
      {
        name: "/honeypot-remove",
        value: "Removes the honeypot system",
        inline: false,
      },
    )
    .setTimestamp()
    .setFooter({ text: "Corri Bot" });

  await interaction.reply({ embeds: [honeypotEmbed] });
}
