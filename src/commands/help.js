import { EmbedBuilder } from "discord.js";

export async function runHelpCommand(interaction) {
  const helpEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("Corri Help Menu")
    .setDescription(
      "Use these commands to get information about corresponding systems.",
    )
    .addFields(
      {
        name: "/log",
        inline: false,
      },
      {
        name: "/honeypot",
        inline: false,
      },
    )
    .setTimestamp()
    .setFooter({ text: "Corri Bot" });

  await interaction.reply({ embeds: [helpEmbed] });
}
