import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
} from "@discordjs/voice";

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { Innertube } from "youtubei.js";

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const musicSessions = new Map();

const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
const MAX_QUEUE_DISPLAY = 15;
const PREFETCH_BUFFER_BYTES = 512 * 1024;
const PREFETCH_DELAY_MS = 1200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const YT_DLP_BINARY = path.resolve(
  __dirname,
  "../../node_modules/youtube-dl-exec/bin",
  process.platform === "win32"
    ? "yt-dlp.exe"
    : "yt-dlp",
);

let youtubePromise = null;

function getYouTube() {
  if (!youtubePromise) {
    youtubePromise = Innertube.create();
  }

  return youtubePromise;
}

function extractYouTubeVideoId(input) {
  try {
    const url = new URL(input);

    const host = url.hostname
      .replace(/^www\./, "")
      .toLowerCase();

    if (host === "youtu.be") {
      return (
        url.pathname
          .split("/")
          .filter(Boolean)[0] || null
      );
    }

    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com")
    ) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      const parts = url.pathname
        .split("/")
        .filter(Boolean);

      if (
        ["shorts", "live", "embed"].includes(
          parts[0],
        )
      ) {
        return parts[1] || null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function formatDuration(seconds) {
  const value = Number(seconds);

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return "Unknown";
  }

  const totalSeconds =
    Math.floor(value);

  const hours =
    Math.floor(
      totalSeconds / 3600,
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60,
    );

  const remainingSeconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(
      minutes,
    ).padStart(
      2,
      "0",
    )}:${String(
      remainingSeconds,
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
}

async function resolveTrack(
  query,
  requestedBy,
) {
  const youtube =
    await getYouTube();

  let videoId =
    extractYouTubeVideoId(query);

  if (!videoId) {
    const search =
      await youtube.search(
        query,
        {
          type: "video",
        },
      );

    const firstVideo =
      search.videos.find(
        (video) =>
          video.video_id,
      );

    if (!firstVideo) {
      return null;
    }

    videoId =
      firstVideo.video_id;
  }

  const info =
    await youtube.getBasicInfo(
      videoId,
    );

  const basicInfo =
    info.basic_info;

  if (!basicInfo?.title) {
    return null;
  }

  return {
    id: videoId,

    title:
      basicInfo.title,

    url:
      `https://www.youtube.com/watch?v=${videoId}`,

    author:
      basicInfo.author ||
      basicInfo.channel?.name ||
      "Unknown channel",

    duration:
      basicInfo.duration,

    thumbnail:
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,

    requestedBy,
  };
}

function createTrackStream(
  track,
  {
    prefetch = false,
  } = {},
) {
  if (
    !fs.existsSync(
      YT_DLP_BINARY,
    )
  ) {
    throw new Error(
      `yt-dlp binary not found at ${YT_DLP_BINARY}. Run npm install first.`,
    );
  }

  console.log(
    `${prefetch ? "Prefetching" : "Starting"} yt-dlp: ${track.url}`,
  );

  const args = [
    track.url,

    "--output",
    "-",

    "--format",
    "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]",

    "--no-playlist",
    "--quiet",
    "--no-warnings",
  ];

  const ytProcess = spawn(
    YT_DLP_BINARY,
    args,
    {
      windowsHide: true,

      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );

  let intentionallyStopped =
    false;

  let closed = false;

  let errorOutput = "";

  const outputStream =
    prefetch
      ? new PassThrough({
          highWaterMark:
            PREFETCH_BUFFER_BYTES,
        })
      : ytProcess.stdout;

  if (prefetch) {
    ytProcess.stdout.pipe(
      outputStream,
    );
  }

  ytProcess.stderr.on(
    "data",
    (data) => {
      errorOutput +=
        data.toString();
    },
  );

  ytProcess.on(
    "error",
    (error) => {
      if (
        !intentionallyStopped
      ) {
        console.error(
          `yt-dlp process error for ${track.title}:`,
          error,
        );
      }
    },
  );

  ytProcess.on(
    "close",
    (code) => {
      closed = true;

      if (
        intentionallyStopped
      ) {
        console.log(
          `yt-dlp stopped: ${track.title}`,
        );

        return;
      }

      if (code === 0) {
        console.log(
          `yt-dlp finished: ${track.title}`,
        );

        return;
      }

      console.error(
        `yt-dlp exited with code ${code}: ${track.title}`,
      );

      if (
        errorOutput.trim()
      ) {
        console.error(
          errorOutput.trim(),
        );
      }
    },
  );

  const controller = {
    process:
      ytProcess,

    stream:
      outputStream,

    track,

    prefetched:
      prefetch,

    stopped:
      false,

    stop() {
      if (
        controller.stopped ||
        closed
      ) {
        return;
      }

      controller.stopped =
        true;

      intentionallyStopped =
        true;

      console.log(
        `Stopping yt-dlp: ${track.title}`,
      );

      try {
        if (prefetch) {
          ytProcess.stdout.unpipe(
            outputStream,
          );
        }
      } catch {
        // Ignore.
      }

      try {
        outputStream.destroy();
      } catch {
        // Stream may already be closed.
      }

      if (
        outputStream !==
        ytProcess.stdout
      ) {
        try {
          ytProcess.stdout.destroy();
        } catch {
          // Ignore.
        }
      }

      try {
        ytProcess.stderr.destroy();
      } catch {
        // Ignore.
      }

      try {
        ytProcess.kill();
      } catch {
        // Process may already be closed.
      }
    },
  };

  return controller;
}

function buildTrackEmbed(
  track,
  title,
  color = 0x2ecc71,
) {
  return new EmbedBuilder()
    .setColor(color)

    .setTitle(title)

    .setDescription(
      `[${track.title}](${track.url})`,
    )

    .setThumbnail(
      track.thumbnail,
    )

    .addFields(
      {
        name: "Channel",

        value:
          track.author,

        inline: true,
      },

      {
        name: "Duration",

        value:
          formatDuration(
            track.duration,
          ),

        inline: true,
      },

      {
        name:
          "Requested By",

        value:
          `<@${track.requestedBy}>`,

        inline: true,
      },
    )

    .setTimestamp()

    .setFooter({
      text:
        "Corri Music",
    });
}

async function sendSessionMessage(
  session,
  payload,
) {
  try {
    if (
      !session.textChannel
        ?.isTextBased()
    ) {
      return;
    }

    await session.textChannel.send(
      payload,
    );
  } catch (error) {
    console.error(
      "Music message could not be sent:",
      error.message,
    );
  }
}

function stopActiveStream(
  session,
) {
  if (
    !session.activeStream
  ) {
    return;
  }

  const activeStream =
    session.activeStream;

  session.activeStream =
    null;

  activeStream.stop();
}

function stopPrefetchedStream(
  session,
) {
  if (
    session.prefetchTimer
  ) {
    clearTimeout(
      session.prefetchTimer,
    );

    session.prefetchTimer =
      null;
  }

  if (
    !session.prefetched
  ) {
    return;
  }

  const prefetched =
    session.prefetched;

  session.prefetched =
    null;

  prefetched.controller.stop();
}

function getDesiredPrefetchTrack(
  session,
) {
  if (
    !session.current
  ) {
    return (
      session.queue[0] ||
      null
    );
  }

  if (
    session.loopMode ===
    "track"
  ) {
    return session.current;
  }

  if (
    session.queue.length >
    0
  ) {
    return session.queue[0];
  }

  if (
    session.loopMode ===
    "queue"
  ) {
    return session.current;
  }

  return null;
}

function refreshPrefetch(
  session,
) {
  const desiredTrack =
    getDesiredPrefetchTrack(
      session,
    );

  if (!desiredTrack) {
    stopPrefetchedStream(
      session,
    );

    return;
  }

  if (
    session.prefetched
      ?.track.id ===
    desiredTrack.id
  ) {
    return;
  }

  stopPrefetchedStream(
    session,
  );

  try {
    const controller =
      createTrackStream(
        desiredTrack,
        {
          prefetch: true,
        },
      );

    session.prefetched = {
      track:
        desiredTrack,

      controller,
    };

    controller.process.once(
      "close",
      (code) => {
        if (
          code !== 0 &&
          session.prefetched
            ?.controller ===
            controller
        ) {
          session.prefetched =
            null;
        }
      },
    );
  } catch (error) {
    console.error(
      `Could not prefetch ${desiredTrack.title}:`,
      error.message,
    );

    session.prefetched =
      null;
  }
}

function schedulePrefetch(
  session,
  delay =
    PREFETCH_DELAY_MS,
) {
  if (
    session.prefetchTimer
  ) {
    clearTimeout(
      session.prefetchTimer,
    );
  }

  session.prefetchTimer =
    setTimeout(
      () => {
        session.prefetchTimer =
          null;

        refreshPrefetch(
          session,
        );
      },

      delay,
    );
}

function takeTrackStream(
  session,
  track,
) {
  if (
    session.prefetched
      ?.track.id ===
    track.id
  ) {
    const prefetched =
      session.prefetched;

    session.prefetched =
      null;

    console.log(
      `Using prefetched stream: ${track.title}`,
    );

    return prefetched.controller;
  }

  return createTrackStream(
    track,
  );
}

function destroySession(
  guildId,
) {
  const session =
    musicSessions.get(
      guildId,
    );

  if (!session) {
    return;
  }

  if (
    session.idleTimer
  ) {
    clearTimeout(
      session.idleTimer,
    );

    session.idleTimer =
      null;
  }

  session.queue.length =
    0;

  session.current =
    null;

  session.skipRequested =
    false;

  stopPrefetchedStream(
    session,
  );

  stopActiveStream(
    session,
  );

  try {
    session.player.stop(
      true,
    );
  } catch {
    // Player may already be stopped.
  }

  try {
    session.connection.destroy();
  } catch {
    // Connection may already be destroyed.
  }

  musicSessions.delete(
    guildId,
  );
}

function scheduleIdleDisconnect(
  session,
) {
  if (
    session.idleTimer
  ) {
    clearTimeout(
      session.idleTimer,
    );
  }

  session.idleTimer =
    setTimeout(
      () => {
        if (
          !session.current &&
          session.queue
            .length === 0 &&
          session.player
            .state
            .status ===
            AudioPlayerStatus.Idle
        ) {
          console.log(
            "Music queue empty. Leaving voice channel.",
          );

          destroySession(
            session.guildId,
          );
        }
      },

      IDLE_DISCONNECT_MS,
    );
}

async function playNext(
  session,
) {
  if (
    session.isLoading ||
    session.current
  ) {
    return false;
  }

  const nextTrack =
    session.queue.shift();

  if (!nextTrack) {
    stopPrefetchedStream(
      session,
    );

    scheduleIdleDisconnect(
      session,
    );

    return false;
  }

  session.isLoading =
    true;

  session.current =
    nextTrack;

  if (
    session.idleTimer
  ) {
    clearTimeout(
      session.idleTimer,
    );

    session.idleTimer =
      null;
  }

  let trackStream =
    null;

  try {
    console.log(
      `Loading track: ${nextTrack.title}`,
    );

    trackStream =
      takeTrackStream(
        session,
        nextTrack,
      );

    session.activeStream =
      trackStream;

    const resource =
      createAudioResource(
        trackStream.stream,
        {
          inputType:
            StreamType.WebmOpus,

          metadata:
            nextTrack,
        },
      );

    trackStream.process.once(
      "close",
      () => {
        if (
          session.activeStream ===
          trackStream
        ) {
          session.activeStream =
            null;
        }
      },
    );

    session.player.play(
      resource,
    );

    console.log(
      `Player started: ${nextTrack.title}`,
    );

    schedulePrefetch(
      session,
    );

    await sendSessionMessage(
      session,
      {
        embeds: [
          buildTrackEmbed(
            nextTrack,
            "Now Playing",
          ),
        ],
      },
    );

    return true;
  } catch (error) {
    console.error(
      `Could not play ${nextTrack.title}:`,
      error,
    );

    if (
      trackStream &&
      session.activeStream ===
        trackStream
    ) {
      session.activeStream =
        null;

      trackStream.stop();
    }

    session.current =
      null;

    session.isLoading =
      false;

    await sendSessionMessage(
      session,
      {
        content:
          `Could not play **${nextTrack.title}**. Skipping it.`,
      },
    );

    return playNext(
      session,
    );
  } finally {
    session.isLoading =
      false;
  }
}

async function createMusicSession(
  interaction,
  voiceChannel,
) {
  console.log(
    `Connecting to voice channel: ${voiceChannel.name}`,
  );

  const connection =
    joinVoiceChannel({
      channelId:
        voiceChannel.id,

      guildId:
        interaction.guildId,

      adapterCreator:
        interaction.guild
          .voiceAdapterCreator,

      selfDeaf:
        true,
    });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    20_000,
  );

  console.log(
    "Voice connection ready.",
  );

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Pause,
      },
    });

  const subscription =
    connection.subscribe(
      player,
    );

  console.log(
    "Voice subscription:",
    subscription
      ? "OK"
      : "FAILED",
  );

  const session = {
    guildId:
      interaction.guildId,

    voiceChannelId:
      voiceChannel.id,

    textChannel:
      interaction.channel,

    connection,
    player,

    queue: [],

    current:
      null,

    activeStream:
      null,

    prefetched:
      null,

    prefetchTimer:
      null,

    idleTimer:
      null,

    isLoading:
      false,

    skipRequested:
      false,

    /*
     * off   = no loop
     * track = repeat current track
     * queue = repeat entire queue
     */
    loopMode:
      "off",
  };

  player.on(
    "stateChange",

    (
      oldState,
      newState,
    ) => {
      console.log(
        `Audio player: ${oldState.status} -> ${newState.status}`,
      );
    },
  );

  connection.on(
    "stateChange",

    (
      oldState,
      newState,
    ) => {
      console.log(
        `Voice connection: ${oldState.status} -> ${newState.status}`,
      );
    },
  );

  player.on(
    AudioPlayerStatus.Idle,

    () => {
      if (
        !session.current
      ) {
        return;
      }

      const finishedTrack =
        session.current;

      const wasSkipped =
        session.skipRequested;

      session.skipRequested =
        false;

      console.log(
        `${wasSkipped ? "Track skipped" : "Track finished"}: ${finishedTrack.title}`,
      );

      stopActiveStream(
        session,
      );

      session.current =
        null;

      /*
       * /skip must never repeat the skipped track.
       */
      if (!wasSkipped) {
        if (
          session.loopMode ===
          "track"
        ) {
          session.queue.unshift(
            finishedTrack,
          );
        } else if (
          session.loopMode ===
          "queue"
        ) {
          session.queue.push(
            finishedTrack,
          );
        }
      }

      void playNext(
        session,
      );
    },
  );

  player.on(
    "error",

    (error) => {
      console.error(
        "Audio player error:",
        error,
      );

      const failedTrack =
        session.current;

      stopActiveStream(
        session,
      );

      session.current =
        null;

      session.skipRequested =
        false;

      if (
        failedTrack
      ) {
        void sendSessionMessage(
          session,
          {
            content:
              `Playback failed for **${failedTrack.title}**. Skipping it.`,
          },
        );
      }

      void playNext(
        session,
      );
    },
  );

  connection.on(
    VoiceConnectionStatus.Disconnected,

    async () => {
      try {
        await Promise.race([
          entersState(
            connection,

            VoiceConnectionStatus.Signalling,

            5_000,
          ),

          entersState(
            connection,

            VoiceConnectionStatus.Connecting,

            5_000,
          ),
        ]);
      } catch {
        destroySession(
          interaction.guildId,
        );
      }
    },
  );

  musicSessions.set(
    interaction.guildId,
    session,
  );

  return session;
}

async function getVoiceContext(
  interaction,
) {
  const member =
    await interaction.guild.members.fetch(
      interaction.user.id,
    );

  const voiceChannel =
    member.voice.channel;

  if (!voiceChannel) {
    return {
      error:
        "You need to join a voice channel first.",
    };
  }

  const botMember =
    interaction.guild.members.me;

  const permissions =
    voiceChannel.permissionsFor(
      botMember,
    );

  if (
    !permissions?.has(
      PermissionFlagsBits.Connect,
    ) ||
    !permissions?.has(
      PermissionFlagsBits.Speak,
    )
  ) {
    return {
      error:
        "I need Connect and Speak permissions in your voice channel.",
    };
  }

  return {
    voiceChannel,
  };
}

async function getSessionForControl(
  interaction,
) {
  const {
    voiceChannel,
    error,
  } =
    await getVoiceContext(
      interaction,
    );

  if (error) {
    return {
      error,
    };
  }

  const session =
    musicSessions.get(
      interaction.guildId,
    );

  if (!session) {
    return {
      error:
        "I am not playing music right now.",
    };
  }

  if (
    session.voiceChannelId !==
    voiceChannel.id
  ) {
    return {
      error:
        "You need to be in the same voice channel as me.",
    };
  }

  return {
    session,
  };
}

export async function handlePlayCommand(
  interaction,
) {
  await interaction.deferReply();

  const {
    voiceChannel,
    error,
  } =
    await getVoiceContext(
      interaction,
    );

  if (error) {
    await interaction.editReply(
      error,
    );

    return;
  }

  const query =
    interaction.options
      .getString(
        "query",
        true,
      )
      .trim();

  let session =
    musicSessions.get(
      interaction.guildId,
    );

  if (
    session &&
    session.voiceChannelId !==
      voiceChannel.id
  ) {
    await interaction.editReply(
      "I am already playing music in another voice channel.",
    );

    return;
  }

  let track;

  try {
    track =
      await resolveTrack(
        query,
        interaction.user.id,
      );
  } catch (error) {
    console.error(
      "YouTube search error:",
      error,
    );

    await interaction.editReply(
      "I could not search YouTube.",
    );

    return;
  }

  if (!track) {
    await interaction.editReply(
      "I could not find a matching YouTube video.",
    );

    return;
  }

  console.log(
    `Track found: ${track.title}`,
  );

  if (!session) {
    try {
      session =
        await createMusicSession(
          interaction,
          voiceChannel,
        );
    } catch (
      connectionError
    ) {
      console.error(
        "Voice connection failed:",
        connectionError,
      );

      await interaction.editReply(
        "I could not connect to the voice channel.",
      );

      return;
    }
  }

  session.textChannel =
    interaction.channel;

  const shouldStartNow =
    !session.current &&
    !session.isLoading &&
    session.player.state
      .status ===
      AudioPlayerStatus.Idle;

  session.queue.push(
    track,
  );

  if (shouldStartNow) {
    const started =
      await playNext(
        session,
      );

    if (
      !started &&
      !session.current
    ) {
      await interaction.editReply(
        "I found the video, but I could not start its audio stream.",
      );

      return;
    }

    await interaction.editReply({
      embeds: [
        buildTrackEmbed(
          track,
          "Added to Player",
        ),
      ],
    });

    return;
  }

  if (
    session.queue.length ===
    1
  ) {
    schedulePrefetch(
      session,
      250,
    );
  }

  await interaction.editReply({
    embeds: [
      buildTrackEmbed(
        track,
        "Added to Queue",
        0x3498db,
      ).addFields({
        name:
          "Queue Position",

        value:
          `${session.queue.length}`,

        inline:
          true,
      }),
    ],
  });
}

export async function handleSkipCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  if (
    !session.current
  ) {
    await interaction.reply({
      content:
        "There is no song playing right now.",

      ephemeral:
        true,
    });

    return;
  }

  const skippedTrack =
    session.current;

  if (
    session.prefetched
      ?.track.id ===
    skippedTrack.id
  ) {
    stopPrefetchedStream(
      session,
    );
  }

  session.skipRequested =
    true;

  stopActiveStream(
    session,
  );

  session.player.stop(
    true,
  );

  await interaction.reply(
    `⏭️ Skipped **${skippedTrack.title}**.`,
  );
}

export async function handleStopCommand(
  interaction,
) {
  const {
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  destroySession(
    interaction.guildId,
  );

  await interaction.reply(
    "⏹️ Music stopped, queue cleared and voice channel disconnected.",
  );
}

export async function handlePauseCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  if (
    session.player.state
      .status !==
    AudioPlayerStatus.Playing
  ) {
    await interaction.reply({
      content:
        "There is no playing song to pause.",

      ephemeral:
        true,
    });

    return;
  }

  if (
    !session.player.pause()
  ) {
    await interaction.reply({
      content:
        "I could not pause the song.",

      ephemeral:
        true,
    });

    return;
  }

  await interaction.reply(
    `⏸️ Paused **${session.current?.title ?? "current track"}**.`,
  );
}

export async function handleResumeCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  if (
    session.player.state
      .status !==
      AudioPlayerStatus.Paused &&
    session.player.state
      .status !==
      AudioPlayerStatus.AutoPaused
  ) {
    await interaction.reply({
      content:
        "The music is not paused.",

      ephemeral:
        true,
    });

    return;
  }

  if (
    !session.player.unpause()
  ) {
    await interaction.reply({
      content:
        "I could not resume the song.",

      ephemeral:
        true,
    });

    return;
  }

  await interaction.reply(
    `▶️ Resumed **${session.current?.title ?? "current track"}**.`,
  );
}

export async function handleQueueCommand(
  interaction,
) {
  const session =
    musicSessions.get(
      interaction.guildId,
    );

  if (
    !session ||
    (
      !session.current &&
      session.queue.length === 0
    )
  ) {
    await interaction.reply(
      "The music queue is empty.",
    );

    return;
  }

  const parts = [];

  if (
    session.current
  ) {
    parts.push(
      `**Now Playing**\n[${session.current.title}](${session.current.url})`,
    );
  }

  if (
    session.queue.length >
    0
  ) {
    const visibleQueue =
      session.queue.slice(
        0,
        MAX_QUEUE_DISPLAY,
      );

    const queueText =
      visibleQueue
        .map(
          (
            track,
            index,
          ) =>
            `**${index + 1}.** [${track.title}](${track.url}) — ${formatDuration(track.duration)}`,
        )
        .join("\n");

    parts.push(
      `**Up Next**\n${queueText}`,
    );

    if (
      session.queue.length >
      MAX_QUEUE_DISPLAY
    ) {
      parts.push(
        `*...and ${session.queue.length - MAX_QUEUE_DISPLAY} more tracks.*`,
      );
    }
  } else {
    parts.push(
      "*No tracks waiting in queue.*",
    );
  }

  const loopLabels = {
    off:
      "Off",

    track:
      "Current Track",

    queue:
      "Entire Queue",
  };

  const embed =
    new EmbedBuilder()

      .setColor(
        0x3498db,
      )

      .setTitle(
        `Music Queue • ${session.queue.length} waiting`,
      )

      .setDescription(
        parts.join(
          "\n\n",
        ),
      )

      .addFields({
        name:
          "Loop",

        value:
          loopLabels[
            session.loopMode
          ],

        inline:
          true,
      })

      .setFooter({
        text:
          "Corri Music",
      });

  await interaction.reply({
    embeds: [
      embed,
    ],
  });
}

export async function handleNowPlayingCommand(
  interaction,
) {
  const session =
    musicSessions.get(
      interaction.guildId,
    );

  if (
    !session?.current
  ) {
    await interaction.reply({
      content:
        "There is no song playing right now.",

      ephemeral:
        true,
    });

    return;
  }

  const loopLabels = {
    off:
      "Off",

    track:
      "Current Track",

    queue:
      "Entire Queue",
  };

  const embed =
    buildTrackEmbed(
      session.current,
      "Now Playing",
      0x9b59b6,
    ).addFields({
      name:
        "Loop",

      value:
        loopLabels[
          session.loopMode
        ],

      inline:
        true,
    });

  await interaction.reply({
    embeds: [
      embed,
    ],
  });
}

export async function handleRemoveCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  if (
    session.queue.length ===
    0
  ) {
    await interaction.reply({
      content:
        "The queue is empty.",

      ephemeral:
        true,
    });

    return;
  }

  const position =
    interaction.options
      .getInteger(
        "position",
        true,
      );

  if (
    position < 1 ||
    position >
      session.queue.length
  ) {
    await interaction.reply({
      content:
        `Choose a position between **1** and **${session.queue.length}**.`,

      ephemeral:
        true,
    });

    return;
  }

  const [
    removedTrack,
  ] =
    session.queue.splice(
      position - 1,
      1,
    );

  schedulePrefetch(
    session,
    100,
  );

  await interaction.reply(
    `🗑️ Removed **${removedTrack.title}** from the queue.`,
  );
}

export async function handleShuffleCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  if (
    session.queue.length <
    2
  ) {
    await interaction.reply({
      content:
        "There are not enough songs in the queue to shuffle.",

      ephemeral:
        true,
    });

    return;
  }

  for (
    let i =
      session.queue.length -
      1;

    i > 0;

    i -= 1
  ) {
    const j =
      Math.floor(
        Math.random() *
          (i + 1),
      );

    [
      session.queue[i],
      session.queue[j],
    ] = [
      session.queue[j],
      session.queue[i],
    ];
  }

  schedulePrefetch(
    session,
    100,
  );

  await interaction.reply(
    `🔀 Shuffled **${session.queue.length}** queued tracks.`,
  );
}

export async function handleLoopCommand(
  interaction,
) {
  const {
    session,
    error,
  } =
    await getSessionForControl(
      interaction,
    );

  if (error) {
    await interaction.reply({
      content:
        error,

      ephemeral:
        true,
    });

    return;
  }

  const mode =
    interaction.options
      .getString(
        "mode",
        true,
      );

  if (
    ![
      "off",
      "track",
      "queue",
    ].includes(mode)
  ) {
    await interaction.reply({
      content:
        "Invalid loop mode.",

      ephemeral:
        true,
    });

    return;
  }

  session.loopMode =
    mode;

  schedulePrefetch(
    session,
    100,
  );

  const messages = {
    off:
      "🔁 Loop disabled.",

    track:
      "🔂 Current track will repeat.",

    queue:
      "🔁 The entire queue will repeat.",
  };

  await interaction.reply(
    messages[mode],
  );
}