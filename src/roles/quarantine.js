import { loadConfig, saveConfig } from "../config.js";

const QUARANTINE_ROLE_NAME = "Quarantined";

export async function getOrCreateQuarantineRole(guild) {
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
      color: 0x2f3136,
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

export async function applyQuarantinePermissions(guild, role) {
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
