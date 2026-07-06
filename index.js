import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";

import fs from "fs";

const CONFIG_FILE = "./config.json";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }

  const data = fs.readFileSync(CONFIG_FILE, "utf8");

  if (!data.trim()) {
    return {};
  }

  return JSON.parse(data);
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const QUARANTINE_ROLE_NAME = "Quarantined";

async function getOrCreateQuarantineRole(guild) {
  const config = loadConfig();
  const guildConfig = config[guild.id] || {};

  let role = null;

  if (guildConfig.quarantineRoleId) {
    role = await guild.roles
      .fetch(guildConfig.quarantineRoleId)
      .catch(() => null);
  }

  if (!role) {
    role = guild.roles.cache.find((r) => r.name === QUARANTINE_ROLE_NAME);
  }

  if (!role) {
    role = await guild.roles.create({
      name: QUARANTINE_ROLE_NAME,
      colors: 0x2f3136,
      permissions: [],
      reason: "Automatic quarantine role for honeypot system.",
    });
  }

  config[guild.id] = {
    ...guildConfig,
    quarantineRoleId: role.id,
  };

  saveConfig(config);

  return role;
}

async function applyQuarantinePermissions(guild, role) {
  const channels = await guild.channels.fetch();

  for (const channel of channels.values()) {
    if (!channel) continue;
    if (channel.isThread?.()) continue;
    if (!channel.permissionOverwrites?.edit) continue;

    await channel.permissionOverwrites
      .edit(
        role.id,
        {
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
          Connect: false,
          Speak: false,
        },
        {
          reason: "Applying quarantine role permissions.",
        },
      )
      .catch((error) => {
        console.error(
          `Could not edit permissions for ${channel.name}:`,
          error.message,
        );
      });
  }
}

async function sendLog(guildId, logData) {
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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`${readyClient.user.tag} is online!`);
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const member = message.member;

  if (member.permissions.has("ManageGuild")) return;

  const config = loadConfig();
  const guildConfig = config[message.guildId];

  if (!guildConfig?.honeypotChannelId) return;

  if (message.channelId !== guildConfig.honeypotChannelId) return;

  let deletedTriggeredMessage = false;

  try {
    await message.delete();
    deletedTriggeredMessage = true;
  } catch (error) {
    console.error("Could not delete honeypot message:", error.message);
  }

  const mode = guildConfig.honeypotMode;

  if (!member) return;

  const reason = "Triggered honeypot channel.";

  await sendLog(message.guild.id, {
    title: "Honeypot Triggered",
    description: `A user sent a message to honeypot channel.`,
    color: 0xe74c3c,
    fields: [
      {
        name: "User",
        value: `${message.author.tag}`,
        inline: true,
      },
      {
        name: "User ID",
        value: `${message.author.id}`,
        inline: true,
      },
      {
        name: "Message Deleted",
        value: deletedTriggeredMessage ? "Yes" : "No",
        inline: true,
      },
    ],
    footer: "Corri Honeypot System",
  });

  try {
    if (mode === "quarantine") {
      let quarantineRole = null;

      if (guildConfig.quarantineRoleId) {
        quarantineRole = await message.guild.roles
          .fetch(guildConfig.quarantineRoleId)
          .catch(() => null);
      }

      if (!quarantineRole) {
        quarantineRole = await getOrCreateQuarantineRole(message.guild);
        await applyQuarantinePermissions(message.guild, quarantineRole);
      }

      await member.roles.add(quarantineRole, reason);
    } else if (mode === "kick") {
      await member.kick(reason);
    } else if (mode === "ban") {
      await member.ban({
        reason,
        deleteMessageSeconds: 60 * 60,
      });
    }
  } catch (error) {
    console.error("Honeypot action failed:", error);

    await sendLog(message.guild.id, {
      title: "Honeypot Action Failed",
      description: "The bot could not apply the selected honeypot action.",
      color: 0xe67e22,
      fields: [
        {
          name: "User",
          value: `${message.author.tag}`,
          inline: true,
        },
        {
          name: "User ID",
          value: `${message.author.id}`,
          inline: true,
        },
        {
          name: "Error",
          value: `\`${error.message}\``,
          inline: true,
        },
      ],
      footer: "Corri Honeypot System",
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;

  console.log("Command received:", commandName);

  try {
    if (commandName === "help") {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("Corri Help Menu")
        .setDescription("Here are the available commands.")
        .addFields(
          {
            name: "/set-log-channel",
            value: "Sets the server log channel",
            inline: false,
          },
          {
            name: "/honeypot",
            value: "Sets the honeypot channel and action mode",
            inline: false,
          },
        )
        .setTimestamp()
        .setFooter({ text: "Corri Bot" });

      await interaction.reply({ embeds: [helpEmbed] });

      await sendLog(interaction.guildId, {
        title: "Command Used",
        description: "`/help` command was used.",
        color: 0x3498db,
        fields: [
          {
            name: "User",
            value: `${interaction.user.tag}`,
            inline: true,
          },
          {
            name: "Channel",
            value: `${interaction.channel}`,
            inline: true,
          },
        ],
        footer: "Corri Log System",
      });
    } else if (commandName === "set-log-channel") {
      const channel = interaction.options.getChannel("channel");

      const config = loadConfig();

      config[interaction.guildId] = {
        ...config[interaction.guildId],
        logChannelId: channel.id,
      };

      saveConfig(config);

      await interaction.reply(`**Log channel** has been set to ${channel}.`);

      const setupEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("Log Channel Set")
        .setDescription(
          "This channel has been selected as the server log channel.",
        )
        .addFields(
          {
            name: "Channel",
            value: `${channel}`,
            inline: true,
          },
          {
            name: "Set By",
            value: `${interaction.user.tag}`,
            inline: true,
          },
        )
        .setTimestamp()
        .setFooter({ text: "Corri Log System" });

      await channel.send({ embeds: [setupEmbed] });
    } else if (commandName === "honeypot") {
      await interaction.deferReply({
        ephemeral: true,
      });

      const channel = interaction.options.getChannel("channel");
      const mode = interaction.options.getString("mode");
      const config = loadConfig();

      let quarantineRole = null;

      if (mode === "quarantine") {
        quarantineRole = await getOrCreateQuarantineRole(interaction.guild);
        await applyQuarantinePermissions(interaction.guild, quarantineRole);
      }

      config[interaction.guildId] = {
        ...config[interaction.guildId],
        honeypotChannelId: channel.id,
        honeypotMode: mode,
        quarantineRoleId:
          quarantineRole?.id || config[interaction.guildId]?.quarantineRoleId,
      };

      saveConfig(config);

      await interaction.editReply({
        content: `Honeypot channel set to ${channel}\nMode: \`${mode}\``,
      });

      const actionText = {
        quarantine: "you will be quarantined",
        kick: "you will be kicked",
        ban: "you will be banned",
      };

      const setupEmbed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle("Honeypot Channel")
        .setDescription(
          `⛔ **CAUTION** ⛔\n\n` +
            `This channel is set as the honeypot channel.\n` +
            `If you send any message to this channel, **${actionText[mode]}**.`,
        )
        .setTimestamp()
        .setFooter({ text: "Corri Honeypot System" });

      await channel.send({ embeds: [setupEmbed] });
    } else {
      await interaction.reply({
        content: "Unknown command.",
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error("Command error:", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "An error occurred while running this command.",
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
