import { browser, type ContentScriptContext } from "#imports";

import {
  calculateStreamSyncPlaybackRate,
  interpolateArchiveTime,
  interpolateStreamTime,
  isSameStreamSyncTargetLine,
  isStreamSyncAligned,
  projectStreamSyncTarget,
  STREAM_SYNC_SEEK_THRESHOLD_SECONDS,
  streamTimeMessages,
  type StreamTimeRequest,
  type StreamTimeAnchor,
  type StreamTimeSegment,
  type StreamSyncReport,
  type StreamSyncResponse,
} from "../../utils/streamTime/protocol";
import {
  fetchArchiveStart,
  findPlaybackMode,
  type PlaybackMode,
  type VodPlaybackMode,
} from "./playback";
import {
  createSyncButton,
  ensureSyncStyle,
  findViewerCountWrapper,
  renderSyncButton,
  type SyncButtonState,
} from "./streamSyncButton";
import {
  ensureClock,
  findClockPlacement,
  removeClocks,
  renderClock,
  type ClockElements,
} from "./streamTimeClock";

const APPEND_GRACE_MS = 500;
const ARCHIVE_RETRY_MS = 5_000;
const HAVE_FUTURE_DATA = 3;
const HAVE_METADATA = 1;
const MAX_SEGMENT_AGE_MS = 15_000;
const SYNC_CONTROL_INTERVAL_MS = 100;
const SYNC_PLAYBACK_RATE_EPSILON = 0.001;
const SYNC_SEEK_BUFFER_MARGIN_SECONDS = 0.25;
const SYNC_TARGET_MAX_AGE_MS = 2_000;
const UPDATE_INTERVAL_MS = 1_000;

export type StreamTimelineSnapshot =
  | {
      anchor?: StreamTimeAnchor;
      key: string;
      kind: "live";
      video: HTMLVideoElement;
    }
  | {
      archiveStartMs: number | null | undefined;
      key: string;
      kind: "vod";
      video: HTMLVideoElement;
      videoId: string;
    };

export type StreamTimelineSubscriber = (snapshot: StreamTimelineSnapshot | undefined) => void;

interface StreamTimeController {
  mountSyncControls(signal: AbortSignal): () => void;
  subscribeTimeline(subscriber: StreamTimelineSubscriber, signal: AbortSignal): () => void;
}

interface SharedStreamTimeRuntime {
  cleanup: () => void;
  controller: AbortController;
  references: number;
}

interface StreamTimeReferenceOptions {
  display?: boolean;
  timeline?: boolean;
}

let activeStreamTimeController: StreamTimeController | undefined = undefined;
let sharedStreamTimeRuntime: SharedStreamTimeRuntime | undefined = undefined;
let streamTimeDisplayReferences = 0;
let streamTimelineReferences = 0;

function isBufferedMediaTime(video: HTMLVideoElement, mediaTime: number) {
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index) + SYNC_SEEK_BUFFER_MARGIN_SECONDS;
      const end = video.buffered.end(index) - SYNC_SEEK_BUFFER_MARGIN_SECONDS;

      if (mediaTime >= start && mediaTime <= end) {
        return true;
      }
    }
  } catch {
    // Twitch can replace the MediaSource while its ranges are being read.
  }

  return false;
}

function findVideo() {
  return globalThis.document.querySelector<HTMLVideoElement>(
    '[data-a-target="video-player"] video',
  );
}

function getBufferEnd(video: HTMLVideoElement) {
  if (video.buffered.length === 0) {
    return null;
  }

  try {
    return video.buffered.end(video.buffered.length - 1);
  } catch {
    return null;
  }
}

function isStreamTimeSegment(value: unknown): value is StreamTimeSegment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const segment = value as Partial<StreamTimeSegment>;

  return (
    typeof segment.url === "string" &&
    Number.isFinite(segment.programDateTimeMs) &&
    Number.isFinite(segment.durationMs) &&
    Number.isFinite(segment.completedAt)
  );
}

async function sendMessage(message: StreamTimeRequest) {
  try {
    return (await browser.runtime.sendMessage(message)) as unknown;
  } catch {
    return null;
  }
}

const streamTimeImplementation = {
  mount(ctx: ContentScriptContext, signal: AbortSignal) {
    let anchor: (StreamTimeAnchor & { url: string }) | undefined = undefined;
    let cleaned = false;
    let currentVideo: HTMLVideoElement | null = null;
    let pendingSegment: StreamTimeSegment | undefined = undefined;
    let sessionId = globalThis.crypto.randomUUID();
    let subscriptionRequested = false;
    let subscribed = false;
    let updating = false;
    let currentMode: PlaybackMode | undefined = undefined;
    let vodRetryAt = 0;
    let vodStartKey: string | undefined = undefined;
    let vodStartMs: number | null | undefined = undefined;
    let vodRequest: Promise<number | null> | undefined = undefined;
    let syncButton: HTMLButtonElement | undefined = undefined;
    let syncControlsMounted = false;
    let syncPlaybackRate: { rate: number; video: HTMLVideoElement } | undefined = undefined;
    let syncRequested = false;
    let syncRequestVersion = 0;
    let syncStyle: HTMLStyleElement | undefined = undefined;
    let syncSignal: AbortSignal | undefined = undefined;
    let syncSoughtTarget: { targetAbsoluteMs: number; targetAtMs: number } | undefined = undefined;
    let syncTarget: { targetAbsoluteMs: number; targetAtMs: number } | undefined = undefined;
    const timelineSubscribers = new Set<StreamTimelineSubscriber>();

    const isInactive = () => cleaned || signal.aborted;

    const getTimelineSnapshot = (): StreamTimelineSnapshot | undefined => {
      if (!currentMode || !currentVideo) {
        return undefined;
      }

      if (currentMode.kind === "vod") {
        return {
          archiveStartMs: vodStartMs,
          key: currentMode.key,
          kind: currentMode.kind,
          video: currentVideo,
          videoId: currentMode.videoId,
        };
      }

      const snapshot: StreamTimelineSnapshot = {
        key: currentMode.key,
        kind: currentMode.kind,
        video: currentVideo,
      };

      if (anchor) {
        snapshot.anchor = {
          absoluteEndMs: anchor.absoluteEndMs,
          mediaEnd: anchor.mediaEnd,
        };
      }

      return snapshot;
    };

    const notifyTimelineSubscriber = (subscriber: StreamTimelineSubscriber) => {
      try {
        subscriber(getTimelineSnapshot());
      } catch {
        // A timeline consumer must not stop the shared stream-time runtime.
      }
    };

    const notifyTimelineSubscribers = () => {
      for (const subscriber of timelineSubscribers) {
        notifyTimelineSubscriber(subscriber);
      }
    };

    const resetTimeline = () => {
      anchor = undefined;
      pendingSegment = undefined;
    };

    const resetVodStart = (key: string) => {
      if (vodStartKey === key) {
        return;
      }

      vodRetryAt = 0;
      vodStartKey = key;
      vodStartMs = undefined;
      vodRequest = undefined;
    };

    const setSyncButtonState = (state: SyncButtonState) => {
      if (syncButton) {
        renderSyncButton(syncButton, state, syncRequested);
      }
    };

    const removeSyncButton = () => {
      syncButton?.remove();
      syncButton = undefined;
    };

    const removeSyncStyle = () => {
      syncStyle?.remove();
      syncStyle = undefined;
    };

    const restoreSyncPlaybackRate = () => {
      const playbackRate = syncPlaybackRate;

      syncPlaybackRate = undefined;

      if (!playbackRate) {
        return;
      }

      try {
        playbackRate.video.playbackRate = playbackRate.rate;
      } catch {
        // The video can be detached while Twitch replaces the player.
      }
    };

    const setSyncPlaybackRate = (video: HTMLVideoElement, rate: number) => {
      if (syncPlaybackRate?.video !== video) {
        restoreSyncPlaybackRate();
        syncPlaybackRate = { rate: video.playbackRate, video };
      }

      if (Math.abs(video.playbackRate - rate) > SYNC_PLAYBACK_RATE_EPSILON) {
        try {
          video.playbackRate = rate;
        } catch {
          // The next local control pass retries after a player transition.
        }
      }
    };

    const clearSyncTarget = () => {
      syncTarget = undefined;
    };

    const resetSyncControlState = () => {
      clearSyncTarget();
      syncSoughtTarget = undefined;
      restoreSyncPlaybackRate();
    };

    const leaveSync = () => {
      resetSyncControlState();
      void sendMessage({ sessionId, type: streamTimeMessages.leaveSync });
    };

    const resetSyncState = () => {
      if (syncRequested) {
        syncRequestVersion += 1;
        leaveSync();
      }

      resetSyncControlState();
      syncRequested = false;
      setSyncButtonState("sync");
      removeSyncButton();
    };

    const onSyncButtonClick = () => {
      if (!syncButton || !syncControlsMounted) {
        return;
      }

      syncRequested = !syncRequested;
      syncRequestVersion += 1;

      if (syncRequested) {
        clearSyncTarget();

        if (currentVideo) {
          setSyncPlaybackRate(currentVideo, 1);
        }

        setSyncButtonState("waiting");
      } else {
        leaveSync();
        setSyncButtonState("sync");
      }
    };

    const ensureSyncButton = (clock: ClockElements) => {
      if (!syncControlsMounted) {
        return;
      }

      const metrics = clock.root.parentElement;

      // Twitch replaces this row during rerenders, so keep the sync session until it returns.
      if (!metrics) {
        return;
      }

      const viewerCountWrapper = findViewerCountWrapper(metrics);

      if (!viewerCountWrapper) {
        return;
      }

      if (!syncButton) {
        syncRequestVersion += 1;

        syncButton = createSyncButton(onSyncButtonClick);

        if (syncRequested) {
          setSyncButtonState("waiting");
        } else {
          setSyncButtonState("sync");
        }
      }

      syncStyle = ensureSyncStyle(syncStyle);

      if (
        syncButton.parentElement !== metrics ||
        syncButton.nextElementSibling !== viewerCountWrapper
      ) {
        metrics.insertBefore(syncButton, viewerCountWrapper);
      }
    };

    const parseSyncResponse = (value: unknown): StreamSyncResponse | null => {
      if (!value || typeof value !== "object" || !("status" in value)) {
        return null;
      }

      const status = (value as { status?: unknown }).status;

      if (status !== "waiting" && status !== "ready") {
        return null;
      }

      return value as StreamSyncResponse;
    };

    const buildSyncReport = (video: HTMLVideoElement, streamAnchor: StreamTimeAnchor) => {
      if (
        video.paused ||
        video.seeking ||
        !Number.isFinite(video.currentTime) ||
        !Number.isFinite(video.playbackRate) ||
        video.playbackRate <= 0
      ) {
        return null;
      }

      const currentAbsoluteMs = interpolateStreamTime(streamAnchor, video.currentTime);
      const reportedAt = Date.now();

      if (!Number.isFinite(currentAbsoluteMs)) {
        return null;
      }

      return {
        currentAbsoluteMs,
        playbackRate: video.playbackRate,
        reportedAt,
      } satisfies StreamSyncReport;
    };

    const applySyncTarget = (
      video: HTMLVideoElement,
      streamAnchor: StreamTimeAnchor,
      target: { targetAbsoluteMs: number; targetAtMs: number },
    ) => {
      if (
        video.paused ||
        video.readyState < HAVE_METADATA ||
        !Number.isFinite(video.currentTime) ||
        !Number.isFinite(target.targetAbsoluteMs) ||
        !Number.isFinite(target.targetAtMs)
      ) {
        setSyncPlaybackRate(video, 1);

        return "buffering" as const;
      }

      if (video.seeking) {
        setSyncPlaybackRate(video, 1);

        return "buffering" as const;
      }

      const projectedTargetAbsoluteMs = projectStreamSyncTarget(
        target.targetAbsoluteMs,
        target.targetAtMs,
        Date.now(),
      );
      const targetMedia =
        streamAnchor.mediaEnd + (projectedTargetAbsoluteMs - streamAnchor.absoluteEndMs) / 1_000;

      if (!Number.isFinite(targetMedia)) {
        setSyncPlaybackRate(video, 1);

        return "buffering" as const;
      }

      const errorSeconds = video.currentTime - targetMedia;

      if (
        errorSeconds > STREAM_SYNC_SEEK_THRESHOLD_SECONDS &&
        (!syncSoughtTarget || !isSameStreamSyncTargetLine(syncSoughtTarget, target)) &&
        isBufferedMediaTime(video, targetMedia)
      ) {
        setSyncPlaybackRate(video, 1);
        syncSoughtTarget = { ...target };

        try {
          video.currentTime = targetMedia;

          return "buffering" as const;
        } catch {
          // Fall back to playback-rate correction if Twitch rejects the seek.
        }
      }

      const playbackRate = calculateStreamSyncPlaybackRate(errorSeconds);

      setSyncPlaybackRate(video, playbackRate);

      if (isStreamSyncAligned(errorSeconds)) {
        return "synced" as const;
      }

      return "buffering" as const;
    };

    const updateSync = async (video: HTMLVideoElement, streamAnchor: StreamTimeAnchor) => {
      if (!syncControlsMounted || !syncRequested || !syncButton || syncSignal?.aborted) {
        return;
      }

      const requestButton = syncButton;
      const requestSignal = syncSignal;
      const requestVersion = syncRequestVersion;

      const report = buildSyncReport(video, streamAnchor);

      if (!report) {
        setSyncButtonState("buffering");

        return;
      }

      const response = await sendMessage({
        report,
        sessionId,
        type: streamTimeMessages.updateSync,
      });

      if (
        isInactive() ||
        currentVideo !== video ||
        currentMode?.kind !== "live" ||
        syncButton !== requestButton ||
        syncSignal !== requestSignal ||
        syncRequestVersion !== requestVersion
      ) {
        return;
      }

      const parsed = parseSyncResponse(response);

      if (!parsed || parsed.status === "waiting") {
        clearSyncTarget();
        setSyncButtonState("waiting");

        return;
      }

      if (!Number.isFinite(parsed.targetAbsoluteMs) || !Number.isFinite(parsed.targetAtMs)) {
        clearSyncTarget();
        setSyncButtonState("buffering");

        return;
      }

      syncTarget = {
        targetAbsoluteMs: parsed.targetAbsoluteMs,
        targetAtMs: parsed.targetAtMs,
      };
    };

    const controlSync = () => {
      if (!syncControlsMounted || !syncRequested || syncSignal?.aborted) {
        return;
      }

      const video = currentVideo;

      if (!video || currentMode?.kind !== "live") {
        return;
      }

      if (!syncTarget) {
        setSyncPlaybackRate(video, 1);

        return;
      }

      if (Date.now() - syncTarget.targetAtMs > SYNC_TARGET_MAX_AGE_MS) {
        setSyncPlaybackRate(video, 1);
        clearSyncTarget();
        setSyncButtonState("waiting");

        return;
      }

      if (!anchor) {
        setSyncPlaybackRate(video, 1);
        setSyncButtonState("buffering");

        return;
      }

      setSyncButtonState(applySyncTarget(video, anchor, syncTarget));
    };

    const subscribeTimeline = (subscriber: StreamTimelineSubscriber, nextSignal: AbortSignal) => {
      let detached = false;
      const subscription: StreamTimelineSubscriber = (snapshot) => subscriber(snapshot);

      const cleanup = () => {
        if (detached) {
          return;
        }

        detached = true;
        nextSignal.removeEventListener("abort", cleanup);
        timelineSubscribers.delete(subscription);
      };

      timelineSubscribers.add(subscription);
      nextSignal.addEventListener("abort", cleanup, { once: true });

      if (nextSignal.aborted) {
        cleanup();
      } else {
        notifyTimelineSubscriber(subscription);
      }

      return cleanup;
    };

    const mountSyncControls = (nextSignal: AbortSignal) => {
      if (syncControlsMounted) {
        return () => {};
      }

      syncControlsMounted = true;
      syncSignal = nextSignal;
      let detached = false;

      const cleanup = () => {
        if (detached) {
          return;
        }

        detached = true;
        nextSignal.removeEventListener("abort", cleanup);

        if (syncSignal !== nextSignal) {
          return;
        }

        resetSyncState();
        syncControlsMounted = false;
        syncSignal = undefined;
        removeSyncStyle();
      };

      nextSignal.addEventListener("abort", cleanup, { once: true });

      if (nextSignal.aborted) {
        cleanup();
      }

      return cleanup;
    };

    const unsubscribe = () => {
      if (!subscriptionRequested) {
        return;
      }

      const closedSessionId = sessionId;

      sessionId = globalThis.crypto.randomUUID();
      subscriptionRequested = false;
      subscribed = false;

      void sendMessage({
        sessionId: closedSessionId,
        type: streamTimeMessages.unsubscribe,
      });
    };

    const deactivate = () => {
      resetSyncState();
      unsubscribe();
      currentVideo = null;
      currentMode = undefined;
      resetTimeline();
      removeClocks();
      notifyTimelineSubscribers();
    };

    const subscribe = async (video: HTMLVideoElement) => {
      const requestedSessionId = sessionId;

      subscriptionRequested = true;

      const response = await sendMessage({
        sessionId: requestedSessionId,
        type: streamTimeMessages.subscribe,
      });

      if (
        isInactive() ||
        currentVideo !== video ||
        currentMode?.kind !== "live" ||
        sessionId !== requestedSessionId
      ) {
        if (response !== null) {
          void sendMessage({
            sessionId: requestedSessionId,
            type: streamTimeMessages.unsubscribe,
          });
        }

        return false;
      }

      return response === true;
    };

    const updateVod = (
      clock: ClockElements | undefined,
      mode: VodPlaybackMode,
      video: HTMLVideoElement,
    ) => {
      resetVodStart(mode.key);

      if (vodStartMs === undefined && !vodRequest && Date.now() >= vodRetryAt) {
        const request = fetchArchiveStart(mode.videoId, signal);

        vodRequest = request;

        void request.then(
          (startMs) => {
            if (vodRequest !== request) {
              return;
            }

            vodRequest = undefined;

            if (isInactive() || currentVideo !== video || currentMode?.key !== mode.key) {
              return;
            }

            vodStartMs = startMs;
            notifyTimelineSubscribers();
          },
          (error: unknown) => {
            if (vodRequest !== request) {
              return;
            }

            vodRequest = undefined;

            if (isInactive() || currentMode?.key !== mode.key) {
              return;
            }

            vodRetryAt = Date.now() + ARCHIVE_RETRY_MS;
            console.warn("[Hyper Twitch] Unable to load archive metadata; retrying", error);
          },
        );
      }

      if (
        isInactive() ||
        currentVideo !== video ||
        currentMode?.key !== mode.key ||
        vodStartMs === undefined ||
        vodStartMs === null ||
        video.readyState < HAVE_METADATA ||
        !Number.isFinite(video.currentTime)
      ) {
        if (vodStartMs === null) {
          removeClocks();
        } else if (clock) {
          renderClock(clock);
        }

        return;
      }

      if (clock) {
        renderClock(clock, interpolateArchiveTime(vodStartMs, Math.max(0, video.currentTime)));
      }
    };

    const update = async () => {
      if (updating || isInactive()) {
        return;
      }

      updating = true;

      try {
        const mode = findPlaybackMode();
        const video = findVideo();
        const tracksTimeline =
          streamTimeDisplayReferences > 0 ||
          streamTimelineReferences > 0 ||
          (mode?.kind === "live" && syncControlsMounted);

        if (!mode || !tracksTimeline || !video) {
          deactivate();

          return;
        }

        const modeChanged =
          currentMode === undefined ||
          currentMode.key !== mode.key ||
          currentMode.kind !== mode.kind;
        const videoChanged = video !== currentVideo;

        if (modeChanged || videoChanged) {
          resetSyncState();

          if (currentMode?.kind === "live") {
            unsubscribe();
          }

          currentMode = mode;
          currentVideo = video;
          subscribed = false;
          resetTimeline();

          if (mode.kind === "vod") {
            resetVodStart(mode.key);
          }
        }

        const canRenderClock =
          mode.kind === "live" || vodStartKey !== mode.key || vodStartMs !== null;
        const needsClock =
          canRenderClock &&
          (streamTimeDisplayReferences > 0 || (mode.kind === "live" && syncControlsMounted));
        let clock: ClockElements | undefined = undefined;

        if (needsClock) {
          const placement = findClockPlacement(mode.kind);

          if (placement) {
            try {
              clock = ensureClock(placement);
            } catch {
              removeClocks();
            }
          } else {
            removeClocks();
          }
        } else {
          removeClocks();
        }

        if (mode.kind === "vod" || modeChanged || videoChanged) {
          notifyTimelineSubscribers();
        }

        if (clock && modeChanged) {
          renderClock(clock);
        }

        if (mode.kind === "vod") {
          resetSyncState();
          updateVod(clock, mode, video);

          return;
        }

        if (clock) {
          ensureSyncButton(clock);
        }

        if (modeChanged) {
          subscribed = await subscribe(video);

          return;
        }

        if (!subscribed) {
          if (clock) {
            renderClock(clock);
          }

          subscribed = await subscribe(video);

          if (!subscribed) {
            return;
          }
        }

        if (!anchor) {
          const response = await sendMessage({
            sessionId,
            type: streamTimeMessages.getLatestSegment,
          });

          if (isInactive() || currentVideo !== video || currentMode?.key !== mode.key) {
            return;
          }

          if (
            isStreamTimeSegment(response) &&
            Date.now() - response.completedAt <= MAX_SEGMENT_AGE_MS &&
            response.url !== pendingSegment?.url
          ) {
            pendingSegment = response;
          }
        }

        if (pendingSegment && Date.now() - pendingSegment.completedAt > MAX_SEGMENT_AGE_MS) {
          pendingSegment = undefined;
        }

        let bufferEnd: number | null = null;

        if (
          !anchor &&
          pendingSegment &&
          !video.paused &&
          video.readyState >= HAVE_FUTURE_DATA &&
          Date.now() - pendingSegment.completedAt >= APPEND_GRACE_MS
        ) {
          bufferEnd = getBufferEnd(video);
        }

        if (!anchor && pendingSegment && bufferEnd !== null) {
          // Keep the initial affine mapping stable. A later network completion does not prove
          // that the current buffer end belongs to that same segment.
          anchor = {
            absoluteEndMs: pendingSegment.programDateTimeMs + pendingSegment.durationMs,
            mediaEnd: bufferEnd,
            url: pendingSegment.url,
          };

          pendingSegment = undefined;
          void sendMessage({ sessionId, type: streamTimeMessages.captureComplete });
          notifyTimelineSubscribers();
        }

        if (!anchor || !Number.isFinite(video.currentTime)) {
          if (clock) {
            renderClock(clock);
          }

          if (syncRequested) {
            setSyncButtonState("buffering");
          }

          return;
        }

        if (clock) {
          renderClock(clock, interpolateStreamTime(anchor, video.currentTime));
        }

        await updateSync(video, anchor);
      } catch {
        removeClocks();
      } finally {
        updating = false;
      }
    };

    const controller: StreamTimeController = { mountSyncControls, subscribeTimeline };

    activeStreamTimeController = controller;

    const syncControlIntervalId = ctx.setInterval(controlSync, SYNC_CONTROL_INTERVAL_MS);
    const intervalId = ctx.setInterval(() => void update(), UPDATE_INTERVAL_MS);

    void update();

    return () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearInterval(syncControlIntervalId);
      clearInterval(intervalId);
      deactivate();
      removeSyncStyle();

      if (activeStreamTimeController === controller) {
        activeStreamTimeController = undefined;
      }

      syncControlsMounted = false;
      syncSignal = undefined;
      timelineSubscribers.clear();
    };
  },
};

function acquireStreamTimeRuntime(
  ctx: ContentScriptContext,
  { display = false, timeline = false }: StreamTimeReferenceOptions = {},
) {
  if (display) {
    streamTimeDisplayReferences += 1;
  }

  if (timeline) {
    streamTimelineReferences += 1;
  }

  let shared = sharedStreamTimeRuntime;

  try {
    if (!shared) {
      const controller = new AbortController();
      const cleanup = streamTimeImplementation.mount(ctx, controller.signal);

      shared = { cleanup, controller, references: 0 };
      sharedStreamTimeRuntime = shared;
    }
  } catch (error) {
    if (display) {
      streamTimeDisplayReferences -= 1;
    }

    if (timeline) {
      streamTimelineReferences -= 1;
    }

    throw error;
  }

  shared.references += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    shared.references -= 1;

    if (display) {
      streamTimeDisplayReferences -= 1;
    }

    if (timeline) {
      streamTimelineReferences -= 1;
    }

    if (shared.references === 0 && sharedStreamTimeRuntime === shared) {
      sharedStreamTimeRuntime = undefined;
      shared.controller.abort();
      shared.cleanup();
    }
  };
}

export function subscribeStreamTimeline(
  ctx: ContentScriptContext,
  signal: AbortSignal,
  subscriber: StreamTimelineSubscriber,
) {
  const releaseStreamTime = acquireStreamTimeRuntime(ctx, { timeline: true });
  const controller = activeStreamTimeController;

  if (!controller) {
    releaseStreamTime();

    throw new Error("Shared stream-time controller is unavailable");
  }

  const unsubscribeTimeline = controller.subscribeTimeline(subscriber, signal);
  let disposed = false;

  const cleanup = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    signal.removeEventListener("abort", cleanup);
    unsubscribeTimeline();
    releaseStreamTime();
  };

  signal.addEventListener("abort", cleanup, { once: true });

  if (signal.aborted) {
    cleanup();
  }

  return cleanup;
}

export const streamTimeRuntime = {
  mount(ctx: ContentScriptContext, _signal: AbortSignal) {
    return acquireStreamTimeRuntime(ctx, { display: true });
  },
};

export const streamSyncRuntime = {
  mount(ctx: ContentScriptContext, signal: AbortSignal) {
    const releaseStreamTime = acquireStreamTimeRuntime(ctx);
    const detachControls = activeStreamTimeController?.mountSyncControls(signal) ?? (() => {});
    let disposed = false;

    const cleanup = () => {
      if (disposed) {
        return;
      }

      disposed = true;
      signal.removeEventListener("abort", cleanup);
      detachControls();
      releaseStreamTime();
    };

    signal.addEventListener("abort", cleanup, { once: true });

    if (signal.aborted) {
      cleanup();
    }

    return cleanup;
  },
};
