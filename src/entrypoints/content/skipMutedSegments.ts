import { queryTwitchGql } from "../../utils/twitchGql";
import { findPlaybackMode } from "./playback";
import { publishPlaybackFeedback } from "./playbackFeedback";

import type { FeatureRuntime } from "./featureRuntime";

const RETRY_DELAY_MS = 5_000;
const VIDEO_SELECTOR = '[data-a-target="video-player"] video';
const AD_SELECTOR =
  '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-a-target="ad-countdown-progress-bar"]';
const MUTED_SEGMENTS_OPERATION = "HyperTwitchMutedSegments";
const MUTED_SEGMENTS_QUERY = `query ${MUTED_SEGMENTS_OPERATION}($videoId: ID!) {
  video(id: $videoId) {
    id
    muteInfo {
      mutedSegmentConnection {
        nodes {
          duration
          offset
        }
      }
    }
  }
}`;

interface MutedRange {
  start: number;
  end: number;
}

async function fetchMutedRanges(videoId: string, signal: AbortSignal): Promise<MutedRange[]> {
  const response = await queryTwitchGql(
    {
      operationName: MUTED_SEGMENTS_OPERATION,
      query: MUTED_SEGMENTS_QUERY,
      variables: { videoId },
    },
    signal,
  );

  if (!response.ok) {
    throw new Error(`Unable to fetch muted sections: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: unknown;
    data?: {
      video?: {
        id?: unknown;
        muteInfo?: null | { mutedSegmentConnection?: { nodes?: unknown } };
      };
    };
  } | null;
  const video = body?.data?.video;

  if (!video || video.id !== videoId || body.errors) {
    throw new Error("Unable to fetch muted sections: invalid video metadata");
  }

  if (video.muteInfo === null) {
    return [];
  }

  const nodes = video.muteInfo?.mutedSegmentConnection?.nodes;

  if (!Array.isArray(nodes)) {
    throw new Error("Unable to fetch muted sections: missing segment list");
  }

  const ranges = nodes
    .map((node: unknown) => {
      const segment = node as { offset?: unknown; duration?: unknown } | null;

      if (
        !segment ||
        typeof segment.offset !== "number" ||
        !Number.isFinite(segment.offset) ||
        segment.offset < 0 ||
        typeof segment.duration !== "number" ||
        !Number.isFinite(segment.duration) ||
        segment.duration <= 0 ||
        !Number.isFinite(segment.offset + segment.duration)
      ) {
        throw new Error("Unable to fetch muted sections: invalid segment");
      }

      return { end: segment.offset + segment.duration, start: segment.offset };
    })
    .sort((left, right) => left.start - right.start);
  const merged: MutedRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }

  return merged;
}

export const skipMutedSegmentsRuntime: FeatureRuntime = {
  mount(_ctx, signal) {
    const mode = findPlaybackMode();

    if (mode?.kind !== "vod" || signal.aborted) {
      return () => {};
    }

    const controller = new AbortController();
    let ranges: MutedRange[] = [];
    let retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    const skip = (video: HTMLVideoElement | null) => {
      if (
        controller.signal.aborted ||
        findPlaybackMode()?.key !== mode.key ||
        !video ||
        video !== globalThis.document.querySelector(VIDEO_SELECTOR) ||
        video.closest('[data-a-target="video-player"]')?.querySelector(AD_SELECTOR) ||
        video.paused ||
        video.seeking ||
        video.ended ||
        video.readyState === 0 ||
        !Number.isFinite(video.duration) ||
        video.duration <= 0
      ) {
        return;
      }

      const range = ranges.find(
        ({ start, end }) => start <= video.currentTime && video.currentTime < end,
      );

      if (!range) {
        return;
      }

      const target = Math.min(range.end, video.duration);
      const seconds = target - video.currentTime;

      if (seconds > 0) {
        video.currentTime = target;
        publishPlaybackFeedback({ kind: "mutedSkip", seconds, video });
      }
    };
    const onPlayback = (event: Event) => {
      if (event.target instanceof globalThis.HTMLVideoElement) {
        skip(event.target);
      }
    };
    const load = async () => {
      try {
        const result = await fetchMutedRanges(mode.videoId, controller.signal);

        if (controller.signal.aborted || findPlaybackMode()?.key !== mode.key) {
          return;
        }

        ranges = result;
        skip(globalThis.document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR));
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        console.error("[Hyper Twitch] Unable to load muted sections", error);
        retryTimer = setTimeout(() => void load(), RETRY_DELAY_MS);
      }
    };
    const cleanup = () => {
      controller.abort();
      clearTimeout(retryTimer);
      signal.removeEventListener("abort", cleanup);
    };

    for (const event of ["timeupdate", "playing", "seeked", "loadedmetadata", "durationchange"]) {
      globalThis.document.addEventListener(event, onPlayback, {
        capture: true,
        signal: controller.signal,
      });
    }

    signal.addEventListener("abort", cleanup, { once: true });
    void load();

    return cleanup;
  },
};
