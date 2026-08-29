import "dotenv/config";

import {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

const honeypotModeChoices = [
  {
    name: "Quarantine",
    value: "quarantine",
  },

  {
    name: "Kick",
    value: "kick",
  },

  {
    name: "Ban",
    value: "ban",
  },
];

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "Shows the list of available commands",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription(
      "Plays a YouTube video by name or link",
    )
    .addStringOption(
      (option) =>
        option
          .setName("query")
          .setDescription(
            "Video name or YouTube link",
          )
          .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription(
      "Pauses the current song",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription(
      "Resumes the paused song",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription(
      "Skips the current song",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription(
      "Stops music, clears the queue and leaves voice",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription(
      "Shows the current music queue",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription(
      "Shows the currently playing song",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription(
      "Removes a song from the queue",
    )
    .addIntegerOption(
      (option) =>
        option
          .setName(
            "position",
          )
          .setDescription(
            "Queue position to remove",
          )
          .setMinValue(1)
          .setRequired(
            true,
          ),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription(
      "Shuffles the queued songs",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription(
      "Changes the music loop mode",
    )
    .addStringOption(
      (option) =>
        option
          .setName("mode")
          .setDescription(
            "Loop mode",
          )
          .setRequired(true)
          .addChoices(
            {
              name: "Off",
              value: "off",
            },

            {
              name:
                "Current Track",
              value:
                "track",
            },

            {
              name:
                "Entire Queue",
              value:
                "queue",
            },
          ),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName(
      "set-log-channel",
    )
    .setDescription(
      "Sets the server log channel",
    )
    .addChannelOption(
      (option) =>
        option
          .setName(
            "channel",
          )
          .setDescription(
            "The channel where logs will be sent",
          )
          .addChannelTypes(
            ChannelType.GuildText,
          )
          .setRequired(
            true,
          ),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("honeypot")
    .setDescription(
      "Info about honeypot system and commands",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName(
      "honeypot-set",
    )
    .setDescription(
      "Sets the honeypot channel",
    )
    .addChannelOption(
      (option) =>
        option
          .setName(
            "channel",
          )
          .setDescription(
            "The channel where honeypot will be activated",
          )
          .addChannelTypes(
            ChannelType.GuildText,
          )
          .setRequired(
            true,
          ),
    )
    .addStringOption(
      (option) =>
        option
          .setName("mode")
          .setDescription(
            "Mode",
          )
          .setRequired(true)
          .addChoices(
            ...honeypotModeChoices,
          ),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName(
      "honeypot-mode",
    )
    .setDescription(
      "Changes the honeypot punishment mode",
    )
    .addStringOption(
      (option) =>
        option
          .setName("mode")
          .setDescription(
            "New mode",
          )
          .setRequired(true)
          .addChoices(
            ...honeypotModeChoices,
          ),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName(
      "honeypot-remove",
    )
    .setDescription(
      "Turns off the honeypot system",
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .toJSON(),
];

const rest =
  new REST({
    version: "10",
  }).setToken(
    process.env.DISCORD_TOKEN,
  );

try {
  console.log(
    "Registering commands...",
  );

  await rest.put(
    Routes.applicationCommands(
      process.env.CLIENT_ID,
    ),
    {
      body: commands,
    },
  );

  console.log(
    "Commands registered successfully.",
  );
} catch (error) {
  console.error(error);
}