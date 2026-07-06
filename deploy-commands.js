import "dotenv/config";
import {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Shows the list of available commands")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("set-log-channel")
    .setDescription("Sets the server log channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel where logs will be sent")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("honeypot")
    .setDescription("Sets the honeypot channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel where honeypot will be activated")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Mode")
        .setRequired(true)
        .addChoices(
          { name: "Quarantine", value: "quarantine" },
          { name: "Kick", value: "kick" },
          { name: "Ban", value: "ban" },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log("Registering commands...");

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
    body: commands,
  });

  console.log("Commands registered successfully.");
} catch (error) {
  console.error(error);
}
