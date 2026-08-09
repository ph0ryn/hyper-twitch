import { browser, storage, type ContentScriptContext, type StorageItemKey } from "#imports";

import { subscribeStreamTimeline, type StreamTimelineSnapshot } from "../streamTime/runtime";
import {
  isLiveWatchRecord,
  isVodWatchRecord,
  liveMediaRangesToUtcRanges,
  mergeWatchRanges,
  normalizeLogin,
  subtractWatchRanges,
  timeRangesToWatchRanges,
  toVodWatchRanges,
  watchRangesToOverlay,
  type LiveWatchRecord,
  type WatchRange,
  type VodWatchRecord,
} from "./model";
import {
  isVodWatchMetadata,
  watchHistoryMessages,
  watchHistoryStorageKeys,
  type VodWatchMetadata,
  type WatchHistoryRequest,
} from "./protocol";

const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_RETRY_MS = 5_000;
const OVERLAY_SELECTOR = "[data-hyper-twitch-watch-history]";
const SEEK_BAR_SELECTOR = '[data-test-selector="seekbar-interaction-area__interactionArea"]';
const SEEK_BAR_TRACK_SELECTOR = ".seekbar-bar";
const WATCHED_SEGMENT_COLOR = "#00e5ff";

type PendingWrite =
  | {
      login: string;
      provisionalId: string;
      ranges: ReturnType<typeof liveMediaRangesToUtcRanges>;
      type: typeof watchHistoryMessages.mergeLiveRanges;
    }
  | {
      ranges: ReturnType<typeof timeRangesToWatchRanges>;
      type: typeof watchHistoryMessages.mergeVodRanges;
      videoId: string;
    };

function sendMessage(message: WatchHistoryRequest): Promise<unknown> {
  return browser.runtime.sendMessage(message).catch(() => null);
}

function isMergeResponse(value: unknown) {
  return typeof value === "object" && value !== null && "record" in value;
}

function mergePendingWrites(current: PendingWrite | undefined, next: PendingWrite): PendingWrite {
  if (
    current?.type === watchHistoryMessages.mergeLiveRanges &&
    next.type === watchHistoryMessages.mergeLiveRanges &&
    current.login === next.login &&
    current.provisionalId === next.provisionalId
  ) {
    return {
      ...next,
      ranges: mergeWatchRanges([...current.ranges, ...next.ranges]),
    };
  }

  if (
    current?.type === watchHistoryMessages.mergeVodRanges &&
    next.type === watchHistoryMessages.mergeVodRanges &&
    current.videoId === next.videoId
  ) {
    return {
      ...next,
      ranges: mergeWatchRanges([...current.ranges, ...next.ranges]),
    };
  }

  return next;
}

function findLiveLogin(snapshot: Extract<StreamTimelineSnapshot, { kind: "live" }>) {
  const match = /^live:\/([a-zA-Z0-9_]+)\/?$/.exec(snapshot.key);

  return normalizeLogin(match?.[1]);
}

function findSeekBar(video: HTMLVideoElement) {
  const player = video.closest<HTMLElement>('[data-a-target="video-player"]');
  const scoped = player?.querySelector<HTMLElement>(SEEK_BAR_SELECTOR);
  const scopedTrack = scoped?.querySelector<HTMLElement>(SEEK_BAR_TRACK_SELECTOR);

  if (scopedTrack && scopedTrack.getClientRects().length > 0) {
    return scopedTrack;
  }

  for (const interactionArea of globalThis.document.querySelectorAll<HTMLElement>(
    SEEK_BAR_SELECTOR,
  )) {
    const track = interactionArea.querySelector<HTMLElement>(SEEK_BAR_TRACK_SELECTOR);

    if (track && track.getClientRects().length > 0) {
      return track;
    }
  }

  return undefined;
}

function removeOverlays() {
  globalThis.document.querySelectorAll(OVERLAY_SELECTOR).forEach((element) => element.remove());
}

function createOverlay(anchor: HTMLElement) {
  const overlay = globalThis.document.createElement("div");

  overlay.dataset.hyperTwitchWatchHistory = "";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.blockSize = "100%";
  overlay.style.insetBlockEnd = "0";
  overlay.style.insetInlineStart = "0";
  overlay.style.inlineSize = "100%";
  overlay.style.overflow = "hidden";
  overlay.style.pointerEvents = "none";
  overlay.style.position = "absolute";
  overlay.style.zIndex = "2";
  anchor.append(overlay);

  return overlay;
}

function renderOverlay(
  snapshot: Extract<StreamTimelineSnapshot, { kind: "vod" }>,
  ranges: ReturnType<typeof toVodWatchRanges>,
) {
  const durationMs = Math.round(snapshot.video.duration * 1_000);
  const anchor = findSeekBar(snapshot.video);

  if (!anchor || !Number.isFinite(durationMs) || durationMs <= 0) {
    removeOverlays();

    return;
  }

  let overlay = anchor.querySelector<HTMLElement>(OVERLAY_SELECTOR);

  for (const existing of globalThis.document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (existing !== overlay) {
      existing.remove();
    }
  }

  if (!overlay) {
    overlay = createOverlay(anchor);
  }

  const segments = watchRangesToOverlay(ranges, durationMs);
  const renderKey = `cyan-full:${JSON.stringify(segments)}`;

  if (overlay.dataset.renderKey === renderKey) {
    return;
  }

  overlay.replaceChildren();
  overlay.dataset.renderKey = renderKey;

  for (const segment of segments) {
    const marker = globalThis.document.createElement("span");

    marker.style.background = WATCHED_SEGMENT_COLOR;
    marker.style.blockSize = "100%";
    marker.style.insetBlockStart = "0";
    marker.style.insetInlineStart = `${segment.leftPercent}%`;
    marker.style.inlineSize = `${segment.widthPercent}%`;
    marker.style.minInlineSize = "1px";
    marker.style.position = "absolute";
    overlay.append(marker);
  }
}

function defineRecordItem<T>(key: string) {
  return storage.defineItem<T>(key as StorageItemKey);
}

export const watchHistoryRuntime = {
  mount(ctx: ContentScriptContext, signal: AbortSignal) {
    let cleaned = false;
    let currentSnapshot: StreamTimelineSnapshot | undefined = undefined;
    let detachTimeline = () => {};
    let detachVideo = () => {};
    let directVodRecord: VodWatchRecord | undefined = undefined;
    let drainingWrites = false;
    let hasAttachedVideo = false;
    let lastFlushAt = 0;
    const liveRecordByIdentity = new Map<string, LiveWatchRecord>();
    let metadataRequestVersion = 0;
    const pendingCollectionKeys = new Set<string>();
    const pendingWrites = new Map<string, PendingWrite>();
    let playedBaseline: WatchRange[] = [];
    let provisionalId = globalThis.crypto.randomUUID();
    let recordUnwatchers: (() => void)[] = [];
    let retryTimer: number | undefined = undefined;
    let vodMetadata: VodWatchMetadata | undefined = undefined;

    const clearRecordWatchers = () => {
      for (const unwatch of recordUnwatchers) {
        unwatch();
      }

      recordUnwatchers = [];
      directVodRecord = undefined;
      liveRecordByIdentity.clear();
    };

    const watchRecord = <T>(
      key: string,
      validate: (value: unknown) => value is T,
      apply: (record: T | undefined) => void,
    ) => {
      const item = defineRecordItem<T>(key);
      let active = true;
      let watched = false;
      const applyValue = (value: unknown) => {
        if (validate(value)) {
          apply(value);
        } else {
          apply(undefined);
        }
      };
      const unwatch = item.watch((value) => {
        if (!active) {
          return;
        }

        watched = true;
        applyValue(value);
        renderCurrentOverlay();
      });

      recordUnwatchers.push(() => {
        active = false;
        unwatch();
      });

      void item.getValue().then(
        (value) => {
          if (active && !cleaned && !watched) {
            applyValue(value);
            renderCurrentOverlay();
          }
        },
        () => {},
      );
    };

    const watchLiveRecord = (identity: string) => {
      const key = watchHistoryStorageKeys.live(identity);

      watchRecord(key, isLiveWatchRecord, (record) => {
        if (record) {
          liveRecordByIdentity.set(identity, record);
        } else {
          liveRecordByIdentity.delete(identity);
        }
      });
    };

    const renderCurrentOverlay = () => {
      const snapshot = currentSnapshot;

      if (snapshot?.kind !== "vod") {
        removeOverlays();

        return;
      }

      const archiveConfirmed =
        Number.isFinite(snapshot.archiveStartMs) || vodMetadata?.videoId === snapshot.videoId;

      if (!archiveConfirmed) {
        removeOverlays();

        return;
      }

      const durationMs = Math.round(snapshot.video.duration * 1_000);
      const recordedAtMs = vodMetadata?.recordedAtMs ?? snapshot.archiveStartMs;

      if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
        removeOverlays();

        return;
      }

      const ranges = toVodWatchRanges(directVodRecord, [...liveRecordByIdentity.values()], {
        durationMs,
        login: vodMetadata?.login,
        ownerId: vodMetadata?.ownerId,
        recordedAtMs,
      });

      renderOverlay(snapshot, ranges);
    };

    const collectWrite = (snapshot: StreamTimelineSnapshot): PendingWrite | undefined => {
      if (snapshot.kind === "vod") {
        const archiveConfirmed =
          Number.isFinite(snapshot.archiveStartMs) || vodMetadata?.videoId === snapshot.videoId;

        if (!archiveConfirmed) {
          return undefined;
        }

        const ranges = subtractWatchRanges(
          timeRangesToWatchRanges(snapshot.video.played),
          playedBaseline,
        );

        if (ranges.length === 0) {
          return undefined;
        }

        return {
          ranges,
          type: watchHistoryMessages.mergeVodRanges,
          videoId: snapshot.videoId,
        };
      }

      const login = findLiveLogin(snapshot);

      if (!login || !snapshot.anchor) {
        return undefined;
      }

      const mediaRanges = subtractWatchRanges(
        timeRangesToWatchRanges(snapshot.video.played),
        playedBaseline,
      );
      const ranges = liveMediaRangesToUtcRanges(mediaRanges, snapshot.anchor);

      if (ranges.length === 0) {
        return undefined;
      }

      return {
        login,
        provisionalId,
        ranges,
        type: watchHistoryMessages.mergeLiveRanges,
      };
    };

    const scheduleWriteDrain = (delayMs = 0) => {
      if (drainingWrites || retryTimer !== undefined || pendingWrites.size === 0) {
        return;
      }

      if (delayMs > 0) {
        retryTimer = globalThis.setTimeout(() => {
          retryTimer = undefined;
          void drainWrites();
        }, delayMs);

        return;
      }

      void drainWrites();
    };

    const drainWrites = async () => {
      if (drainingWrites) {
        return;
      }

      drainingWrites = true;
      let failed = false;

      try {
        while (pendingWrites.size > 0) {
          const entry = pendingWrites.entries().next().value as [string, PendingWrite] | undefined;

          if (!entry) {
            break;
          }

          const [key, write] = entry;
          const response = await sendMessage(write);

          if (!isMergeResponse(response)) {
            failed = true;

            break;
          }

          if (pendingWrites.get(key) === write) {
            pendingWrites.delete(key);
          }
        }
      } finally {
        drainingWrites = false;

        if (pendingWrites.size > 0 && !cleaned) {
          let delayMs = 0;

          if (failed) {
            delayMs = FLUSH_RETRY_MS;
          }

          scheduleWriteDrain(delayMs);
        }
      }
    };

    const queueFlush = (snapshot = currentSnapshot) => {
      if (!snapshot) {
        return;
      }

      if (snapshot.video.played.length > 0) {
        pendingCollectionKeys.add(snapshot.key);
      }

      const write = collectWrite(snapshot);

      if (!write) {
        return;
      }

      let key = snapshot.key;

      if (write.type === watchHistoryMessages.mergeLiveRanges) {
        key = `${snapshot.key}:${write.provisionalId}`;
      }

      pendingCollectionKeys.delete(snapshot.key);
      pendingWrites.set(key, mergePendingWrites(pendingWrites.get(key), write));
      scheduleWriteDrain();
    };

    const flushPeriodically = () => {
      const now = Date.now();

      if (now - lastFlushAt < FLUSH_INTERVAL_MS) {
        return;
      }

      lastFlushAt = now;
      queueFlush();
    };

    const attachVideo = (snapshot: StreamTimelineSnapshot, excludeCurrentPlayed: boolean) => {
      const controller = new AbortController();
      const flush = () => queueFlush();

      if (excludeCurrentPlayed) {
        playedBaseline = timeRangesToWatchRanges(snapshot.video.played);
      } else {
        playedBaseline = [];
      }

      hasAttachedVideo = true;

      snapshot.video.addEventListener("ended", flush, { signal: controller.signal });
      snapshot.video.addEventListener("pause", flush, { signal: controller.signal });
      snapshot.video.addEventListener("seeking", flush, { signal: controller.signal });

      snapshot.video.addEventListener("timeupdate", flushPeriodically, {
        signal: controller.signal,
      });

      snapshot.video.addEventListener("durationchange", renderCurrentOverlay, {
        signal: controller.signal,
      });

      detachVideo = () => controller.abort();
    };

    const loadVodMetadata = async (videoId: string, requestVersion: number) => {
      const response = await sendMessage({
        type: watchHistoryMessages.getVodMetadata,
        videoId,
      });

      if (
        cleaned ||
        requestVersion !== metadataRequestVersion ||
        currentSnapshot?.kind !== "vod" ||
        currentSnapshot.videoId !== videoId ||
        !isVodWatchMetadata(response)
      ) {
        return;
      }

      vodMetadata = response;
      watchLiveRecord(response.ownerId);

      if (response.login !== response.ownerId) {
        watchLiveRecord(response.login);
      }

      if (pendingCollectionKeys.has(currentSnapshot.key)) {
        queueFlush(currentSnapshot);
      }

      renderCurrentOverlay();
    };

    const switchSnapshot = (snapshot: StreamTimelineSnapshot | undefined) => {
      const previous = currentSnapshot;
      const identityChanged =
        previous?.key !== snapshot?.key || previous?.video !== snapshot?.video;

      if (identityChanged) {
        if (previous) {
          queueFlush(previous);
        }

        if (previous && previous.key !== snapshot?.key) {
          pendingCollectionKeys.delete(previous.key);
        }

        detachVideo();
        clearRecordWatchers();
        metadataRequestVersion += 1;
        lastFlushAt = 0;
        provisionalId = globalThis.crypto.randomUUID();
        vodMetadata = undefined;
      }

      currentSnapshot = snapshot;

      if (!snapshot) {
        removeOverlays();

        return;
      }

      if (identityChanged) {
        const excludeCurrentPlayed = !hasAttachedVideo || previous?.video === snapshot.video;

        attachVideo(snapshot, excludeCurrentPlayed);

        if (snapshot.kind === "vod") {
          const requestVersion = metadataRequestVersion;

          watchRecord(watchHistoryStorageKeys.vod(snapshot.videoId), isVodWatchRecord, (record) => {
            directVodRecord = record;
          });

          void loadVodMetadata(snapshot.videoId, requestVersion);
        }
      } else if (pendingCollectionKeys.has(snapshot.key)) {
        queueFlush(snapshot);
      }

      renderCurrentOverlay();
    };

    const onPageHide = () => queueFlush();

    const cleanup = () => {
      if (cleaned) {
        return;
      }

      queueFlush();
      cleaned = true;

      if (retryTimer !== undefined) {
        globalThis.clearTimeout(retryTimer);
        retryTimer = undefined;
      }

      scheduleWriteDrain();
      signal.removeEventListener("abort", cleanup);
      globalThis.removeEventListener("pagehide", onPageHide);
      detachTimeline();
      detachVideo();
      clearRecordWatchers();
      removeOverlays();
    };

    signal.addEventListener("abort", cleanup, { once: true });
    globalThis.addEventListener("pagehide", onPageHide);

    if (signal.aborted) {
      cleanup();
    } else {
      detachTimeline = subscribeStreamTimeline(ctx, signal, switchSnapshot);
    }

    return cleanup;
  },
};
