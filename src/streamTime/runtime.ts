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
} from "./protocol";

const APPEND_GRACE_MS = 500;
const ARCHIVE_FETCH_TIMEOUT_MS = 5_000;
const HAVE_FUTURE_DATA = 3;
const HAVE_METADATA = 1;
const MAX_SEGMENT_AGE_MS = 15_000;
const SYNC_CONTROL_INTERVAL_MS = 100;
const SYNC_PLAYBACK_RATE_EPSILON = 0.001;
const SYNC_SEEK_BUFFER_MARGIN_SECONDS = 0.25;
const SYNC_TARGET_MAX_AGE_MS = 2_000;
const UPDATE_INTERVAL_MS = 500;
const CLOCK_SELECTOR = "[data-hyper-twitch-stream-time]";
const SHARE_SELECTOR = 'button[data-a-target="share-button"], button[aria-label="Share"]';
const VOD_SHARE_SELECTOR =
  '[data-test-selector="metadata-layout__split-top"] button[aria-label="Share"]';
const VIDEO_OPTIONS_SELECTOR = 'button[aria-label="Video Options"]';
const VIEWER_COUNT_SELECTOR = '[data-a-target="animated-channel-viewers-count"]';
const SYNC_STYLE_TEXT = `
[data-hyper-twitch-stream-sync] {
  appearance: none;
  align-items: center;
  background: var(--color-background-button-secondary-default, #e5e5e5);
  border: 0;
  border-radius: 9000px;
  box-sizing: border-box;
  color: var(--color-text-button-secondary, #1f1f23);
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  block-size: 32px;
  inline-size: 56px;
  justify-content: center;
  line-height: 20px;
  margin: 0 8px 0 0;
  min-inline-size: 56px;
  padding: 0 12px;
  white-space: nowrap;
}

[data-hyper-twitch-stream-sync]:hover {
  background: var(--color-background-button-secondary-hover, #d3d3d7);
  color: var(--color-text-button-secondary, #1f1f23);
}

[data-hyper-twitch-stream-sync]:focus-visible {
  outline: 2px solid var(--color-border-button-focus, #9147ff);
  outline-offset: 2px;
}

[data-hyper-twitch-stream-sync]:active {
  background: var(--color-background-button-secondary-active, #c7c7cc);
  transform: translateY(1px);
}

[data-hyper-twitch-stream-sync][aria-pressed="true"] {
  background: var(--color-background-button-brand, #9147ff);
  color: var(--color-text-button, #fff);
}

[data-hyper-twitch-stream-sync][aria-pressed="true"]:hover {
  background: var(--color-background-button-brand-hover, #772ce8);
}

[data-hyper-twitch-stream-sync][aria-pressed="true"]:active {
  background: var(--color-background-button-brand-active, #5c16c5);
}

[data-hyper-twitch-stream-sync][aria-busy="true"] {
  opacity: 0.8;
}
`;

const accessibleFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
  year: "numeric",
});

const visibleFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  second: "2-digit",
});

interface LivePlaybackMode {
  kind: "live";
  key: string;
}

interface VodPlaybackMode {
  kind: "vod";
  key: string;
  videoId: string;
}

type PlaybackMode = LivePlaybackMode | VodPlaybackMode;
type PlaybackKind = PlaybackMode["kind"];

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

interface ClockPlacement {
  before?: HTMLElement;
  kind: PlaybackKind;
  nativeTime?: HTMLElement;
  nativeWrapper?: HTMLElement;
  parent: HTMLElement;
}

interface ClockElements {
  root: HTMLElement;
  timer: HTMLElement;
  visibleText: HTMLElement;
}

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

function findNativeLiveTime() {
  return [...globalThis.document.querySelectorAll<HTMLElement>(".live-time")].find(
    (element) =>
      !element.closest(CLOCK_SELECTOR) &&
      element.getClientRects().length > 0 &&
      hasShareAncestor(element),
  );
}

function hasShareAncestor(element: HTMLElement) {
  let ancestor = element.parentElement;

  while (ancestor && ancestor !== globalThis.document.body) {
    if (ancestor.querySelector(SHARE_SELECTOR)) {
      return true;
    }

    ancestor = ancestor.parentElement;
  }

  return false;
}

function findShareButton() {
  const selectors = [VOD_SHARE_SELECTOR, SHARE_SELECTOR];

  for (const selector of selectors) {
    const button = [...globalThis.document.querySelectorAll<HTMLButtonElement>(selector)].find(
      (element) => element.getClientRects().length > 0,
    );

    if (button) {
      return button;
    }
  }

  return undefined;
}

function findVodSharePlacement() {
  const shareButton = findShareButton();
  let candidate = shareButton?.parentElement;

  while (candidate && candidate !== globalThis.document.body) {
    const parent = candidate.parentElement;

    if (parent?.querySelector(VIDEO_OPTIONS_SELECTOR)) {
      return { before: candidate, parent };
    }

    candidate = parent;
  }

  return null;
}

function findClockPlacement(kind: PlaybackKind): ClockPlacement | null {
  if (kind === "live") {
    const nativeTime = findNativeLiveTime();
    const nativeWrapper = nativeTime?.parentElement;
    const metrics = nativeWrapper?.parentElement;

    if (!nativeTime || !nativeWrapper || !metrics) {
      return null;
    }

    return { kind, nativeTime, nativeWrapper, parent: metrics };
  }

  const sharePlacement = findVodSharePlacement();

  if (!sharePlacement) {
    return null;
  }

  return { ...sharePlacement, kind };
}

function findViewerCountWrapper(metrics: HTMLElement) {
  const viewerCount = [...metrics.querySelectorAll<HTMLElement>(VIEWER_COUNT_SELECTOR)].find(
    (element) => element.getClientRects().length > 0,
  );

  if (!viewerCount) {
    return null;
  }

  let wrapper = viewerCount;

  while (wrapper.parentElement && wrapper.parentElement !== metrics) {
    wrapper = wrapper.parentElement;
  }

  if (wrapper.parentElement === metrics) {
    return wrapper;
  }

  return null;
}

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

function styleClock(root: HTMLElement, timer: HTMLElement, kind: PlaybackKind) {
  root.style.whiteSpace = "nowrap";

  if (kind === "live") {
    return;
  }

  for (const element of [root, timer]) {
    element.style.color = "inherit";
    element.style.fontFamily = "inherit";
    element.style.fontSize = "14px";
    element.style.fontWeight = "400";
    element.style.lineHeight = "1.4";
    element.style.whiteSpace = "nowrap";
  }

  root.style.alignItems = "center";
  root.style.display = "inline-flex";
  root.style.marginInlineEnd = "8px";
  timer.style.fontVariantNumeric = "tabular-nums";
}

function createTimer(placement: ClockPlacement) {
  if (placement.nativeTime) {
    return placement.nativeTime.cloneNode(false) as HTMLElement;
  }

  return globalThis.document.createElement("span");
}

function ensureClock(placement: ClockPlacement): ClockElements {
  let root = globalThis.document.querySelector<HTMLElement>(CLOCK_SELECTOR);

  if (root && root.dataset.hyperTwitchStreamTimeKind !== placement.kind) {
    root.remove();
    root = null;
  }

  if (!root) {
    if (placement.nativeWrapper) {
      root = placement.nativeWrapper.cloneNode(false) as HTMLElement;
    } else {
      root = globalThis.document.createElement("span");
    }

    root.removeAttribute("id");
    root.dataset.hyperTwitchStreamTime = "";
    root.dataset.hyperTwitchStreamTimeKind = placement.kind;
    root.title = "Approximate wall-clock time from Twitch stream timestamps";

    const timer = createTimer(placement);
    const visibleText = globalThis.document.createElement("span");

    timer.removeAttribute("id");
    timer.setAttribute("role", "timer");
    visibleText.setAttribute("aria-hidden", "true");
    timer.append(visibleText);
    root.append(timer);
  }

  const timer = root.firstElementChild;
  const visibleText = timer?.firstElementChild;

  if (
    !(timer instanceof globalThis.HTMLElement) ||
    !(visibleText instanceof globalThis.HTMLElement)
  ) {
    root.remove();

    throw new TypeError("Stream time marker structure is invalid");
  }

  if (placement.kind === "live" && placement.nativeWrapper && placement.nativeTime) {
    root.className = placement.nativeWrapper.className;
    timer.className = placement.nativeTime.className;

    if (
      root.parentElement !== placement.parent ||
      root.previousElementSibling !== placement.nativeWrapper
    ) {
      placement.parent.insertBefore(root, placement.nativeWrapper.nextSibling);
    }
  } else {
    root.removeAttribute("class");
    timer.removeAttribute("class");

    if (root.parentElement !== placement.parent || root.nextElementSibling !== placement.before) {
      placement.parent.insertBefore(root, placement.before ?? null);
    }
  }

  styleClock(root, timer, placement.kind);

  return { root, timer, visibleText };
}

function removeClocks() {
  globalThis.document.querySelectorAll(CLOCK_SELECTOR).forEach((element) => element.remove());
}

function renderClock(clock: ClockElements, timestamp?: number) {
  let accessibleText = "syncing";
  let visibleText = "syncing…";

  if (timestamp !== undefined) {
    accessibleText = accessibleFormatter.format(timestamp);
    visibleText = visibleFormatter.format(timestamp);
  }

  clock.visibleText.textContent = `≈ ${visibleText}`;
  clock.timer.setAttribute("aria-label", `Approximate stream time: ${accessibleText}`);
  clock.root.title = `Approximate stream time: ${accessibleText}`;
}

function findVideo() {
  return globalThis.document.querySelector<HTMLVideoElement>(
    '[data-a-target="video-player"] video',
  );
}

function findPlaybackMode(): PlaybackMode {
  const match = /^\/videos\/(\d+)(?:\/|$)/.exec(globalThis.location.pathname);
  const vodId = match?.[1];

  if (vodId) {
    return { key: `vod:${vodId}`, kind: "vod", videoId: vodId };
  }

  return { key: `live:${globalThis.location.pathname}`, kind: "live" };
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

function parseTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  return undefined;
}

function findVideoObjectStart(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const timestamp = findVideoObjectStart(item);

      if (timestamp !== undefined) {
        return timestamp;
      }
    }

    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  const type = object["@type"];
  const isVideoObject =
    type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"));

  if (isVideoObject) {
    const timestamp = parseTimestamp(object.uploadDate);

    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return findVideoObjectStart(object["@graph"]);
}

function parseArchiveStart(document: Document) {
  const contentType = document
    .querySelector('meta[name="amazonbot-content-type"]')
    ?.getAttribute("content")
    ?.trim()
    .toLowerCase();

  if (contentType !== "vod") {
    return null;
  }

  const metaTimestamp = parseTimestamp(
    document.querySelector('meta[property="og:video:release_date"]')?.getAttribute("content"),
  );

  if (metaTimestamp !== undefined) {
    return metaTimestamp;
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const timestamp = findVideoObjectStart(JSON.parse(script.textContent));

      if (timestamp !== undefined) {
        return timestamp;
      }
    } catch {
      // Twitch can include non-JSON script content with this MIME type.
    }
  }

  return null;
}

async function fetchArchiveStart(videoId: string, signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = globalThis.setTimeout(abort, ARCHIVE_FETCH_TIMEOUT_MS);

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const url = new URL(`/videos/${videoId}`, globalThis.location.origin);
    const response = await globalThis.fetch(url, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    if (controller.signal.aborted) {
      return null;
    }

    return parseArchiveStart(new globalThis.DOMParser().parseFromString(html, "text/html"));
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abort);
  }
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

      vodStartKey = key;
      vodStartMs = undefined;
      vodRequest = undefined;
    };

    const setSyncButtonState = (state: "buffering" | "sync" | "synced" | "waiting") => {
      if (!syncButton) {
        return;
      }

      syncButton.textContent = "Sync";
      syncButton.dataset.state = state;
      syncButton.setAttribute("aria-pressed", String(syncRequested));
      syncButton.setAttribute("aria-busy", String(state === "buffering" || state === "waiting"));

      const titles = {
        buffering: "Adjusting playback speed. Select to stop syncing.",
        sync: "Sync this live stream with other live streams",
        synced: "Synced with other live streams. Select to stop syncing.",
        waiting: "Waiting for another live stream. Select to stop syncing.",
      } as const;

      syncButton.title = titles[state];

      if (syncRequested) {
        syncButton.setAttribute("aria-label", "Stop syncing this live stream");
      } else {
        syncButton.setAttribute("aria-label", "Sync this live stream with other live streams");
      }
    };

    const ensureSyncStyle = () => {
      if (syncStyle?.isConnected) {
        return;
      }

      const parent = globalThis.document.head;

      syncStyle?.remove();
      syncStyle = globalThis.document.createElement("style");
      syncStyle.dataset.hyperTwitchStreamSyncStyle = "";
      syncStyle.textContent = SYNC_STYLE_TEXT;
      parent.append(syncStyle);
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

        const button = globalThis.document.createElement("button");

        button.type = "button";
        button.dataset.hyperTwitchStreamSync = "";
        button.setAttribute("aria-label", "Sync live streams to the same moment");
        button.addEventListener("click", onSyncButtonClick);

        syncButton = button;

        if (syncRequested) {
          setSyncButtonState("waiting");
        } else {
          setSyncButtonState("sync");
        }
      }

      ensureSyncStyle();

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

      if (vodStartMs === undefined && !vodRequest) {
        const request = fetchArchiveStart(mode.videoId, signal);

        vodRequest = request;

        void request.then((startMs) => {
          if (vodRequest !== request) {
            return;
          }

          vodRequest = undefined;

          if (isInactive() || currentVideo !== video || currentMode?.key !== mode.key) {
            return;
          }

          vodStartMs = startMs;
          notifyTimelineSubscribers();
        });
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
          (mode.kind === "live" && syncControlsMounted);

        if (!tracksTimeline || !video) {
          deactivate();

          return;
        }

        const modeChanged =
          currentMode === undefined ||
          currentMode.key !== mode.key ||
          currentMode.kind !== mode.kind;

        if (modeChanged || video !== currentVideo) {
          resetSyncState();

          if (currentMode?.kind === "live" && mode.kind !== "live") {
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

        notifyTimelineSubscribers();

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

        const response = await sendMessage({
          sessionId,
          type: streamTimeMessages.getLatestSegment,
        });

        if (isInactive() || currentVideo !== video || currentMode?.key !== mode.key) {
          return;
        }

        if (
          !anchor &&
          isStreamTimeSegment(response) &&
          Date.now() - response.completedAt <= MAX_SEGMENT_AGE_MS &&
          response.url !== pendingSegment?.url
        ) {
          pendingSegment = response;
        }

        const bufferEnd = getBufferEnd(video);

        if (pendingSegment && Date.now() - pendingSegment.completedAt > MAX_SEGMENT_AGE_MS) {
          pendingSegment = undefined;
        }

        if (
          !anchor &&
          pendingSegment &&
          bufferEnd !== null &&
          !video.paused &&
          video.readyState >= HAVE_FUTURE_DATA &&
          Date.now() - pendingSegment.completedAt >= APPEND_GRACE_MS
        ) {
          // Keep the initial affine mapping stable. A later network completion does not prove
          // that the current buffer end belongs to that same segment.
          anchor = {
            absoluteEndMs: pendingSegment.programDateTimeMs + pendingSegment.durationMs,
            mediaEnd: bufferEnd,
            url: pendingSegment.url,
          };

          pendingSegment = undefined;
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
