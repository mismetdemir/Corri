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

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import {
  Innertube,
  UniversalCache,
} from "youtubei.js";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PassThrough,
  Readable,
} from "node:stream";
import { fileURLToPath } from "node:url";

const musicSessions = new Map();

console.log(
  "[music] Corri music engine v8 yt-dlp-deno loaded",
);

const IDLE_DISCONNECT_MS =
  2 * 60 * 1000;

const MAX_QUEUE_DISPLAY = 15;

const PREFETCH_BUFFER_BYTES =
  512 * 1024;

const TRACK_CACHE_TTL_MS =
  30 * 60 * 1000;

const TRACK_CACHE_MAX = 100;

const SOURCE_BUFFER_BYTES =
  512 * 1024;

const DIRECT_URL_CACHE_TTL_MS =
  10 * 60 * 1000;

const SOURCE_FIRST_BYTE_TIMEOUT_MS =
  8_000;

const HTTP_RANGE_CHUNK_BYTES =
  8 * 1024 * 1024;

const HTTP_RANGE_RETRIES = 3;

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const YT_DLP_BINARY =
  path.resolve(
    __dirname,
    "../../node_modules/youtube-dl-exec/bin",
    process.platform === "win32"
      ? "yt-dlp.exe"
      : "yt-dlp",
  );

const CACHE_ROOT =
  path.resolve(
    __dirname,
    "../../.cache",
  );

const YT_DLP_CACHE_DIR =
  path.join(
    CACHE_ROOT,
    "yt-dlp",
  );

const YTJS_CACHE_DIR =
  path.join(
    CACHE_ROOT,
    "youtubejs",
  );

fs.mkdirSync(
  YT_DLP_CACHE_DIR,
  {
    recursive: true,
  },
);

fs.mkdirSync(
  YTJS_CACHE_DIR,
  {
    recursive: true,
  },
);

const YTJS_CACHE =
  new UniversalCache(
    true,
    YTJS_CACHE_DIR,
  );

const FORMAT_SELECTOR =
  "251/250/249/bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]";

const YOUTUBE_EXTRACTOR_ARGS =
  "youtube:skip=hls,dash,translated_subs";

let youtubePromise = null;

const trackCache =
  new Map();

const directAudioUrlCache =
  new Map();

function getYouTube() {
  if (!youtubePromise) {
    const startedAt =
      performance.now();

    youtubePromise =
      Innertube.create({
        cache: YTJS_CACHE,
      })
        .then(
          (youtube) => {
            console.log(
              `[music] YouTube.js session ready in ${Math.round(
                performance.now() -
                  startedAt,
              )} ms`,
            );

            return youtube;
          },
        )
        .catch(
          (error) => {
            youtubePromise =
              null;

            throw error;
          },
        );
  }

  return youtubePromise;
}

setImmediate(() => {
  void getYouTube().catch(
    (error) => {
      console.warn(
        "[music] YouTube.js startup initialization failed; /play will retry:",
        error.message,
      );
    },
  );
});

function extractYouTubeVideoId(
  input,
) {
  try {
    const url =
      new URL(input);

    const host =
      url.hostname
        .replace(
          /^www\./,
          "",
        )
        .toLowerCase();

    if (
      host === "youtu.be"
    ) {
      return (
        url.pathname
          .split("/")
          .filter(Boolean)[0] ||
        null
      );
    }

    if (
      host ===
        "youtube.com" ||
      host.endsWith(
        ".youtube.com",
      )
    ) {
      if (
        url.pathname ===
        "/watch"
      ) {
        return url.searchParams.get(
          "v",
        );
      }

      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      if (
        [
          "shorts",
          "live",
          "embed",
        ].includes(
          parts[0],
        )
      ) {
        return (
          parts[1] ||
          null
        );
      }
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeQuery(
  input,
) {
  return input
    .trim()
    .replace(
      /\s+/g,
      " ",
    );
}

function cacheKeyForQuery(
  query,
) {
  const videoId =
    extractYouTubeVideoId(
      query,
    );

  return videoId
    ? `video:${videoId}`
    : `search:${query.toLocaleLowerCase(
        "en-US",
      )}`;
}

function trimTrackCache() {
  while (
    trackCache.size >
    TRACK_CACHE_MAX
  ) {
    const oldestKey =
      trackCache
        .keys()
        .next()
        .value;

    if (!oldestKey) {
      break;
    }

    trackCache.delete(
      oldestKey,
    );
  }
}

function getCachedTrack(
  query,
  requestedBy,
) {
  const key =
    cacheKeyForQuery(
      query,
    );

  const cached =
    trackCache.get(
      key,
    );

  if (!cached) {
    return null;
  }

  if (
    Date.now() -
      cached.cachedAt >
    TRACK_CACHE_TTL_MS
  ) {
    trackCache.delete(
      key,
    );

    return null;
  }

  trackCache.delete(
    key,
  );

  trackCache.set(
    key,
    cached,
  );

  return {
    ...cached.track,

    mediaInfo:
      cached.mediaInfo ||
      null,

    key: randomUUID(),

    query,

    requestedBy,
  };
}

function putCachedTrack(
  query,
  track,
) {
  const key =
    cacheKeyForQuery(
      query,
    );

  trackCache.delete(
    key,
  );

  trackCache.set(
    key,
    {
      cachedAt:
        Date.now(),

      mediaInfo:
        track.mediaInfo ||
        null,

      track: {
        target:
          track.target,

        id:
          track.id,

        title:
          track.title,

        url:
          track.url,

        author:
          track.author,

        duration:
          track.duration,

        thumbnail:
          track.thumbnail,

        metadataResolved:
          true,
      },
    },
  );

  trimTrackCache();
}

async function resolveTrack(
  query,
  requestedBy,
) {
  const cleanQuery =
    normalizeQuery(
      query,
    );

  const cached =
    getCachedTrack(
      cleanQuery,
      requestedBy,
    );

  if (cached) {
    cached.metadataReady =
      Promise.resolve(
        cached,
      );

    console.log(
      `[music] resolver cache hit: ${cached.title}`,
    );

    return cached;
  }

  const startedAt =
    performance.now();

  const youtube =
    await getYouTube();

  let videoId =
    extractYouTubeVideoId(
      cleanQuery,
    );

  let firstVideo =
    null;

  if (!videoId) {
    const search =
      await youtube.search(
        cleanQuery,
        {
          type: "video",
        },
      );

    const videos =
      Array.from(
        search.videos ||
          [],
      );

    firstVideo =
      videos.find(
        (video) =>
          video?.video_id ||
          video?.id,
      );

    if (!firstVideo) {
      return null;
    }

    videoId =
      firstVideo.video_id ||
      firstVideo.id;

    console.log(
      `[music] search "${cleanQuery}" first candidates: ${videos
        .slice(
          0,
          3,
        )
        .map(
          (
            video,
            index,
          ) =>
            `${index + 1}. ${
              video?.title?.toString?.() ||
              video?.title?.text ||
              "Untitled"
            } [${
              video?.video_id ||
              video?.id ||
              "no-id"
            }]`,
        )
        .join(
          " | ",
        )}`,
    );
  }

  const url =
    `https://www.youtube.com/watch?v=${videoId}`;

  const track = {
    key:
      randomUUID(),

    query:
      cleanQuery,

    target:
      url,

    id:
      videoId,

    title:
      firstVideo?.title?.toString?.() ||
      firstVideo?.title?.text ||
      cleanQuery,

    url,

    author:
      firstVideo?.author
        ?.name ||
      firstVideo?.author?.toString?.() ||
      "YouTube",

    duration:
      Number(
        firstVideo
          ?.duration
          ?.seconds,
      ) || null,

    thumbnail:
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,

    requestedBy,

    metadataResolved:
      false,

    mediaInfo:
      null,
  };

  console.log(
    `[music] YouTube candidate resolved in ${Math.round(
      performance.now() -
        startedAt,
    )} ms: ${track.title} [${videoId}]`,
  );

  track.metadataReady =
    (async () => {
      try {
        const metadataStartedAt =
          performance.now();

        const info =
          await youtube.getBasicInfo(
            videoId,
          );

        const basicInfo =
          info.basic_info;

        track.mediaInfo =
          info;

        if (
          basicInfo?.title
        ) {
          track.title =
            basicInfo.title;

          track.author =
            basicInfo.author ||
            basicInfo.channel
              ?.name ||
            track.author ||
            "Unknown channel";

          const durationValue =
            Number(
              basicInfo.duration,
            );

          track.duration =
            Number.isFinite(
              durationValue,
            ) &&
            durationValue > 0
              ? durationValue
              : track.duration;

          track.thumbnail =
            basicInfo.thumbnail?.[0]
              ?.url ||
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

          track.metadataResolved =
            true;

          putCachedTrack(
            cleanQuery,
            track,
          );

          console.log(
            `[music] metadata ready in ${Math.round(
              performance.now() -
                metadataStartedAt,
            )} ms: ${track.title}`,
          );
        }
      } catch (error) {
        console.warn(
          `[music] metadata lookup failed for ${videoId}; continuing with search metadata:`,
          error.message,
        );
      }

      return track;
    })();

  return track;
}

function formatDuration(
  seconds,
) {
  const value =
    Number(seconds);

  if (
    !Number.isFinite(
      value,
    ) ||
    value <= 0
  ) {
    return "Unknown";
  }

  const totalSeconds =
    Math.floor(value);

  const hours =
    Math.floor(
      totalSeconds /
        3600,
    );

  const minutes =
    Math.floor(
      (totalSeconds %
        3600) /
        60,
    );

  const remainingSeconds =
    totalSeconds %
    60;

  if (
    hours > 0
  ) {
    return `${hours}:${String(
      minutes,
    ).padStart(
      2,
      "0",
    )}:${String(
      remainingSeconds,
    ).padStart(
      2,
      "0",
    )}`;
  }

  return `${minutes}:${String(
    remainingSeconds,
  ).padStart(
    2,
    "0",
  )}`;
}

function buildTrackEmbed(
  track,
  title,
  color = 0x2ecc71,
) {
  const embed =
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(
        track.url
          ? `[${track.title}](${track.url})`
          : `**${track.title}**`,
      )
      .addFields(
        {
          name:
            "Channel",

          value:
            track.author ||
            "Unknown",

          inline:
            true,
        },

        {
          name:
            "Duration",

          value:
            formatDuration(
              track.duration,
            ),

          inline:
            true,
        },

        {
          name:
            "Requested By",

          value:
            `<@${track.requestedBy}>`,

          inline:
            true,
        },
      )
      .setTimestamp()
      .setFooter({
        text:
          "Corri Music",
      });

  if (
    track.thumbnail
  ) {
    embed.setThumbnail(
      track.thumbnail,
    );
  }

  return embed;
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

  const startedAt =
    performance.now();

  const outputStream =
    new PassThrough({
      highWaterMark:
        prefetch
          ? PREFETCH_BUFFER_BYTES
          : SOURCE_BUFFER_BYTES,
    });

  const lifecycle =
    new EventEmitter();

  const children =
    new Set();

  let stopped =
    false;

  let lifecycleClosed =
    false;

  let activeSource =
    null;

  let activeFetchController =
    null;

  let firstByteAt =
    null;

  let resolveFirstByte;

  const firstBytePromise =
    new Promise(
      (resolve) => {
        resolveFirstByte =
          resolve;
      },
    );

  const settleFirstByte =
    (value) => {
      if (
        !resolveFirstByte
      ) {
        return;
      }

      resolveFirstByte(
        value,
      );

      resolveFirstByte =
        null;
    };

  const emitClose =
    (code) => {
      if (
        lifecycleClosed
      ) {
        return;
      }

      lifecycleClosed =
        true;

      lifecycle.emit(
        "close",
        code,
      );
    };

  const stopChild =
    (child) => {
      if (
        !child ||
        child.killed
      ) {
        return;
      }

      try {
        child.stdout?.destroy();
      } catch {}

      try {
        child.stderr?.destroy();
      } catch {}

      try {
        child.kill(
          "SIGTERM",
        );
      } catch {}
    };

  const cacheKey =
    track.id ||
    track.target;

  const getCachedDirectUrl =
    () => {
      const cached =
        directAudioUrlCache.get(
          cacheKey,
        );

      if (!cached) {
        return null;
      }

      if (
        cached.expiresAt <=
        Date.now()
      ) {
        directAudioUrlCache.delete(
          cacheKey,
        );

        return null;
      }

      return cached.url;
    };

  const cacheDirectUrl =
    (url) => {
      directAudioUrlCache.set(
        cacheKey,
        {
          url,

          expiresAt:
            Date.now() +
            DIRECT_URL_CACHE_TTL_MS,
        },
      );
    };

  const invalidateDirectUrl =
    () => {
      directAudioUrlCache.delete(
        cacheKey,
      );
    };

  const pipePlayableSource =
    (
      nodeStream,
      sourceName,
      sourceStartedAt,
    ) =>
      new Promise(
        (
          resolve,
          reject,
        ) => {
          if (stopped) {
            try {
              nodeStream.destroy();
            } catch {}

            reject(
              new Error(
                "Stream stopped",
              ),
            );

            return;
          }

          activeSource =
            nodeStream;

          let sawFirstByte =
            false;

          let startupSettled =
            false;

          const clearStartupTimer =
            () => {
              if (
                startupTimer
              ) {
                clearTimeout(
                  startupTimer,
                );
              }
            };

          const detachFailedSource =
            () => {
              try {
                nodeStream.unpipe(
                  outputStream,
                );
              } catch {}

              if (
                activeSource ===
                nodeStream
              ) {
                activeSource =
                  null;
              }

              try {
                nodeStream.destroy();
              } catch {}
            };

          const rejectBeforePlayback =
            (error) => {
              if (
                startupSettled
              ) {
                return;
              }

              startupSettled =
                true;

              clearStartupTimer();

              detachFailedSource();

              reject(
                error,
              );
            };

          const startupTimer =
            setTimeout(
              () => {
                if (
                  sawFirstByte ||
                  stopped
                ) {
                  return;
                }

                rejectBeforePlayback(
                  new Error(
                    `${sourceName} produced no audio within ${SOURCE_FIRST_BYTE_TIMEOUT_MS} ms`,
                  ),
                );
              },
              SOURCE_FIRST_BYTE_TIMEOUT_MS,
            );

          nodeStream.once(
            "data",
            () => {
              if (stopped) {
                return;
              }

              sawFirstByte =
                true;

              firstByteAt =
                performance.now();

              const totalElapsedMs =
                Math.round(
                  firstByteAt -
                    startedAt,
                );

              const sourceElapsedMs =
                Math.round(
                  firstByteAt -
                    sourceStartedAt,
                );

              console.log(
                `[music] audio first byte: ${totalElapsedMs} ms total / ${sourceElapsedMs} ms source (${sourceName}, ${track.title})`,
              );

              settleFirstByte({
                ok:
                  true,

                elapsedMs:
                  totalElapsedMs,

                source:
                  sourceName,
              });

              if (
                !startupSettled
              ) {
                startupSettled =
                  true;

                clearStartupTimer();

                resolve();
              }
            },
          );

          nodeStream.on(
            "error",
            (error) => {
              if (stopped) {
                return;
              }

              if (
                !sawFirstByte
              ) {
                rejectBeforePlayback(
                  error,
                );

                return;
              }

              console.error(
                `[music] audio source error (${sourceName}, ${track.title}):`,
                error.message,
              );

              outputStream.destroy(
                error,
              );

              emitClose(
                1,
              );
            },
          );

          nodeStream.on(
            "end",
            () => {
              if (stopped) {
                return;
              }

              if (
                !sawFirstByte
              ) {
                rejectBeforePlayback(
                  new Error(
                    `${sourceName} ended before producing audio`,
                  ),
                );

                return;
              }

              if (
                activeSource ===
                nodeStream
              ) {
                activeSource =
                  null;
              }

              outputStream.end();

              emitClose(
                0,
              );
            },
          );

          nodeStream.pipe(
            outputStream,
            {
              end: false,
            },
          );
        },
      );

  const resolveWithYtDlp =
    () =>
      new Promise(
        (
          resolve,
          reject,
        ) => {
          if (stopped) {
            reject(
              new Error(
                "Stream stopped",
              ),
            );

            return;
          }

          const resolveStartedAt =
            performance.now();

          const name =
            "yt-dlp-deno";

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
            "deno",

            "--remote-components",
            "ejs:npm",

            "--extractor-retries",
            "1",

            "--socket-timeout",
            "8",

            "--extractor-args",
            YOUTUBE_EXTRACTOR_ARGS,

            track.target,
          ];

          console.log(
            `[music] URL resolve start: ${name} (${track.title})`,
          );

          const child =
            spawn(
              YT_DLP_BINARY,
              args,
              {
                windowsHide:
                  true,

                stdio: [
                  "ignore",
                  "pipe",
                  "pipe",
                ],
              },
            );

          children.add(
            child,
          );

          let stdout =
            "";

          let stderr =
            "";

          child.stdout.on(
            "data",
            (data) => {
              stdout +=
                data.toString();

              if (
                stdout.length >
                64 * 1024
              ) {
                stdout =
                  stdout.slice(
                    -64 *
                      1024,
                  );
              }
            },
          );

          child.stderr.on(
            "data",
            (data) => {
              stderr +=
                data.toString();

              if (
                stderr.length >
                64 * 1024
              ) {
                stderr =
                  stderr.slice(
                    -64 *
                      1024,
                  );
              }
            },
          );

          child.on(
            "error",
            (error) => {
              children.delete(
                child,
              );

              reject(
                error,
              );
            },
          );

          child.on(
            "close",
            (code) => {
              children.delete(
                child,
              );

              if (stopped) {
                reject(
                  new Error(
                    "Stream stopped",
                  ),
                );

                return;
              }

              const url =
                stdout
                  .split(
                    /\r?\n/,
                  )
                  .map(
                    (line) =>
                      line.trim(),
                  )
                  .find(
                    (line) =>
                      /^https?:\/\//i.test(
                        line,
                      ),
                  );

              const elapsedMs =
                Math.round(
                  performance.now() -
                    resolveStartedAt,
                );

              if (
                code === 0 &&
                url
              ) {
                console.log(
                  `[music] URL resolved in ${elapsedMs} ms (${track.title})`,
                );

                resolve({
                  url,

                  source:
                    name,

                  elapsedMs,
                });

                return;
              }

              const lastErrorLine =
                stderr
                  .trim()
                  .split(
                    /\r?\n/,
                  )
                  .filter(
                    Boolean,
                  )
                  .at(
                    -1,
                  );

              reject(
                new Error(
                  `${name} exited with code ${code}${
                    lastErrorLine
                      ? `: ${lastErrorLine}`
                      : ""
                  }`,
                ),
              );
            },
          );
        },
      );

  const openDirectStream =
    async (
      url,
      sourceName,
    ) => {
      if (stopped) {
        throw new Error(
          "Stream stopped",
        );
      }

      const fetchController =
        new AbortController();

      activeFetchController =
        fetchController;

      const fetchStartedAt =
        performance.now();

      const resilientSource =
        Readable.from(
          (async function* readRanges() {
            let offset =
              0;

            let totalSize =
              null;

            while (
              !stopped &&
              (
                totalSize ===
                  null ||
                offset <
                  totalSize
              )
            ) {
              const rangeEnd =
                totalSize ===
                null
                  ? offset +
                    HTTP_RANGE_CHUNK_BYTES -
                    1
                  : Math.min(
                      offset +
                        HTTP_RANGE_CHUNK_BYTES -
                        1,

                      totalSize -
                        1,
                    );

              let response =
                null;

              let lastError =
                null;

              for (
                let attempt = 1;
                attempt <=
                HTTP_RANGE_RETRIES;
                attempt += 1
              ) {
                if (stopped) {
                  throw new Error(
                    "Stream stopped",
                  );
                }

                try {
                  response =
                    await fetch(
                      url,
                      {
                        redirect:
                          "follow",

                        signal:
                          fetchController.signal,

                        headers: {
                          "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",

                          Range:
                            `bytes=${offset}-${rangeEnd}`,
                        },
                      },
                    );

                  if (
                    response.status !==
                      200 &&
                    response.status !==
                      206
                  ) {
                    throw new Error(
                      `GoogleVideo returned HTTP ${response.status}`,
                    );
                  }

                  if (
                    !response.body
                  ) {
                    throw new Error(
                      "GoogleVideo returned an empty response body",
                    );
                  }

                  break;
                } catch (
                  error
                ) {
                  lastError =
                    error;

                  response =
                    null;

                  if (
                    attempt <
                      HTTP_RANGE_RETRIES &&
                    !stopped
                  ) {
                    await new Promise(
                      (
                        resolve,
                      ) =>
                        setTimeout(
                          resolve,
                          150 *
                            attempt,
                        ),
                    );
                  }
                }
              }

              if (
                !response
              ) {
                throw (
                  lastError ||
                  new Error(
                    "GoogleVideo request failed",
                  )
                );
              }

              const contentRange =
                response.headers.get(
                  "content-range",
                );

              if (
                contentRange
              ) {
                const match =
                  /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(
                    contentRange,
                  );

                if (
                  match &&
                  match[3] !==
                    "*"
                ) {
                  totalSize =
                    Number(
                      match[3],
                    );
                }
              } else if (
                response.status ===
                200
              ) {
                const contentLength =
                  Number(
                    response.headers.get(
                      "content-length",
                    ),
                  );

                if (
                  Number.isFinite(
                    contentLength,
                  ) &&
                  contentLength >
                    0
                ) {
                  totalSize =
                    offset +
                    contentLength;
                }
              }

              let bytesThisRequest =
                0;

              try {
                const bodyStream =
                  Readable.fromWeb(
                    response.body,
                  );

                for await (
                  const chunk of bodyStream
                ) {
                  if (
                    stopped
                  ) {
                    throw new Error(
                      "Stream stopped",
                    );
                  }

                  const buffer =
                    Buffer.isBuffer(
                      chunk,
                    )
                      ? chunk
                      : Buffer.from(
                          chunk,
                        );

                  bytesThisRequest +=
                    buffer.length;

                  offset +=
                    buffer.length;

                  yield buffer;
                }
              } catch (
                error
              ) {
                if (stopped) {
                  throw new Error(
                    "Stream stopped",
                  );
                }

                console.warn(
                  `[music] HTTP audio range interrupted at byte ${offset}; resuming (${track.title}):`,
                  error.message,
                );

                continue;
              }

              if (
                response.status ===
                200
              ) {
                break;
              }

              if (
                bytesThisRequest ===
                0
              ) {
                throw new Error(
                  "GoogleVideo range request returned zero bytes",
                );
              }

              if (
                totalSize !==
                  null &&
                offset >=
                  totalSize
              ) {
                break;
              }
            }
          })(),

          {
            highWaterMark:
              SOURCE_BUFFER_BYTES,
          },
        );

      try {
        await pipePlayableSource(
          resilientSource,
          sourceName,
          fetchStartedAt,
        );
      } finally {
        if (
          activeFetchController ===
          fetchController
        ) {
          activeFetchController =
            null;
        }
      }
    };

  const startPipeline =
    async () => {
      try {
        const cachedUrl =
          getCachedDirectUrl();

        if (
          cachedUrl
        ) {
          console.log(
            `[music] direct URL cache hit: ${track.title}`,
          );

          try {
            await openDirectStream(
              cachedUrl,
              "direct-url-cache",
            );

            return;
          } catch (
            error
          ) {
            if (stopped) {
              return;
            }

            console.warn(
              `[music] cached direct URL rejected; resolving a fresh URL (${track.title}):`,
              error.message,
            );

            invalidateDirectUrl();
          }
        }

        const resolved =
          await resolveWithYtDlp();

        if (stopped) {
          return;
        }

        cacheDirectUrl(
          resolved.url,
        );

        try {
          await openDirectStream(
            resolved.url,
            resolved.source,
          );

          return;
        } catch (
          error
        ) {
          if (stopped) {
            return;
          }

          invalidateDirectUrl();

          console.warn(
            `[music] fresh URL rejected; resolving once more (${track.title}):`,
            error.message,
          );

          const retry =
            await resolveWithYtDlp();

          if (stopped) {
            return;
          }

          cacheDirectUrl(
            retry.url,
          );

          await openDirectStream(
            retry.url,
            `${retry.source}-retry`,
          );
        }
      } catch (
        error
      ) {
        if (stopped) {
          return;
        }

        console.error(
          `[music] audio pipeline failed (${track.title}):`,
          error.message,
        );

        settleFirstByte({
          ok:
            false,

          elapsedMs:
            Math.round(
              performance.now() -
                startedAt,
            ),
        });

        outputStream.destroy(
          error,
        );

        emitClose(
          1,
        );
      }
    };

  setImmediate(
    () => {
      void startPipeline();
    },
  );

  const controller = {
    process:
      lifecycle,

    stream:
      outputStream,

    track,

    prefetched:
      prefetch,

    stopped:
      false,

    startedAt,

    firstBytePromise,

    get closed() {
      return lifecycleClosed;
    },

    get exitCode() {
      return lifecycleClosed
        ? 0
        : null;
    },

    get firstByteAt() {
      return firstByteAt;
    },

    stop() {
      if (
        controller.stopped
      ) {
        return;
      }

      controller.stopped =
        true;

      stopped =
        true;

      try {
        activeFetchController?.abort();
      } catch {}

      try {
        activeSource?.unpipe(
          outputStream,
        );
      } catch {}

      try {
        activeSource?.destroy();
      } catch {}

      for (
        const child of children
      ) {
        stopChild(
          child,
        );
      }

      children.clear();

      settleFirstByte({
        ok:
          false,

        elapsedMs:
          Math.round(
            performance.now() -
              startedAt,
          ),

        stopped:
          true,
      });

      try {
        outputStream.end();
      } catch {}

      emitClose(
        0,
      );
    },
  };

  return controller;
}

async function sendSessionMessage(
  session,
  payload,
) {
  try {
    if (
      !session.textChannel?.isTextBased()
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

async function safeEditReply(
  interaction,
  payload,
) {
  try {
    await interaction.editReply(
      payload,
    );

    return true;
  } catch (error) {
    console.error(
      `[music] Could not edit interaction reply (${error.code ?? "unknown"}):`,
      error.message,
    );

    return false;
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
      ?.track.key ===
    desiredTrack.key
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
          prefetch:
            true,
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
      `[music] Could not prefetch ${desiredTrack.title}:`,
      error.message,
    );

    session.prefetched =
      null;
  }
}

function schedulePrefetch(
  session,
) {
  if (
    session.prefetchScheduled
  ) {
    return;
  }

  session.prefetchScheduled =
    true;

  setImmediate(
    () => {
      session.prefetchScheduled =
        false;

      refreshPrefetch(
        session,
      );
    },
  );
}

function takeTrackStream(
  session,
  track,
) {
  if (
    session.prefetched
      ?.track.key ===
    track.key
  ) {
    const prefetched =
      session.prefetched;

    session.prefetched =
      null;

    console.log(
      `[music] using prefetched stream: ${track.title}`,
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
  } catch {}

  try {
    session.connection.destroy();
  } catch {}

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
          session.queue.length ===
            0 &&
          session.player.state
            .status ===
            AudioPlayerStatus.Idle
        ) {
          destroySession(
            session.guildId,
          );
        }
      },
      IDLE_DISCONNECT_MS,
    );
}

function playNext(
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

  try {
    const trackStream =
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

    session.isLoading =
      false;

    schedulePrefetch(
      session,
    );

    void Promise.resolve(
      nextTrack.metadataReady,
    )
      .catch(
        () =>
          nextTrack,
      )
      .then(
        () =>
          sendSessionMessage(
            session,
            {
              embeds: [
                buildTrackEmbed(
                  nextTrack,
                  "Now Playing",
                ),
              ],
            },
          ),
      );

    return true;
  } catch (error) {
    console.error(
      `[music] Could not play ${nextTrack.title}:`,
      error,
    );

    stopActiveStream(
      session,
    );

    session.current =
      null;

    session.isLoading =
      false;

    void sendSessionMessage(
      session,
      {
        content:
          `Could not play **${nextTrack.title}**. Skipping it.`,
      },
    );

    return playNext(
      session,
    );
  }
}

function createMusicSession(
  interaction,
  voiceChannel,
) {
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

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Pause,
      },
    });

  connection.subscribe(
    player,
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

    prefetchScheduled:
      false,

    idleTimer:
      null,

    isLoading:
      false,

    skipRequested:
      false,

    loopMode:
      "off",

    commandStartedAt:
      null,
  };

  player.on(
    "stateChange",
    (
      oldState,
      newState,
    ) => {
      console.log(
        `[music] player: ${oldState.status} -> ${newState.status}`,
      );

      if (
        newState.status ===
          AudioPlayerStatus.Playing &&
        session.commandStartedAt !==
          null
      ) {
        console.log(
          `[music] command -> playing: ${Math.round(
            performance.now() -
              session.commandStartedAt,
          )} ms`,
        );

        session.commandStartedAt =
          null;
      }
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

      stopActiveStream(
        session,
      );

      session.current =
        null;

      if (
        !wasSkipped
      ) {
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

      playNext(
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

      playNext(
        session,
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
        `[music] voice: ${oldState.status} -> ${newState.status}`,
      );
    },
  );

  void entersState(
    connection,
    VoiceConnectionStatus.Ready,
    20_000,
  )
    .then(
      () =>
        console.log(
          "[music] voice connection ready",
        ),
    )
    .catch(
      () => {
        if (
          musicSessions.get(
            interaction.guildId,
          ) === session
        ) {
          void sendSessionMessage(
            session,
            {
              content:
                "Voice connection timed out.",
            },
          );

          destroySession(
            interaction.guildId,
          );
        }
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
  let member =
    interaction.member;

  if (
    !member?.voice
  ) {
    member =
      interaction.guild.members.cache.get(
        interaction.user.id,
      );
  }

  if (
    !member?.voice
  ) {
    member =
      await interaction.guild.members.fetch(
        interaction.user.id,
      );
  }

  const voiceChannel =
    member.voice.channel;

  if (
    !voiceChannel
  ) {
    return {
      error:
        "You need to join a voice channel first.",
    };
  }

  const permissions =
    voiceChannel.permissionsFor(
      interaction.guild.members
        .me,
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
  const commandStartedAt =
    performance.now();

  try {
    await interaction.deferReply();
  } catch (error) {
    console.error(
      `[music] Failed to acknowledge /play (${error.code ?? "unknown"}):`,
      error.message,
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

  if (!query) {
    await safeEditReply(
      interaction,
      "Enter a YouTube URL or search query.",
    );

    return;
  }

  let voiceContext;

  try {
    voiceContext =
      await getVoiceContext(
        interaction,
      );
  } catch (error) {
    console.error(
      "[music] Voice context lookup failed:",
      error,
    );

    await safeEditReply(
      interaction,
      "I could not read your voice channel.",
    );

    return;
  }

  const {
    voiceChannel,
    error,
  } =
    voiceContext;

  if (error) {
    await safeEditReply(
      interaction,
      error,
    );

    return;
  }

  let session =
    musicSessions.get(
      interaction.guildId,
    );

  if (
    session &&
    session.voiceChannelId !==
      voiceChannel.id
  ) {
    await safeEditReply(
      interaction,
      "I am already playing music in another voice channel.",
    );

    return;
  }

  const createdNewSession =
    !session;

  if (!session) {
    session =
      createMusicSession(
        interaction,
        voiceChannel,
      );
  }

  session.textChannel =
    interaction.channel;

  let track;

  try {
    track =
      await resolveTrack(
        query,
        interaction.user.id,
      );
  } catch (
    resolveError
  ) {
    console.error(
      "[music] YouTube search failed:",
      resolveError,
    );

    if (
      createdNewSession &&
      !session.current &&
      session.queue.length ===
        0
    ) {
      destroySession(
        interaction.guildId,
      );
    }

    await safeEditReply(
      interaction,
      "I could not search YouTube.",
    );

    return;
  }

  if (!track) {
    if (
      createdNewSession &&
      !session.current &&
      session.queue.length ===
        0
    ) {
      destroySession(
        interaction.guildId,
      );
    }

    await safeEditReply(
      interaction,
      "I could not find a matching YouTube video.",
    );

    return;
  }

  const shouldStartNow =
    !session.current &&
    !session.isLoading &&
    session.player.state
      .status ===
      AudioPlayerStatus.Idle &&
    session.queue.length ===
      0;

  let unownedController =
    null;

  try {
    if (
      shouldStartNow ||
      (
        session.current &&
        session.queue.length ===
          0 &&
        session.loopMode !==
          "track"
      )
    ) {
      unownedController =
        createTrackStream(
          track,
          {
            prefetch:
              true,
          },
        );
    }

    if (
      shouldStartNow
    ) {
      session.commandStartedAt =
        commandStartedAt;
    }

    session.queue.push(
      track,
    );

    if (
      unownedController
    ) {
      stopPrefetchedStream(
        session,
      );

      session.prefetched = {
        track,

        controller:
          unownedController,
      };

      unownedController =
        null;
    }

    if (
      shouldStartNow
    ) {
      const started =
        playNext(
          session,
        );

      if (!started) {
        await safeEditReply(
          interaction,
          "I could not start the audio stream.",
        );

        return;
      }

      await Promise.resolve(
        track.metadataReady,
      ).catch(
        () => track,
      );

      await safeEditReply(
        interaction,
        {
          embeds: [
            buildTrackEmbed(
              track,
              "Added to Player",
            ),
          ],
        },
      );

      return;
    }

    if (
      session.queue.length ===
        1 &&
      !session.prefetched
    ) {
      schedulePrefetch(
        session,
      );
    }

    await Promise.resolve(
      track.metadataReady,
    ).catch(
      () => track,
    );

    await safeEditReply(
      interaction,
      {
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
      },
    );
  } catch (
    playError
  ) {
    unownedController?.stop();

    console.error(
      "Music start failed:",
      playError,
    );

    await safeEditReply(
      interaction,
      "I could not start the YouTube audio stream.",
    );
  }
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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    !session.current
  ) {
    await interaction.reply({
      content:
        "There is no song playing right now.",

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const skippedTrack =
    session.current;

  if (
    session.prefetched
      ?.track.key ===
    skippedTrack.key
  ) {
    stopPrefetchedStream(
      session,
    );
  }

  session.skipRequested =
    true;

  session.commandStartedAt =
    performance.now();

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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  destroySession(
    interaction.guildId,
  );

  await interaction.reply(
    "⏹️ Music stopped.",
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    !session.player.pause()
  ) {
    await interaction.reply({
      content:
        "I could not pause the song.",

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    !session.player.unpause()
  ) {
    await interaction.reply({
      content:
        "I could not resume the song.",

      flags:
        MessageFlags.Ephemeral,
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
      session.queue.length ===
        0
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
      `**Now Playing**\n${
        session.current.url
          ? `[${session.current.title}](${session.current.url})`
          : session.current
              .title
      }`,
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
          ) => {
            const label =
              track.url
                ? `[${track.title}](${track.url})`
                : track.title;

            return `**${index + 1}.** ${label} — ${formatDuration(
              track.duration,
            )}`;
          },
        )
        .join(
          "\n",
        );

    parts.push(
      `**Up Next**\n${queueText}`,
    );

    if (
      session.queue.length >
      MAX_QUEUE_DISPLAY
    ) {
      parts.push(
        `*...and ${
          session.queue.length -
          MAX_QUEUE_DISPLAY
        } more tracks.*`,
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
      .addFields(
        {
          name:
            "Loop",

          value:
            loopLabels[
              session.loopMode
            ],

          inline:
            true,
        },

        {
          name:
            "Prefetch",

          value:
            session.prefetched
              ? `Ready/Preparing: ${session.prefetched.track.title}`
              : "Idle",

          inline:
            true,
        },
      )
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const position =
    interaction.options.getInteger(
      "position",
      true,
    );

  if (
    position <
      1 ||
    position >
      session.queue.length
  ) {
    await interaction.reply({
      content:
        `Choose a position between **1** and **${session.queue.length}**.`,

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
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

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const mode =
    interaction.options.getString(
      "mode",
      true,
    );

  if (
    ![
      "off",
      "track",
      "queue",
    ].includes(
      mode,
    )
  ) {
    await interaction.reply({
      content:
        "Invalid loop mode.",

      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  session.loopMode =
    mode;

  schedulePrefetch(
    session,
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
    messages[
      mode
    ],
  );
}

setImmediate(() => {
  if (
    !fs.existsSync(
      YT_DLP_BINARY,
    )
  ) {
    return;
  }

  try {
    const warmup =
      spawn(
        YT_DLP_BINARY,
        [
          "--version",
        ],
        {
          windowsHide:
            true,

          stdio:
            "ignore",
        },
      );

    warmup.unref();
  } catch {}
});