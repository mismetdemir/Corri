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
import { Innertube, UniversalCache } from "youtubei.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const musicSessions = new Map();

console.log("[music] Corri music engine v6 direct-url loaded");

const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
const MAX_QUEUE_DISPLAY = 15;
const PREFETCH_BUFFER_BYTES = 512 * 1024;
const TRACK_CACHE_TTL_MS = 30 * 60 * 1000;
const TRACK_CACHE_MAX = 100;
const SOURCE_BUFFER_BYTES = 512 * 1024;
const DIRECT_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const FAST_CLIENT_TIMEOUT_MS = 5_500;
const FAST_CLIENT_DISABLE_MS = 30 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const YT_DLP_BINARY = path.resolve(
  __dirname,
  "../../node_modules/youtube-dl-exec/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);

// Persist both yt-dlp and YouTube.js player/session caches across restarts.
const CACHE_ROOT = path.resolve(__dirname, "../../.cache");
const YT_DLP_CACHE_DIR = path.join(CACHE_ROOT, "yt-dlp");
const YTJS_CACHE_DIR = path.join(CACHE_ROOT, "youtubejs");
fs.mkdirSync(YT_DLP_CACHE_DIR, { recursive: true });
fs.mkdirSync(YTJS_CACHE_DIR, { recursive: true });

const YTJS_CACHE = new UniversalCache(true, YTJS_CACHE_DIR);

// Request only WebM/Opus so Discord can play it without FFmpeg/transcoding.
const FORMAT_SELECTOR =
  "251/250/249/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]";

/*
 * Fast resolver:
 * android_vr currently exposes ordinary downloadable formats without a
 * GVS PO token. We skip requests that are not needed just to obtain the
 * selected audio URL. This is ONLY a fast path; the normal yt-dlp client
 * remains the reliability fallback.
 */
const FAST_YOUTUBE_EXTRACTOR_ARGS =
  "youtube:player_client=android_vr;player_skip=webpage,configs,initial_data;skip=hls,dash,translated_subs";

// Safe path preserves yt-dlp's normal client selection.
const SAFE_YOUTUBE_EXTRACTOR_ARGS =
  "youtube:skip=hls,dash,translated_subs";

/*
 * Search/metadata resolution uses YouTube's own internal API through
 * youtubei.js. yt-dlp is then given the exact watch URL instead of doing
 * its own text search.
 *
 * Text search itself uses one YouTube search request. getBasicInfo() starts
 * afterwards only as a parallel metadata/native-audio path; it never blocks
 * yt-dlp from starting.
 */
let youtubePromise = null;
const trackCache = new Map();
const directAudioUrlCache = new Map();
let fastClientDisabledUntil = 0;

function getYouTube() {
  if (!youtubePromise) {
    const startedAt = performance.now();

    youtubePromise = Innertube.create({
      cache: YTJS_CACHE,
    })
      .then((youtube) => {
        console.log(
          `[music] YouTube.js session ready in ${Math.round(
            performance.now() - startedAt,
          )} ms`,
        );
        return youtube;
      })
      .catch((error) => {
        youtubePromise = null;
        throw error;
      });
  }

  return youtubePromise;
}

// Initialize the real session during bot startup, but do not run fake searches
// or fake audio downloads. Persistent cache does the useful work across restarts.
setImmediate(() => {
  void getYouTube().catch((error) => {
    console.warn(
      "[music] YouTube.js startup initialization failed; /play will retry:",
      error.message,
    );
  });
});

function extractYouTubeVideoId(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "live", "embed"].includes(parts[0])) {
        return parts[1] || null;
      }
    }
  } catch {
    return null;
  }

  return null;
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
    mediaInfo: cached.mediaInfo || null,
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
    mediaInfo: track.mediaInfo || null,
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

async function resolveTrack(query, requestedBy) {
  const cleanQuery = normalizeQuery(query);
  const cached = getCachedTrack(cleanQuery, requestedBy);

  if (cached) {
    cached.metadataReady = Promise.resolve(cached);
    console.log(`[music] resolver cache hit: ${cached.title}`);
    return cached;
  }

  const startedAt = performance.now();
  const youtube = await getYouTube();

  let videoId = extractYouTubeVideoId(cleanQuery);
  let firstVideo = null;

  if (!videoId) {
    /*
     * Keep the exact search strategy from Corri's last known-good build:
     * ask YouTube.js for normal video results and pick the first result
     * that exposes video_id. A modern `id` fallback is only used if the
     * library changes shape; it does not alter the result order.
     */
    const search = await youtube.search(cleanQuery, { type: "video" });

    const videos = Array.from(search.videos || []);

    /*
     * Preserve YouTube's ACTUAL result order.
     *
     * Important: do not do
     *   find(video_id) || find(id)
     * because that can skip an earlier result using `id` and select a later
     * result using `video_id`.
     */
    firstVideo = videos.find(
      (video) => video?.video_id || video?.id,
    );

    if (!firstVideo) {
      return null;
    }

    videoId = firstVideo.video_id || firstVideo.id;

    console.log(
      `[music] search "${cleanQuery}" first candidates: ${videos
        .slice(0, 3)
        .map(
          (video, index) =>
            `${index + 1}. ${video?.title?.toString?.() || video?.title?.text || "Untitled"} [${video?.video_id || video?.id || "no-id"}]`,
        )
        .join(" | ")}`,
    );
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Build a playable candidate immediately after search. This allows
  // yt-dlp prefetch to start while getBasicInfo() resolves in parallel.
  const track = {
    key: randomUUID(),
    query: cleanQuery,
    target: url,
    id: videoId,
    title:
      firstVideo?.title?.toString?.() ||
      firstVideo?.title?.text ||
      cleanQuery,
    url,
    author:
      firstVideo?.author?.name ||
      firstVideo?.author?.toString?.() ||
      "YouTube",
    duration: Number(firstVideo?.duration?.seconds) || null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    requestedBy,
    metadataResolved: false,
    mediaInfo: null,
  };

  console.log(
    `[music] YouTube candidate resolved in ${Math.round(
      performance.now() - startedAt,
    )} ms: ${track.title} [${videoId}]`,
  );

  track.metadataReady = (async () => {
    try {
      const metadataStartedAt = performance.now();
      const info = await youtube.getBasicInfo(videoId);
      const basicInfo = info.basic_info;
      track.mediaInfo = info;

      if (basicInfo?.title) {
        track.title = basicInfo.title;
        track.author =
          basicInfo.author ||
          basicInfo.channel?.name ||
          track.author ||
          "Unknown channel";

        const durationValue = Number(basicInfo.duration);
        track.duration =
          Number.isFinite(durationValue) && durationValue > 0
            ? durationValue
            : track.duration;

        track.thumbnail =
          basicInfo.thumbnail?.[0]?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        track.metadataResolved = true;

        putCachedTrack(cleanQuery, track);

        console.log(
          `[music] metadata ready in ${Math.round(
            performance.now() - metadataStartedAt,
          )} ms: ${track.title}`,
        );
      }
    } catch (error) {
      // Metadata failure must never turn a valid search result into
      // "video not found". The exact URL can still be streamed by yt-dlp.
      console.warn(
        `[music] metadata lookup failed for ${videoId}; continuing with search metadata:`,
        error.message,
      );
    }

    return track;
  })();

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
    throw new Error(
      `yt-dlp binary not found at ${YT_DLP_BINARY}. Run npm install first.`,
    );
  }

  const startedAt = performance.now();

  /*
   * Discord can attach to this immediately. The resolver works behind it,
   * then the signed GoogleVideo URL is streamed directly by Node.
   *
   * This means yt-dlp exits BEFORE the song starts playing and does not sit
   * in the audio data path for the entire track.
   */
  const outputStream = new PassThrough({
    highWaterMark: prefetch ? PREFETCH_BUFFER_BYTES : SOURCE_BUFFER_BYTES,
  });

  const lifecycle = new EventEmitter();
  const children = new Set();

  let stopped = false;
  let lifecycleClosed = false;
  let activeSource = null;
  let activeFetchController = null;
  let firstByteAt = null;
  let resolveFirstByte;

  const firstBytePromise = new Promise((resolve) => {
    resolveFirstByte = resolve;
  });

  const settleFirstByte = (value) => {
    if (!resolveFirstByte) return;
    resolveFirstByte(value);
    resolveFirstByte = null;
  };

  const emitClose = (code) => {
    if (lifecycleClosed) return;
    lifecycleClosed = true;
    lifecycle.emit("close", code);
  };

  const stopChild = (child) => {
    if (!child || child.killed) return;

    try {
      child.stdout?.destroy();
    } catch {}

    try {
      child.stderr?.destroy();
    } catch {}

    try {
      child.kill("SIGTERM");
    } catch {}
  };

  const cacheKey = track.id || track.target;

  const getCachedDirectUrl = () => {
    const cached = directAudioUrlCache.get(cacheKey);

    if (!cached) return null;

    if (cached.expiresAt <= Date.now()) {
      directAudioUrlCache.delete(cacheKey);
      return null;
    }

    return cached.url;
  };

  const cacheDirectUrl = (url) => {
    directAudioUrlCache.set(cacheKey, {
      url,
      expiresAt: Date.now() + DIRECT_URL_CACHE_TTL_MS,
    });
  };

  const invalidateDirectUrl = () => {
    directAudioUrlCache.delete(cacheKey);
  };

  const resolveWithYtDlp = ({ fast }) =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(new Error("Stream stopped"));
        return;
      }

      const extractorArgs = fast
        ? FAST_YOUTUBE_EXTRACTOR_ARGS
        : SAFE_YOUTUBE_EXTRACTOR_ARGS;

      const name = fast ? "android_vr-fast" : "default-safe";
      const resolveStartedAt = performance.now();

      /*
       * yt-dlp only resolves the selected WebM/Opus CDN URL.
       * It does NOT download the song.
       */
      const args = [
        "--get-url",
        "--format",
        FORMAT_SELECTOR,
        "--no-playlist",
        "--no-progress",
        "--quiet",
        "--no-warnings",
        "--force-ipv4",
        "--cache-dir",
        YT_DLP_CACHE_DIR,
        "--js-runtimes",
        `node:${process.execPath}`,
        "--extractor-retries",
        fast ? "0" : "1",
        "--socket-timeout",
        fast ? "5" : "10",
        "--extractor-args",
        extractorArgs,
        track.target,
      ];

      console.log(
        `[music] URL resolve start: ${name} (${track.title})`,
      );

      const child = spawn(YT_DLP_BINARY, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      children.add(child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = fast
        ? setTimeout(() => {
            timedOut = true;
            stopChild(child);
          }, FAST_CLIENT_TIMEOUT_MS)
        : null;

      child.stdout.on("data", (data) => {
        stdout += data.toString();

        // A direct URL is short. Avoid unbounded output on unexpected errors.
        if (stdout.length > 64 * 1024) {
          stdout = stdout.slice(-64 * 1024);
        }
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();

        if (stderr.length > 64 * 1024) {
          stderr = stderr.slice(-64 * 1024);
        }
      });

      child.on("error", (error) => {
        if (timeout) clearTimeout(timeout);
        children.delete(child);
        reject(error);
      });

      child.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        children.delete(child);

        if (stopped) {
          reject(new Error("Stream stopped"));
          return;
        }

        const url = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^https?:\/\//i.test(line));

        const elapsedMs = Math.round(
          performance.now() - resolveStartedAt,
        );

        if (code === 0 && url) {
          console.log(
            `[music] URL resolved via ${name} in ${elapsedMs} ms (${track.title})`,
          );

          resolve({
            url,
            source: name,
            elapsedMs,
          });
          return;
        }

        const reason = timedOut
          ? `timed out after ${FAST_CLIENT_TIMEOUT_MS} ms`
          : `exited with code ${code}`;

        const error = new Error(
          `${name} ${reason}${stderr.trim() ? `: ${stderr.trim().split("\\n").at(-1)}` : ""}`,
        );

        reject(error);
      });
    });

  const openDirectStream = async (url, sourceName) => {
    if (stopped) {
      throw new Error("Stream stopped");
    }

    const fetchController = new AbortController();
    activeFetchController = fetchController;

    const fetchStartedAt = performance.now();

    const response = await fetch(url, {
      redirect: "follow",
      signal: fetchController.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `GoogleVideo returned HTTP ${response.status}`,
      );
    }

    if (stopped) {
      fetchController.abort();
      throw new Error("Stream stopped");
    }

    const nodeStream = Readable.fromWeb(response.body);
    activeSource = nodeStream;

    let sawFirstByte = false;

    nodeStream.once("data", () => {
      if (stopped) return;

      sawFirstByte = true;
      firstByteAt = performance.now();

      const totalElapsedMs = Math.round(
        firstByteAt - startedAt,
      );

      const cdnElapsedMs = Math.round(
        firstByteAt - fetchStartedAt,
      );

      console.log(
        `[music] direct audio first byte: ${totalElapsedMs} ms total / ${cdnElapsedMs} ms CDN (${sourceName}, ${track.title})`,
      );

      settleFirstByte({
        ok: true,
        elapsedMs: totalElapsedMs,
        source: sourceName,
      });
    });

    nodeStream.on("error", (error) => {
      if (stopped) return;

      if (!sawFirstByte) {
        outputStream.destroy(error);
      }

      console.error(
        `[music] direct audio stream error (${track.title}):`,
        error.message,
      );

      emitClose(1);
    });

    nodeStream.on("end", () => {
      if (stopped) return;
      outputStream.end();
      emitClose(0);
    });

    nodeStream.pipe(outputStream, { end: false });
  };

  const startPipeline = async () => {
    try {
      /*
       * 1) A previously resolved signed URL is effectively free.
       */
      const cachedUrl = getCachedDirectUrl();

      if (cachedUrl) {
        console.log(
          `[music] direct URL cache hit: ${track.title}`,
        );

        try {
          await openDirectStream(cachedUrl, "direct-url-cache");
          return;
        } catch (error) {
          if (stopped) return;

          console.warn(
            `[music] cached direct URL rejected; re-resolving (${track.title}):`,
            error.message,
          );

          invalidateDirectUrl();
        }
      }

      let resolved = null;

      /*
       * 2) Try ONE lightweight client. Never race yt-dlp processes on
       * Wispbyte's constrained CPU.
       *
       * If this client fails once, disable it for 30 minutes so following
       * songs do not keep paying the timeout penalty.
       */
      if (Date.now() >= fastClientDisabledUntil) {
        try {
          resolved = await resolveWithYtDlp({ fast: true });
        } catch (error) {
          if (stopped) return;

          fastClientDisabledUntil =
            Date.now() + FAST_CLIENT_DISABLE_MS;

          console.warn(
            `[music] fast yt-dlp disabled for 30 min: ${error.message}`,
          );
        }
      }

      /*
       * 3) Reliable default yt-dlp resolver.
       */
      if (!resolved) {
        resolved = await resolveWithYtDlp({ fast: false });
      }

      if (stopped) return;

      cacheDirectUrl(resolved.url);

      /*
       * 4) Stream the signed CDN URL directly with Node.
       */
      try {
        await openDirectStream(resolved.url, resolved.source);
      } catch (error) {
        if (stopped) return;

        /*
         * A freshly resolved fast-client URL can occasionally be rejected.
         * Retry ONCE with the safe resolver, sequentially, not concurrently.
         */
        invalidateDirectUrl();

        if (resolved.source !== "default-safe") {
          console.warn(
            `[music] fast direct URL rejected; retrying safe resolver: ${error.message}`,
          );

          const safe = await resolveWithYtDlp({ fast: false });

          if (stopped) return;

          cacheDirectUrl(safe.url);
          await openDirectStream(safe.url, safe.source);
          return;
        }

        throw error;
      }
    } catch (error) {
      if (stopped) return;

      console.error(
        `[music] audio pipeline failed (${track.title}):`,
        error.message,
      );

      settleFirstByte({
        ok: false,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      outputStream.destroy(error);
      emitClose(1);
    }
  };

  /*
   * Do not block createAudioResource(). Discord starts buffering immediately
   * while the URL resolver works behind this PassThrough.
   */
  setImmediate(() => {
    void startPipeline();
  });

  const controller = {
    process: lifecycle,
    stream: outputStream,
    track,
    prefetched: prefetch,
    stopped: false,
    startedAt,
    firstBytePromise,

    get closed() {
      return lifecycleClosed;
    },

    get exitCode() {
      return lifecycleClosed ? 0 : null;
    },

    get firstByteAt() {
      return firstByteAt;
    },

    stop() {
      if (controller.stopped) return;

      controller.stopped = true;
      stopped = true;

      try {
        activeFetchController?.abort();
      } catch {}

      try {
        activeSource?.unpipe(outputStream);
      } catch {}

      try {
        activeSource?.destroy();
      } catch {}

      for (const child of children) {
        stopChild(child);
      }

      children.clear();

      settleFirstByte({
        ok: false,
        elapsedMs: Math.round(performance.now() - startedAt),
        stopped: true,
      });

      /*
       * End cleanly rather than destroying the stream. This avoids turning a
       * deliberate /skip into ERR_STREAM_PREMATURE_CLOSE.
       */
      try {
        outputStream.end();
      } catch {}

      emitClose(0);
    },
  };

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

    // Audio starts immediately. The message waits for metadata in parallel
    // so the embed shows the real title/channel/duration when available.
    void Promise.resolve(nextTrack.metadataReady)
      .catch(() => nextTrack)
      .then(() =>
        sendSessionMessage(session, {
          embeds: [buildTrackEmbed(nextTrack, "Now Playing")],
        }),
      );

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

  // Discord must be acknowledged before any network/process work.
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
    await safeEditReply(
      interaction,
      "I am already playing music in another voice channel.",
    );
    return;
  }

  // Start Discord voice negotiation while YouTube search is running.
  const createdNewSession = !session;
  if (!session) {
    session = createMusicSession(interaction, voiceChannel);
  }
  session.textChannel = interaction.channel;

  let track;
  try {
    track = await resolveTrack(query, interaction.user.id);
  } catch (resolveError) {
    console.error("[music] YouTube search failed:", resolveError);

    if (createdNewSession && !session.current && session.queue.length === 0) {
      destroySession(interaction.guildId);
    }

    await safeEditReply(interaction, "I could not search YouTube.");
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
    /*
     * Start yt-dlp as soon as the exact video ID is known. getBasicInfo()
     * continues in track.metadataReady, so metadata latency is hidden behind
     * audio extraction instead of being paid before it.
     */
    if (
      shouldStartNow ||
      (session.current && session.queue.length === 0 && session.loopMode !== "track")
    ) {
      unownedController = createTrackStream(track, { prefetch: true });
    }

    if (shouldStartNow) {
      session.commandStartedAt = commandStartedAt;
    }

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

      // Do not delay playback, but wait for metadata before rendering the
      // command response so title/channel/duration are correct.
      await Promise.resolve(track.metadataReady).catch(() => track);

      await safeEditReply(interaction, {
        embeds: [buildTrackEmbed(track, "Added to Player")],
      });
      return;
    }

    // The first waiting track starts prefetch immediately. If a controller
    // was already created above, schedulePrefetch sees it and does no work.
    if (session.queue.length === 1 && !session.prefetched) {
      schedulePrefetch(session);
    }

    await Promise.resolve(track.metadataReady).catch(() => track);

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
