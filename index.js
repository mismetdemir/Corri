import "dotenv/config";
import { Client, Events, GatewayIntentBits, EmbedBuilder } from "discord.js";

import fs from "fs";

const CONFIG_FILE = "./config.json";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;

  console.log("Command received:", commandName);

  try {
    if (commandName === "ping") {
      await interaction.reply("Pong! The bot is online.");

      await sendLog(interaction.guildId, {
        title: "Command Used",
        description: "`/ping` command was used.",
        color: 0x2ecc71,
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
          {
            name: "User ID",
            value: `${interaction.user.id}`,
            inline: false,
          },
        ],
        footer: "Corri Log System",
      });
    } else if (commandName === "help") {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("Corri Help Menu")
        .setDescription("Here are the available commands.")
        .addFields(
          {
            name: "/ping",
            value: "Checks if the bot is online.",
            inline: false,
          },
          {
            name: "/help",
            value: "Shows this help message.",
            inline: false,
          },
          {
            name: "/set-log-channel",
            value: "Sets the server log channel.",
            inline: false,
          },
          {
            name: "/test-log",
            value: "Sends a test log message.",
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
        logChannelId: channel.id,
      };

      saveConfig(config);

      await interaction.reply(`✅ Log channel has been set to ${channel}.`);

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
    } else if (commandName === "test-log") {
      const logSent = await sendLog(interaction.guildId, {
        title: "Test Log",
        description: "This is a test log message.",
        color: 0x9b59b6,
        fields: [
          {
            name: "Sent By",
            value: `${interaction.user.tag}`,
            inline: true,
          },
          {
            name: "Channel",
            value: `${interaction.channel}`,
            inline: true,
          },
          {
            name: "Status",
            value: "Log system is working correctly.",
            inline: false,
          },
        ],
        footer: "Corri Log System",
      });

      if (logSent) {
        await interaction.reply("✅ Test log sent successfully.");
      } else {
        await interaction.reply({
          content:
            "❌ Log channel is not set or I cannot send messages there. Use `/set-log-channel` first.",
          ephemeral: true,
        });
      }
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
