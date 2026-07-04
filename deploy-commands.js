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
    .setName("ping")
    .setDescription("Checks if the bot is online.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Shows the list of available commands.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("set-log-channel")
    .setDescription("Sets the server log channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel where logs will be sent.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("test-log")
    .setDescription("Sends a test message to the log channel.")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log("Registering commands...");

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID,
    ),
    { body: commands },
  );

  console.log("Commands registered successfully.");
} catch (error) {
  console.error(error);
}
