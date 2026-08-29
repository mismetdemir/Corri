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
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { Innertube } from "youtubei.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const musicSessions = new Map();

console.log("[music] Corri music engine v3.2 classic-search loaded");

const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
const MAX_QUEUE_DISPLAY = 15;
const PREFETCH_BUFFER_BYTES = 512 * 1024;
const TRACK_CACHE_TTL_MS = 30 * 60 * 1000;
const TRACK_CACHE_MAX = 100;

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

/*
 * Search/metadata resolution uses YouTube's own internal API through
 * youtubei.js. yt-dlp is then given the exact watch URL instead of doing
 * its own text search.
 *
 * Text search uses a single YouTube request. We intentionally do NOT call
 * getBasicInfo() after search because the search result already contains
 * the metadata Corri needs for the queue embed.
 */
let youtubePromise = null;
const trackCache = new Map();

function getYouTube() {
  if (!youtubePromise) {
    youtubePromise = Innertube.create();
  }

  return youtubePromise;
}

function normalizeQuery(input) {
  return input.trim().replace(/\s+/g, " ");
}

function cacheKeyForQuery(query) {
  const videoId = extractYouTubeVideoId(query);
  return videoId ? `video:${videoId}` : `search:${query.toLocaleLowerCase("en-US")}`;
}

function trimTrackCache() {
  while (trackCache.size > TRACK_CACHE_MAX) {
    const oldestKey = trackCache.keys().next().value;
    if (!oldestKey) break;
    trackCache.delete(oldestKey);
  }
}

function getCachedTrack(query, requestedBy) {
  const key = cacheKeyForQuery(query);
  const cached = trackCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.cachedAt > TRACK_CACHE_TTL_MS) {
    trackCache.delete(key);
    return null;
  }

  trackCache.delete(key);
  trackCache.set(key, cached);

  return {
    ...cached.track,
    key: randomUUID(),
    query,
    requestedBy,
  };
}

function putCachedTrack(query, track) {
  const key = cacheKeyForQuery(query);

  trackCache.delete(key);
  trackCache.set(key, {
    cachedAt: Date.now(),
    track: {
      target: track.target,
      id: track.id,
      title: track.title,
      url: track.url,
      author: track.author,
      duration: track.duration,
      thumbnail: track.thumbnail,
      metadataResolved: true,
    },
  });

  trimTrackCache();
}

function searchVideoToTrack(video, query, requestedBy) {
  const id = video?.id || video?.video_id || video?.endpoint?.payload?.videoId || null;
  if (!id) return null;

  const title =
    video.title?.toString?.() ||
    video.title?.text ||
    String(video.title || query);

  const author =
    video.author?.name ||
    video.author?.title?.toString?.() ||
    video.author?.toString?.() ||
    "Unknown channel";

  const durationValue = Number(
    video.duration?.seconds ??
    video.duration?.text?.split(":").reduce((total, part) => total * 60 + Number(part), 0),
  );
  const duration = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : null;
  const thumbnail =
    video.best_thumbnail?.url ||
    video.thumbnails?.[0]?.url ||
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const url = `https://www.youtube.com/watch?v=${id}`;

  return {
    key: randomUUID(),
    query,
    target: url,
    id,
    title,
    url,
    author,
    duration,
    thumbnail,
    requestedBy,
    metadataResolved: true,
  };
}

function basicInfoToTrack(info, videoId, query, requestedBy) {
  const basic = info?.basic_info || {};
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const durationValue = Number(basic.duration);
  const duration = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : null;

  return {
    key: randomUUID(),
    query,
    target: url,
    id: videoId,
    title: basic.title || "YouTube video",
    url,
    author: basic.author || basic.channel?.name || "Unknown channel",
    duration,
    thumbnail: basic.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    requestedBy,
    metadataResolved: Boolean(basic.title),
  };
}

async function resolveTrack(query, requestedBy) {
  const cleanQuery = normalizeQuery(query);
  const cached = getCachedTrack(cleanQuery, requestedBy);

  if (cached) {
    console.log(`[music] resolver cache hit: ${cached.title}`);
    return cached;
  }

  const startedAt = performance.now();
  const youtube = await getYouTube();

  let videoId = extractYouTubeVideoId(cleanQuery);

  if (!videoId) {
    /*
     * This is the same search strategy Corri used before the aggressive
     * yt-dlp search optimization: YouTube.js chooses the normal YouTube
     * search result, then Corri resolves that exact video.
     */
    const search = await youtube.search(cleanQuery, {
      type: "video",
    });

    const videos = Array.from(search.videos || []);
    const firstVideo = videos[0];

    if (!firstVideo) {
      return null;
    }

    /*
     * Older YouTube.js builds exposed `video_id`; newer builds may expose
     * `id`. This fallback does not change ranking — it only reads the ID
     * from the first result that YouTube.js already selected.
     */
    videoId =
      firstVideo.video_id ||
      firstVideo.id ||
      firstVideo.endpoint?.payload?.videoId ||
      null;

    if (!videoId) {
      console.warn(
        `[music] First YouTube result did not expose a video ID for: ${cleanQuery}`,
      );
      return null;
    }
  }

  /*
   * Keep the old metadata flow too. It costs one extra YouTube request,
   * but it gives reliable title/channel/duration/thumbnail before the
   * queue message is sent.
   */
  const info = await youtube.getBasicInfo(videoId);
  const basicInfo = info.basic_info;

  if (!basicInfo?.title) {
    return null;
  }

  const durationValue = Number(basicInfo.duration);

  const track = {
    key: randomUUID(),
    query: cleanQuery,
    target: `https://www.youtube.com/watch?v=${videoId}`,
    id: videoId,
    title: basicInfo.title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    author:
      basicInfo.author ||
      basicInfo.channel?.name ||
      "Unknown channel",
    duration:
      Number.isFinite(durationValue) && durationValue > 0
        ? durationValue
        : null,
    thumbnail:
      basicInfo.thumbnail?.[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    requestedBy,
    metadataResolved: true,
  };

  putCachedTrack(cleanQuery, track);

  console.log(
    `[music] classic YouTube search resolved in ${Math.round(
      performance.now() - startedAt,
    )} ms: ${track.title} — ${track.author}`,
  );

  return track;
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

function createTrackStream(track, { prefetch = false } = {}) {
  if (!fs.existsSync(YT_DLP_BINARY)) {
    throw new Error(`yt-dlp binary not found at ${YT_DLP_BINARY}. Run npm install first.`);
  }

  // The resolver already chose one exact YouTube video. yt-dlp only extracts
  // and streams that video's native WebM/Opus audio.
  const args = [
    "--output", "-",
    "--format", FORMAT_SELECTOR,
    "--no-playlist",
    "--no-progress",
    "--quiet",
    "--no-warnings",
    "--cache-dir", YT_DLP_CACHE_DIR,
    "--js-runtimes", `node:${process.execPath}`,
    "--extractor-args", YOUTUBE_EXTRACTOR_ARGS,
    track.target,
  ];

  const startedAt = performance.now();
  console.log(`[music] ${prefetch ? "prefetch" : "stream"} start: ${track.title}`);

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
      `[music] yt-dlp first audio byte: ${Math.round(firstByteAt - startedAt)} ms (${track.title})`,
    );
  });

  if (prefetch) ytProcess.stdout.pipe(outputStream);

  ytProcess.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  ytProcess.on("error", (error) => {
    if (!intentionallyStopped) {
      console.error(`[music] yt-dlp process error (${track.title}):`, error);
    }
  });

  const controller = {
    process: ytProcess,
    stream: outputStream,
    track,
    prefetched: prefetch,
    stopped: false,
    startedAt,
    get closed() { return closed; },
    get exitCode() { return exitCode; },
    get firstByteAt() { return firstByteAt; },
    stop() {
      if (controller.stopped) return;
      controller.stopped = true;
      intentionallyStopped = true;

      try {
        if (prefetch) ytProcess.stdout.unpipe(outputStream);
      } catch {}

      try { outputStream.destroy(); } catch {}

      if (outputStream !== ytProcess.stdout) {
        try { ytProcess.stdout.destroy(); } catch {}
      }

      try { ytProcess.stderr.destroy(); } catch {}

      if (!closed) {
        try { ytProcess.kill("SIGTERM"); } catch {}
      }
    },
  };

  ytProcess.on("close", (code) => {
    closed = true;
    exitCode = code;
    if (intentionallyStopped) return;

    if (code !== 0) {
      console.error(`[music] yt-dlp exited with code ${code}: ${track.title}`);
      if (errorOutput.trim()) console.error(errorOutput.trim());
    }
  });

  return controller;
}


async function sendSessionMessage(session, payload) {
  try {
    if (!session.textChannel?.isTextBased()) return;
    await session.textChannel.send(payload);
  } catch (error) {
    console.error("Music message could not be sent:", error.message);
  }
}

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
    return true;
  } catch (error) {
    console.error(
      `[music] Could not edit interaction reply (${error.code ?? "unknown"}):`,
      error.message,
    );
    return false;
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

    // Metadata was resolved before the track entered the queue.
    void sendSessionMessage(session, {
      embeds: [buildTrackEmbed(nextTrack, "Now Playing")],
    });

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

  try {
    await interaction.deferReply();
  } catch (error) {
    console.error(
      `[music] Failed to acknowledge /play (${error.code ?? "unknown"}):`,
      error.message,
    );
    return;
  }

  const query = interaction.options.getString("query", true).trim();
  if (!query) {
    await safeEditReply(interaction, "Enter a YouTube URL or search query.");
    return;
  }

  let voiceContext;
  try {
    voiceContext = await getVoiceContext(interaction);
  } catch (error) {
    console.error("[music] Voice context lookup failed:", error);
    await safeEditReply(interaction, "I could not read your voice channel.");
    return;
  }

  const { voiceChannel, error } = voiceContext;
  if (error) {
    await safeEditReply(interaction, error);
    return;
  }

  let session = musicSessions.get(interaction.guildId);
  if (session && session.voiceChannelId !== voiceChannel.id) {
    await safeEditReply(interaction, "I am already playing music in another voice channel.");
    return;
  }

  // Begin Discord voice negotiation while YouTube search/metadata resolves.
  const createdNewSession = !session;
  if (!session) session = createMusicSession(interaction, voiceChannel);
  session.textChannel = interaction.channel;

  let track;
  try {
    track = await resolveTrack(query, interaction.user.id);
  } catch (resolveError) {
    console.error("[music] YouTube resolve failed:", resolveError);

    if (createdNewSession && !session.current && session.queue.length === 0) {
      destroySession(interaction.guildId);
    }

    await safeEditReply(interaction, "I could not find that video on YouTube.");
    return;
  }

  if (!track) {
    if (createdNewSession && !session.current && session.queue.length === 0) {
      destroySession(interaction.guildId);
    }

    await safeEditReply(interaction, "I could not find a matching YouTube video.");
    return;
  }

  const shouldStartNow =
    !session.current &&
    !session.isLoading &&
    session.player.state.status === AudioPlayerStatus.Idle &&
    session.queue.length === 0;

  let unownedController = null;

  try {
    if (
      shouldStartNow ||
      (session.current && session.queue.length === 0 && session.loopMode !== "track")
    ) {
      unownedController = createTrackStream(track, { prefetch: true });
    }

    if (shouldStartNow) session.commandStartedAt = commandStartedAt;

    session.queue.push(track);

    if (unownedController) {
      stopPrefetchedStream(session);
      session.prefetched = { track, controller: unownedController };
      unownedController = null;
    }

    if (shouldStartNow) {
      const started = playNext(session);
      if (!started) {
        await safeEditReply(interaction, "I could not start the audio stream.");
        return;
      }

      await safeEditReply(interaction, {
        embeds: [buildTrackEmbed(track, "Added to Player")],
      });
      return;
    }

    if (session.queue.length === 1 && !session.prefetched) {
      schedulePrefetch(session);
    }

    await safeEditReply(interaction, {
      embeds: [
        buildTrackEmbed(track, "Added to Queue", 0x3498db).addFields({
          name: "Queue Position",
          value: `${session.queue.length}`,
          inline: true,
        }),
      ],
    });
  } catch (playError) {
    unownedController?.stop();
    console.error("Music start failed:", playError);
    await safeEditReply(interaction, "I could not start the YouTube audio stream.");
  }
}

export async function handleSkipCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  if (!session.current) {
    await interaction.reply({ content: "There is no song playing right now.", flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  destroySession(interaction.guildId);
  await interaction.reply("⏹️ Music stopped.");
}

export async function handlePauseCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  if (session.player.state.status !== AudioPlayerStatus.Playing) {
    await interaction.reply({ content: "There is no playing song to pause.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!session.player.pause()) {
    await interaction.reply({ content: "I could not pause the song.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply(`⏸️ Paused **${session.current?.title ?? "current track"}**.`);
}

export async function handleResumeCommand(interaction) {
  const { session, error } = await getSessionForControl(interaction);

  if (error) {
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  if (
    session.player.state.status !== AudioPlayerStatus.Paused &&
    session.player.state.status !== AudioPlayerStatus.AutoPaused
  ) {
    await interaction.reply({ content: "The music is not paused.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!session.player.unpause()) {
    await interaction.reply({ content: "I could not resume the song.", flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: "There is no song playing right now.", flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  if (session.queue.length === 0) {
    await interaction.reply({ content: "The queue is empty.", flags: MessageFlags.Ephemeral });
    return;
  }

  const position = interaction.options.getInteger("position", true);

  if (position < 1 || position > session.queue.length) {
    await interaction.reply({
      content: `Choose a position between **1** and **${session.queue.length}**.`,
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  if (session.queue.length < 2) {
    await interaction.reply({
      content: "There are not enough songs in the queue to shuffle.",
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    return;
  }

  const mode = interaction.options.getString("mode", true);

  if (!["off", "track", "queue"].includes(mode)) {
    await interaction.reply({ content: "Invalid loop mode.", flags: MessageFlags.Ephemeral });
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
