import { browser, type ContentScriptContext } from "#imports";

import {
  interpolateArchiveTime,
  interpolateStreamTime,
  streamTimeMessages,
  type StreamTimeRequest,
  type StreamTimeAnchor,
  type StreamTimeSegment,
  type StreamSyncReport,
  type StreamSyncResponse,
} from "./protocol";

const APPEND_GRACE_MS = 200;
const HAVE_FUTURE_DATA = 3;
const HAVE_METADATA = 1;
const MAX_SEGMENT_AGE_MS = 15_000;
const UPDATE_INTERVAL_MS = 500;
const CLOCK_SELECTOR = "[data-hyper-twitch-stream-time]";
const SHARE_SELECTOR = 'button[data-a-target="share-button"], button[aria-label="Share"]';
const VOD_SHARE_SELECTOR =
  '[data-test-selector="metadata-layout__split-top"] button[aria-label="Share"]';
const VIDEO_OPTIONS_SELECTOR = 'button[aria-label="Video Options"]';
const SYNC_REWIND_THRESHOLD_SECONDS = 0.75;
const SYNC_BUFFER_MARGIN_SECONDS = 0.25;

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
}

interface SharedStreamTimeRuntime {
  cleanup: () => void;
  controller: AbortController;
  references: number;
}

let activeStreamTimeController: StreamTimeController | undefined = undefined;
let sharedStreamTimeRuntime: SharedStreamTimeRuntime | undefined = undefined;
let streamTimeDisplayReferences = 0;

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
  try {
    const url = new URL(`/videos/${videoId}`, globalThis.location.origin);
    const response = await globalThis.fetch(url, {
      cache: "no-store",
      credentials: "omit",
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    if (signal.aborted) {
      return null;
    }

    return parseArchiveStart(new globalThis.DOMParser().parseFromString(html, "text/html"));
  } catch {
    return null;
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
    let syncJoinedAt: number | undefined = undefined;
    let syncJoinedCurrentAbsoluteMs: number | undefined = undefined;
    let syncRequested = false;
    let syncRequestVersion = 0;
    let syncRoot: HTMLElement | undefined = undefined;
    let syncRootStyle: string | null | undefined = undefined;
    let syncSignal: AbortSignal | undefined = undefined;

    const isInactive = () => cleaned || signal.aborted;

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

      const labels = {
        buffering: "Buffering…",
        sync: "Sync",
        synced: "Synced",
        waiting: "Waiting…",
      } as const;

      syncButton.textContent = labels[state];
      syncButton.setAttribute("aria-pressed", String(syncRequested));

      if (state === "sync") {
        syncButton.title = "Sync live streams to the same moment";
      } else {
        syncButton.title = "Stop syncing live streams";
      }
    };

    const restoreSyncRoot = () => {
      if (!syncRoot) {
        return;
      }

      if (syncRootStyle === null) {
        syncRoot.removeAttribute("style");
      } else if (syncRootStyle !== undefined) {
        syncRoot.setAttribute("style", syncRootStyle);
      }

      syncRoot = undefined;
      syncRootStyle = undefined;
    };

    const removeSyncButton = () => {
      syncButton?.remove();
      syncButton = undefined;
      restoreSyncRoot();
    };

    const leaveSync = () => {
      void sendMessage({ sessionId, type: streamTimeMessages.leaveSync });
    };

    const resetSyncState = () => {
      if (syncRequested) {
        syncRequestVersion += 1;
        leaveSync();
      }

      syncRequested = false;
      syncJoinedAt = undefined;
      syncJoinedCurrentAbsoluteMs = undefined;
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
        setSyncButtonState("waiting");
      } else {
        leaveSync();
        syncJoinedAt = undefined;
        syncJoinedCurrentAbsoluteMs = undefined;
        setSyncButtonState("sync");
      }
    };

    const ensureSyncButton = (clock: ClockElements) => {
      if (!syncControlsMounted) {
        return;
      }

      if (syncButton?.parentElement !== clock.root) {
        syncRequestVersion += 1;
        removeSyncButton();
        syncRoot = clock.root;
        syncRootStyle = clock.root.getAttribute("style");

        const button = globalThis.document.createElement("button");

        button.type = "button";
        button.dataset.hyperTwitchStreamSync = "";
        button.setAttribute("aria-label", "Sync live streams to the same moment");
        button.style.background = "transparent";
        button.style.border = "0";
        button.style.color = "inherit";
        button.style.cursor = "pointer";
        button.style.font = "inherit";
        button.style.fontSize = "12px";
        button.style.fontVariantNumeric = "tabular-nums";
        button.style.lineHeight = "16px";
        button.style.marginBlockStart = "2px";
        button.style.minInlineSize = "10ch";
        button.style.paddingBlock = "0px";
        button.style.paddingInline = "4px";
        button.addEventListener("click", onSyncButtonClick);

        clock.root.append(button);
        clock.root.style.alignItems = "center";
        clock.root.style.display = "flex";
        clock.root.style.flexDirection = "column";
        syncButton = button;

        if (syncRequested) {
          setSyncButtonState("waiting");
        } else {
          setSyncButtonState("sync");
        }
      }
    };

    const findBufferedRange = (video: HTMLVideoElement, time: number) => {
      try {
        for (let index = 0; index < video.buffered.length; index += 1) {
          const start = video.buffered.start(index);
          const end = video.buffered.end(index);

          if (start <= time && time <= end) {
            return { end, start };
          }
        }
      } catch {
        return null;
      }

      return null;
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
        video.readyState < HAVE_FUTURE_DATA ||
        !Number.isFinite(video.currentTime)
      ) {
        return null;
      }

      const range = findBufferedRange(video, video.currentTime);

      if (!range) {
        return null;
      }

      const bufferedStartAbsoluteMs = interpolateStreamTime(streamAnchor, range.start);
      const bufferedEndAbsoluteMs = interpolateStreamTime(streamAnchor, range.end);
      const currentAbsoluteMs = interpolateStreamTime(streamAnchor, video.currentTime);
      const reportedAt = Date.now();

      if (
        !Number.isFinite(bufferedStartAbsoluteMs) ||
        !Number.isFinite(bufferedEndAbsoluteMs) ||
        !Number.isFinite(currentAbsoluteMs)
      ) {
        return null;
      }

      if (syncJoinedAt === undefined || syncJoinedCurrentAbsoluteMs === undefined) {
        syncJoinedAt = reportedAt;
        syncJoinedCurrentAbsoluteMs = currentAbsoluteMs;
      }

      return {
        bufferedEndAbsoluteMs,
        bufferedStartAbsoluteMs,
        currentAbsoluteMs,
        joinedAt: syncJoinedAt,
        joinedCurrentAbsoluteMs: syncJoinedCurrentAbsoluteMs,
        reportedAt,
      } satisfies StreamSyncReport;
    };

    const applySyncTarget = (
      video: HTMLVideoElement,
      streamAnchor: StreamTimeAnchor,
      targetAbsoluteMs: number,
    ) => {
      if (
        video.paused ||
        video.seeking ||
        video.readyState < HAVE_METADATA ||
        !Number.isFinite(video.currentTime) ||
        !Number.isFinite(targetAbsoluteMs)
      ) {
        return "buffering" as const;
      }

      const targetMedia =
        streamAnchor.mediaEnd + (targetAbsoluteMs - streamAnchor.absoluteEndMs) / 1_000;

      if (!Number.isFinite(targetMedia)) {
        return "buffering" as const;
      }

      if (targetMedia > video.currentTime + SYNC_REWIND_THRESHOLD_SECONDS) {
        return "buffering" as const;
      }

      if (targetMedia >= video.currentTime - SYNC_REWIND_THRESHOLD_SECONDS) {
        return "synced" as const;
      }

      const targetRange = findBufferedRange(video, targetMedia);

      if (
        !targetRange ||
        targetMedia < targetRange.start + SYNC_BUFFER_MARGIN_SECONDS ||
        targetMedia > targetRange.end - SYNC_BUFFER_MARGIN_SECONDS
      ) {
        return "buffering" as const;
      }

      try {
        video.currentTime = targetMedia;
      } catch {
        return "buffering" as const;
      }

      return "synced" as const;
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
        setSyncButtonState("waiting");

        return;
      }

      if (!Number.isFinite(parsed.targetAbsoluteMs)) {
        setSyncButtonState("buffering");

        return;
      }

      setSyncButtonState(applySyncTarget(video, streamAnchor, parsed.targetAbsoluteMs));
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

    const updateVod = async (
      clock: ClockElements,
      mode: VodPlaybackMode,
      video: HTMLVideoElement,
    ) => {
      resetVodStart(mode.key);

      if (vodStartMs === undefined && !vodRequest) {
        const request = fetchArchiveStart(mode.videoId, signal);

        vodRequest = request;

        const startMs = await request;

        if (vodRequest === request) {
          vodRequest = undefined;
        }

        if (isInactive() || currentVideo !== video || currentMode?.key !== mode.key) {
          return;
        }

        vodStartMs = startMs;
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
        } else {
          renderClock(clock);
        }

        return;
      }

      renderClock(clock, interpolateArchiveTime(vodStartMs, Math.max(0, video.currentTime)));
    };

    const update = async () => {
      if (updating || isInactive()) {
        return;
      }

      updating = true;

      try {
        const mode = findPlaybackMode();
        const video = findVideo();

        if (mode.kind === "vod" && streamTimeDisplayReferences === 0) {
          deactivate();

          return;
        }

        const placement = findClockPlacement(mode.kind);

        if (!placement || !video) {
          deactivate();

          return;
        }

        if (mode.kind === "vod" && vodStartKey === mode.key && vodStartMs === null) {
          resetSyncState();
          removeClocks();

          return;
        }

        const clock = ensureClock(placement);
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

          renderClock(clock);

          if (mode.kind === "live") {
            ensureSyncButton(clock);
            subscribed = await subscribe(video);

            return;
          }
        }

        if (mode.kind === "vod") {
          resetSyncState();
          await updateVod(clock, mode, video);

          return;
        }

        ensureSyncButton(clock);

        if (!subscribed) {
          renderClock(clock);
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
          isStreamTimeSegment(response) &&
          Date.now() - response.completedAt <= MAX_SEGMENT_AGE_MS &&
          response.url !== pendingSegment?.url &&
          response.url !== anchor?.url
        ) {
          pendingSegment = response;
        }

        const bufferEnd = getBufferEnd(video);

        if (pendingSegment && Date.now() - pendingSegment.completedAt > MAX_SEGMENT_AGE_MS) {
          pendingSegment = undefined;
        }

        if (
          pendingSegment &&
          bufferEnd !== null &&
          !video.paused &&
          video.readyState >= HAVE_FUTURE_DATA &&
          Date.now() - pendingSegment.completedAt >= APPEND_GRACE_MS
        ) {
          anchor = {
            absoluteEndMs: pendingSegment.programDateTimeMs + pendingSegment.durationMs,
            mediaEnd: bufferEnd,
            url: pendingSegment.url,
          };

          pendingSegment = undefined;
        }

        if (!anchor || video.readyState < HAVE_FUTURE_DATA || !Number.isFinite(video.currentTime)) {
          renderClock(clock);

          if (syncRequested) {
            setSyncButtonState("buffering");
          }

          return;
        }

        renderClock(clock, interpolateStreamTime(anchor, video.currentTime));
        await updateSync(video, anchor);
      } catch {
        removeClocks();
      } finally {
        updating = false;
      }
    };

    const controller: StreamTimeController = { mountSyncControls };

    activeStreamTimeController = controller;

    const intervalId = ctx.setInterval(() => void update(), UPDATE_INTERVAL_MS);

    void update();

    return () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearInterval(intervalId);
      deactivate();

      if (activeStreamTimeController === controller) {
        activeStreamTimeController = undefined;
      }

      syncControlsMounted = false;
      syncSignal = undefined;
    };
  },
};

function acquireStreamTimeRuntime(ctx: ContentScriptContext, displaysArchives: boolean) {
  if (displaysArchives) {
    streamTimeDisplayReferences += 1;
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
    if (displaysArchives) {
      streamTimeDisplayReferences -= 1;
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

    if (displaysArchives) {
      streamTimeDisplayReferences -= 1;
    }

    if (shared.references === 0 && sharedStreamTimeRuntime === shared) {
      sharedStreamTimeRuntime = undefined;
      shared.controller.abort();
      shared.cleanup();
    }
  };
}

export const streamTimeRuntime = {
  mount(ctx: ContentScriptContext, _signal: AbortSignal) {
    return acquireStreamTimeRuntime(ctx, true);
  },
};

export const streamSyncRuntime = {
  mount(ctx: ContentScriptContext, signal: AbortSignal) {
    const releaseStreamTime = acquireStreamTimeRuntime(ctx, false);
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
