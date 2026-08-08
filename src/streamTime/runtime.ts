import { browser, type ContentScriptContext } from "#imports";

import {
  interpolateArchiveTime,
  interpolateStreamTime,
  streamTimeMessages,
  type StreamTimeAnchor,
  type StreamTimeSegment,
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

    if (root.parentElement !== placement.parent || root.nextElementSibling) {
      placement.parent.append(root);
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

async function sendMessage(type: string, sessionId: string) {
  try {
    return (await browser.runtime.sendMessage({ sessionId, type })) as unknown;
  } catch {
    return null;
  }
}

export const streamTimeRuntime = {
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

    const unsubscribe = () => {
      if (!subscriptionRequested) {
        return;
      }

      const closedSessionId = sessionId;

      sessionId = globalThis.crypto.randomUUID();
      subscriptionRequested = false;
      subscribed = false;
      void sendMessage(streamTimeMessages.unsubscribe, closedSessionId);
    };

    const deactivate = () => {
      unsubscribe();
      currentVideo = null;
      currentMode = undefined;
      resetTimeline();
      removeClocks();
    };

    const subscribe = async (video: HTMLVideoElement) => {
      const requestedSessionId = sessionId;

      subscriptionRequested = true;

      const response = await sendMessage(streamTimeMessages.subscribe, requestedSessionId);

      if (
        isInactive() ||
        currentVideo !== video ||
        currentMode?.kind !== "live" ||
        sessionId !== requestedSessionId
      ) {
        if (response !== null) {
          void sendMessage(streamTimeMessages.unsubscribe, requestedSessionId);
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
        const placement = findClockPlacement(mode.kind);
        const video = findVideo();

        if (!placement || !video) {
          deactivate();

          return;
        }

        if (mode.kind === "vod" && vodStartKey === mode.key && vodStartMs === null) {
          removeClocks();

          return;
        }

        const clock = ensureClock(placement);
        const modeChanged =
          currentMode === undefined ||
          currentMode.key !== mode.key ||
          currentMode.kind !== mode.kind;

        if (modeChanged || video !== currentVideo) {
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
            subscribed = await subscribe(video);

            return;
          }
        }

        if (mode.kind === "vod") {
          await updateVod(clock, mode, video);

          return;
        }

        if (!subscribed) {
          renderClock(clock);
          subscribed = await subscribe(video);

          if (!subscribed) {
            return;
          }
        }

        const response = await sendMessage(streamTimeMessages.getLatestSegment, sessionId);

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

          return;
        }

        renderClock(clock, interpolateStreamTime(anchor, video.currentTime));
      } catch {
        removeClocks();
      } finally {
        updating = false;
      }
    };

    const intervalId = ctx.setInterval(() => void update(), UPDATE_INTERVAL_MS);

    void update();

    return () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearInterval(intervalId);
      deactivate();
    };
  },
};
