import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const musicSessions = new Map();

const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
const MAX_QUEUE_DISPLAY = 15;
const PREFETCH_BUFFER_BYTES = 512 * 1024;
const METADATA_WAIT_MS = 1_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const YT_DLP_BINARY = path.resolve(
  __dirname,
  "../../node_modules/youtube-dl-exec/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);

// Keep yt-dlp's player/signature cache inside the project so it survives restarts.
const YT_DLP_CACHE_DIR = path.resolve(__dirname, "../../.cache/yt-dlp");
fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true });

// Prefer native YouTube Opus streams. No FFmpeg/transcoding is needed.
const FORMAT_SELECTOR =
  "251/250/249/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]";

// Skip manifests/subtitle work that Corri never uses.
const YOUTUBE_EXTRACTOR_ARGS = "youtube:skip=hls,dash,translated_subs";

// Metadata is written by the SAME yt-dlp process that streams the audio.
// This removes youtubei.js and its extra search/info requests from the critical path.
const METADATA_TEMPLATE =
  "%(.{id,title,webpage_url,uploader,channel,duration,thumbnail})j";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already removed / never created.
  }
}

function isHttpUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");

      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "live", "embed"].includes(parts[0])) {
        return parts[1] || null;
      }
    }
  } catch {
    // Not a URL.
  }

  return null;
}

function createTrack(query, requestedBy) {
  const cleanQuery = query.trim();
  const videoId = extractYouTubeVideoId(cleanQuery);

  return {
    key: randomUUID(),
    query: cleanQuery,
    target: isHttpUrl(cleanQuery) ? cleanQuery : `ytsearch1:${cleanQuery}`,
    id: videoId,
    title: cleanQuery,
    url: videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : isHttpUrl(cleanQuery)
        ? cleanQuery
        : null,
    author: "YouTube",
    duration: null,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
    requestedBy,
    metadataResolved: false,
  };
}

function applyMetadata(track, metadata) {
  if (!metadata || typeof metadata !== "object") return;

  if (metadata.id) track.id = String(metadata.id);
  if (metadata.title) track.title = String(metadata.title);

  if (metadata.webpage_url) {
    track.url = String(metadata.webpage_url);
  } else if (track.id) {
    track.url = `https://www.youtube.com/watch?v=${track.id}`;
  }

  track.author =
    metadata.channel || metadata.uploader || track.author || "Unknown channel";

  const duration = Number(metadata.duration);
  if (Number.isFinite(duration) && duration > 0) track.duration = duration;

  if (metadata.thumbnail) {
    track.thumbnail = String(metadata.thumbnail);
  } else if (track.id) {
    track.thumbnail = `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
  }

  track.metadataResolved = true;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "Unknown";

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function buildTrackEmbed(track, title, color = 0x2ecc71) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(track.url ? `[${track.title}](${track.url})` : `**${track.title}**`)
    .addFields(
      { name: "Channel", value: track.author || "Unknown", inline: true },
      { name: "Duration", value: formatDuration(track.duration), inline: true },
      { name: "Requested By", value: `<@${track.requestedBy}>`, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Corri Music" });

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

async function readMetadataWhenReady(filePath, track, controller) {
  const deadline = Date.now() + 30_000;

  while (!controller.stopped && Date.now() < deadline) {
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      const line = text.trim().split(/\r?\n/).find(Boolean);

      if (line) {
        const metadata = JSON.parse(line);
        applyMetadata(track, metadata);
        safeUnlink(filePath);
        return metadata;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Could not read yt-dlp metadata:", error.message);
        safeUnlink(filePath);
        return null;
      }
    }

    if (controller.closed && controller.exitCode !== null) break;
    await sleep(40);
  }

  safeUnlink(filePath);
  return null;
}

function createTrackStream(track, { prefetch = false } = {}) {
  if (!fs.existsSync(YT_DLP_BINARY)) {
    throw new Error(`yt-dlp binary not found at ${YT_DLP_BINARY}. Run npm install first.`);
  }

  const metadataPath = path.join(os.tmpdir(), `corri-${track.key}.json`);
  safeUnlink(metadataPath);

  const args = [
    "--output",
    "-",
    "--format",
    FORMAT_SELECTOR,
    "--no-playlist",
    "--no-progress",
    "--quiet",
    "--no-warnings",
    "--no-simulate",
    "--cache-dir",
    YT_DLP_CACHE_DIR,
    "--js-runtimes",
    `node:${process.execPath}`,
    "--extractor-args",
    YOUTUBE_EXTRACTOR_ARGS,
    "--print-to-file",
    `before_dl:${METADATA_TEMPLATE}`,
    metadataPath,
    track.target,
  ];

  const startedAt = performance.now();
  console.log(`[music] ${prefetch ? "prefetch" : "stream"} start: ${track.query}`);

  const ytProcess = spawn(YT_DLP_BINARY, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let intentionallyStopped = false;
  let closed = false;
  let exitCode = null;
  let errorOutput = "";
  let firstByteAt = null;

  const outputStream = prefetch
    ? new PassThrough({ highWaterMark: PREFETCH_BUFFER_BYTES })
    : ytProcess.stdout;

  ytProcess.stdout.once("data", () => {
    firstByteAt = performance.now();
    console.log(
      `[music] yt-dlp first audio byte: ${Math.round(firstByteAt - startedAt)} ms (${track.query})`,
    );
  });

  if (prefetch) ytProcess.stdout.pipe(outputStream);

  ytProcess.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  ytProcess.on("error", (error) => {
    if (!intentionallyStopped) {
      console.error(`[music] yt-dlp process error (${track.query}):`, error);
    }
  });

  const controller = {
    process: ytProcess,
    stream: outputStream,
    track,
    prefetched: prefetch,
    stopped: false,
    metadataPath,
    metadataPromise: null,
    startedAt,
    get closed() {
      return closed;
    },
    get exitCode() {
      return exitCode;
    },
    get firstByteAt() {
      return firstByteAt;
    },
    stop() {
      if (controller.stopped) return;

      controller.stopped = true;
      intentionallyStopped = true;

      try {
        if (prefetch) ytProcess.stdout.unpipe(outputStream);
      } catch {
        // Ignore.
      }

      try {
        outputStream.destroy();
      } catch {
        // Ignore.
      }

      if (outputStream !== ytProcess.stdout) {
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

      if (!closed) {
        try {
          ytProcess.kill("SIGTERM");
        } catch {
          // Already closed.
        }
      }

      safeUnlink(metadataPath);
    },
  };

  controller.metadataPromise = readMetadataWhenReady(metadataPath, track, controller);

  ytProcess.on("close", (code) => {
    closed = true;
    exitCode = code;

    if (intentionallyStopped) return;

    if (code !== 0) {
      console.error(`[music] yt-dlp exited with code ${code}: ${track.query}`);
      if (errorOutput.trim()) console.error(errorOutput.trim());
    }
  });

  return controller;
}

async function waitForMetadata(controller, timeoutMs = METADATA_WAIT_MS) {
  if (!controller?.metadataPromise) return;
  await Promise.race([controller.metadataPromise.catch(() => null), sleep(timeoutMs)]);
}

async function sendSessionMessage(session, payload) {
  try {
    if (!session.textChannel?.isTextBased()) return;
    await session.textChannel.send(payload);
  } catch (error) {
    console.error("Music message could not be sent:", error.message);
  }
}

function stopActiveStream(session) {
  if (!session.activeStream) return;
  const activeStream = session.activeStream;
  session.activeStream = null;
  activeStream.stop();
}

function stopPrefetchedStream(session) {
  if (!session.prefetched) return;
  const prefetched = session.prefetched;
  session.prefetched = null;
  prefetched.controller.stop();
}

function getDesiredPrefetchTrack(session) {
  if (!session.current) return session.queue[0] || null;
  if (session.loopMode === "track") return session.current;
  if (session.queue.length > 0) return session.queue[0];
  if (session.loopMode === "queue") return session.current;
  return null;
}

function refreshPrefetch(session) {
  const desiredTrack = getDesiredPrefetchTrack(session);

  if (!desiredTrack) {
    stopPrefetchedStream(session);
    return;
  }

  if (session.prefetched?.track.key === desiredTrack.key) return;

  stopPrefetchedStream(session);

  try {
    const controller = createTrackStream(desiredTrack, { prefetch: true });
    session.prefetched = { track: desiredTrack, controller };

    controller.process.once("close", (code) => {
      if (code !== 0 && session.prefetched?.controller === controller) {
        session.prefetched = null;
      }
    });
  } catch (error) {
    console.error(`[music] Could not prefetch ${desiredTrack.title}:`, error.message);
    session.prefetched = null;
  }
}

function schedulePrefetch(session) {
  // setImmediate keeps this off the current handler stack without adding an artificial delay.
  if (session.prefetchScheduled) return;
  session.prefetchScheduled = true;

  setImmediate(() => {
    session.prefetchScheduled = false;
    refreshPrefetch(session);
  });
}

function takeTrackStream(session, track) {
  if (session.prefetched?.track.key === track.key) {
    const prefetched = session.prefetched;
    session.prefetched = null;
    console.log(`[music] using prefetched stream: ${track.title}`);
    return prefetched.controller;
  }

  return createTrackStream(track);
}

function destroySession(guildId) {
  const session = musicSessions.get(guildId);
  if (!session) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.queue.length = 0;
  session.current = null;
  session.skipRequested = false;

  stopPrefetchedStream(session);
  stopActiveStream(session);

  try {
    session.player.stop(true);
  } catch {
    // Already stopped.
  }

  try {
    session.connection.destroy();
  } catch {
    // Already destroyed.
  }

  musicSessions.delete(guildId);
}

function scheduleIdleDisconnect(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);

  session.idleTimer = setTimeout(() => {
    if (
      !session.current &&
      session.queue.length === 0 &&
      session.player.state.status === AudioPlayerStatus.Idle
    ) {
      destroySession(session.guildId);
    }
  }, IDLE_DISCONNECT_MS);
}

function playNext(session) {
  if (session.isLoading || session.current) return false;

  const nextTrack = session.queue.shift();
  if (!nextTrack) {
    stopPrefetchedStream(session);
    scheduleIdleDisconnect(session);
    return false;
  }

  session.isLoading = true;
  session.current = nextTrack;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  try {
    const trackStream = takeTrackStream(session, nextTrack);
    session.activeStream = trackStream;

    const resource = createAudioResource(trackStream.stream, {
      inputType: StreamType.WebmOpus,
      metadata: nextTrack,
    });

    trackStream.process.once("close", () => {
      if (session.activeStream === trackStream) session.activeStream = null;
    });

    session.player.play(resource);
    session.isLoading = false;

    // Prepare the effective next track immediately.
    schedulePrefetch(session);

    // Metadata should never block audio playback.
    void (async () => {
      await waitForMetadata(trackStream);
      await sendSessionMessage(session, {
        embeds: [buildTrackEmbed(nextTrack, "Now Playing")],
      });
    })();

    return true;
  } catch (error) {
    console.error(`[music] Could not play ${nextTrack.title}:`, error);
    stopActiveStream(session);
    session.current = null;
    session.isLoading = false;

    void sendSessionMessage(session, {
      content: `Could not play **${nextTrack.title}**. Skipping it.`,
    });

    return playNext(session);
  }
}

function createMusicSession(interaction, voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  connection.subscribe(player);

  const session = {
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    textChannel: interaction.channel,
    connection,
    player,
    queue: [],
    current: null,
    activeStream: null,
    prefetched: null,
    prefetchScheduled: false,
    idleTimer: null,
    isLoading: false,
    skipRequested: false,
    loopMode: "off",
    commandStartedAt: null,
  };

  player.on("stateChange", (oldState, newState) => {
    console.log(`[music] player: ${oldState.status} -> ${newState.status}`);

    if (
      newState.status === AudioPlayerStatus.Playing &&
      session.commandStartedAt !== null
    ) {
      console.log(
        `[music] command -> playing: ${Math.round(performance.now() - session.commandStartedAt)} ms`,
      );
      session.commandStartedAt = null;
    }
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (!session.current) return;

    const finishedTrack = session.current;
    const wasSkipped = session.skipRequested;
    session.skipRequested = false;

    stopActiveStream(session);
    session.current = null;

    if (!wasSkipped) {
      if (session.loopMode === "track") {
        session.queue.unshift(finishedTrack);
      } else if (session.loopMode === "queue") {
        session.queue.push(finishedTrack);
      }
    }

    playNext(session);
  });

  player.on("error", (error) => {
    console.error("Audio player error:", error);

    const failedTrack = session.current;
    stopActiveStream(session);
    session.current = null;
    session.skipRequested = false;

    if (failedTrack) {
      void sendSessionMessage(session, {
        content: `Playback failed for **${failedTrack.title}**. Skipping it.`,
      });
    }

    playNext(session);
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[music] voice: ${oldState.status} -> ${newState.status}`);
  });

  // Do not make first playback wait for the Discord voice handshake.
  // Audio can buffer while the connection is becoming ready.
  void entersState(connection, VoiceConnectionStatus.Ready, 20_000)
    .then(() => console.log("[music] voice connection ready"))
    .catch(() => {
      if (musicSessions.get(interaction.guildId) === session) {
        void sendSessionMessage(session, {
          content: "Voice connection timed out.",
        });
        destroySession(interaction.guildId);
      }
    });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(interaction.guildId);
    }
  });

  musicSessions.set(interaction.guildId, session);
  return session;
}

async function getVoiceContext(interaction) {
  // Slash command interactions normally already contain a GuildMember.
  // Avoid a REST fetch unless Discord.js did not hydrate it.
  let member = interaction.member;

  if (!member?.voice) {
    member = interaction.guild.members.cache.get(interaction.user.id);
  }

  if (!member?.voice) {
    member = await interaction.guild.members.fetch(interaction.user.id);
  }

  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    return { error: "You need to join a voice channel first." };
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);

  if (
    !permissions?.has(PermissionFlagsBits.Connect) ||
    !permissions?.has(PermissionFlagsBits.Speak)
  ) {
    return {
      error: "I need Connect and Speak permissions in your voice channel.",
    };
  }

  return { voiceChannel };
}

async function getSessionForControl(interaction) {
  const { voiceChannel, error } = await getVoiceContext(interaction);
  if (error) return { error };

  const session = musicSessions.get(interaction.guildId);
  if (!session) return { error: "I am not playing music right now." };

  if (session.voiceChannelId !== voiceChannel.id) {
    return { error: "You need to be in the same voice channel as me." };
  }

  return { session };
}

export async function handlePlayCommand(interaction) {
  const commandStartedAt = performance.now();
  const deferPromise = interaction.deferReply();

  const query = interaction.options.getString("query", true).trim();
  const { voiceChannel, error } = await getVoiceContext(interaction);

  if (error) {
    await deferPromise;
    await interaction.editReply(error);
    return;
  }

  if (!query) {
    await deferPromise;
    await interaction.editReply("Enter a YouTube URL or search query.");
    return;
  }

  let session = musicSessions.get(interaction.guildId);

  if (session && session.voiceChannelId !== voiceChannel.id) {
    await interaction.editReply("I am already playing music in another voice channel.");
    return;
  }

  const track = createTrack(query, interaction.user.id);
  const shouldStartNow =
    !session ||
    (!session.current &&
      !session.isLoading &&
      session.player.state.status === AudioPlayerStatus.Idle &&
      session.queue.length === 0);

  let preparedController = null;

  try {
    // Start yt-dlp BEFORE doing any voice-ready wait or YouTube metadata lookup.
    // For the first song this makes yt-dlp and Discord voice connection run in parallel.
    if (
      shouldStartNow ||
      (session &&
        session.current &&
        session.queue.length === 0 &&
        session.loopMode !== "track")
    ) {
      preparedController = createTrackStream(track, { prefetch: true });
    }

    if (!session) session = createMusicSession(interaction, voiceChannel);
    session.textChannel = interaction.channel;

    if (shouldStartNow) session.commandStartedAt = commandStartedAt;

    session.queue.push(track);

    if (preparedController) {
      // This is either the track that is about to start, or the first waiting track.
      stopPrefetchedStream(session);
      session.prefetched = { track, controller: preparedController };
    }

    if (shouldStartNow) {
      const started = playNext(session);
      await deferPromise;

      if (!started) {
        await interaction.editReply("I could not start the audio stream.");
        return;
      }

      // Give the same streaming process a brief chance to supply real metadata.
      await waitForMetadata(session.activeStream, 750);

      await interaction.editReply({
        embeds: [buildTrackEmbed(track, "Added to Player")],
      });
      return;
    }

    // If this became queue position #1 and we did not already prepare it, start NOW.
    if (session.queue.length === 1 && !preparedController) schedulePrefetch(session);

    await deferPromise;
    await interaction.editReply({
      embeds: [
        buildTrackEmbed(track, "Added to Queue", 0x3498db).addFields({
          name: "Queue Position",
          value: `${session.queue.length}`,
          inline: true,
        }),
      ],
    });
  } catch (playError) {
    preparedController?.stop();
    console.error("Music start failed:", playError);
    await deferPromise.catch(() => null);
    await interaction.editReply("I could not start the YouTube audio stream.");
  }
}

export async function handleSkipCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  if (!session.current) {
    await interaction.reply({ content: "There is no song playing right now.", ephemeral: true });
    return;
  }

  const skippedTrack = session.current;

  // In track-loop mode the prefetched item can be another copy of the current track.
  // Manual skip must not replay it.
  if (session.prefetched?.track.key === skippedTrack.key) stopPrefetchedStream(session);

  session.skipRequested = true;
  session.commandStartedAt = performance.now();
  stopActiveStream(session);
  session.player.stop(true);

  await interaction.reply(`⏭️ Skipped **${skippedTrack.title}**.`);
}

export async function handleStopCommand(interaction) {
  const { error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  destroySession(interaction.guildId);
  await interaction.reply("⏹️ Music stopped.");
}

export async function handlePauseCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  if (session.player.state.status !== AudioPlayerStatus.Playing) {
    await interaction.reply({ content: "There is no playing song to pause.", ephemeral: true });
    return;
  }

  if (!session.player.pause()) {
    await interaction.reply({ content: "I could not pause the song.", ephemeral: true });
    return;
  }

  await interaction.reply(`⏸️ Paused **${session.current?.title ?? "current track"}**.`);
}

export async function handleResumeCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  if (
    session.player.state.status !== AudioPlayerStatus.Paused &&
    session.player.state.status !== AudioPlayerStatus.AutoPaused
  ) {
    await interaction.reply({ content: "The music is not paused.", ephemeral: true });
    return;
  }

  if (!session.player.unpause()) {
    await interaction.reply({ content: "I could not resume the song.", ephemeral: true });
    return;
  }

  await interaction.reply(`▶️ Resumed **${session.current?.title ?? "current track"}**.`);
}

export async function handleQueueCommand(interaction) {
  const session = musicSessions.get(interaction.guildId);

  if (!session || (!session.current && session.queue.length === 0)) {
    await interaction.reply("The music queue is empty.");
    return;
  }

  const parts = [];

  if (session.current) {
    parts.push(
      `**Now Playing**\n${
        session.current.url
          ? `[${session.current.title}](${session.current.url})`
          : session.current.title
      }`,
    );
  }

  if (session.queue.length > 0) {
    const visibleQueue = session.queue.slice(0, MAX_QUEUE_DISPLAY);
    const queueText = visibleQueue
      .map((track, index) => {
        const label = track.url ? `[${track.title}](${track.url})` : track.title;
        return `**${index + 1}.** ${label} — ${formatDuration(track.duration)}`;
      })
      .join("\n");

    parts.push(`**Up Next**\n${queueText}`);

    if (session.queue.length > MAX_QUEUE_DISPLAY) {
      parts.push(`*...and ${session.queue.length - MAX_QUEUE_DISPLAY} more tracks.*`);
    }
  } else {
    parts.push("*No tracks waiting in queue.*");
  }

  const loopLabels = {
    off: "Off",
    track: "Current Track",
    queue: "Entire Queue",
  };

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Music Queue • ${session.queue.length} waiting`)
    .setDescription(parts.join("\n\n"))
    .addFields(
      { name: "Loop", value: loopLabels[session.loopMode], inline: true },
      {
        name: "Prefetch",
        value: session.prefetched ? `Ready/Preparing: ${session.prefetched.track.title}` : "Idle",
        inline: true,
      },
    )
    .setFooter({ text: "Corri Music" });

  await interaction.reply({ embeds: [embed] });
}

export async function handleNowPlayingCommand(interaction) {
  const session = musicSessions.get(interaction.guildId);

  if (!session?.current) {
    await interaction.reply({ content: "There is no song playing right now.", ephemeral: true });
    return;
  }

  const loopLabels = {
    off: "Off",
    track: "Current Track",
    queue: "Entire Queue",
  };

  const embed = buildTrackEmbed(session.current, "Now Playing", 0x9b59b6).addFields({
    name: "Loop",
    value: loopLabels[session.loopMode],
    inline: true,
  });

  await interaction.reply({ embeds: [embed] });
}

export async function handleRemoveCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  if (session.queue.length === 0) {
    await interaction.reply({ content: "The queue is empty.", ephemeral: true });
    return;
  }

  const position = interaction.options.getInteger("position", true);

  if (position < 1 || position > session.queue.length) {
    await interaction.reply({
      content: `Choose a position between **1** and **${session.queue.length}**.`,
      ephemeral: true,
    });
    return;
  }

  const [removedTrack] = session.queue.splice(position - 1, 1);
  schedulePrefetch(session);

  await interaction.reply(`🗑️ Removed **${removedTrack.title}** from the queue.`);
}

export async function handleShuffleCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  if (session.queue.length < 2) {
    await interaction.reply({
      content: "There are not enough songs in the queue to shuffle.",
      ephemeral: true,
    });
    return;
  }

  for (let i = session.queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [session.queue[i], session.queue[j]] = [session.queue[j], session.queue[i]];
  }

  schedulePrefetch(session);
  await interaction.reply(`🔀 Shuffled **${session.queue.length}** queued tracks.`);
}

export async function handleLoopCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  const mode = interaction.options.getString("mode", true);

  if (!["off", "track", "queue"].includes(mode)) {
    await interaction.reply({ content: "Invalid loop mode.", ephemeral: true });
    return;
  }

  session.loopMode = mode;
  schedulePrefetch(session);

  const messages = {
    off: "🔁 Loop disabled.",
    track: "🔂 Current track will repeat.",
    queue: "🔁 The entire queue will repeat.",
  };

  await interaction.reply(messages[mode]);
}

// Warm the executable into the OS page cache without blocking bot startup.
setImmediate(() => {
  if (!fs.existsSync(YT_DLP_BINARY)) return;

  try {
    const warmup = spawn(YT_DLP_BINARY, ["--version"], {
      windowsHide: true,
      stdio: "ignore",
    });
    warmup.unref();
  } catch {
    // Real playback will surface any binary problem later.
  }
});
