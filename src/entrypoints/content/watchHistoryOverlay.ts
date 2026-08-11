import {
  playbackTimestampToMs,
  watchRangesToOverlay,
  type WatchRange,
} from "../../utils/watchHistory/model";

import type { StreamTimelineSnapshot } from "./streamTime";

const OVERLAY_SELECTOR = "[data-hyper-twitch-watch-history]";
const PREVIEW_IMAGE_SELECTOR = '[data-test-selector="vod-seekbar-preview-overlay-preview-image"]';
const PREVIEW_INDICATOR_SELECTOR = "[data-hyper-twitch-watch-history-preview]";
const PREVIEW_WRAPPER_SELECTOR = ".vod-seekbar-preview-overlay__wrapper";
const SEEK_BAR_SELECTOR = '[data-test-selector="seekbar-interaction-area__interactionArea"]';
const SEEK_BAR_TRACK_SELECTOR = ".seekbar-bar";
const WATCHED_SEGMENT_COLOR = "#00e5ff";

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

function removePreviewIndicators() {
  globalThis.document
    .querySelectorAll(PREVIEW_INDICATOR_SELECTOR)
    .forEach((element) => element.remove());
}

export function removeWatchHistoryOverlays() {
  globalThis.document.querySelectorAll(OVERLAY_SELECTOR).forEach((element) => element.remove());
  removePreviewIndicators();
}

function renderPreviewIndicator(video: HTMLVideoElement, ranges: readonly WatchRange[]) {
  const player = video.closest<HTMLElement>('[data-a-target="video-player"]');
  let previewImage: HTMLElement | undefined = undefined;
  let timestampMs: number | null = null;

  for (const wrapper of player?.querySelectorAll<HTMLElement>(PREVIEW_WRAPPER_SELECTOR) ?? []) {
    const image = wrapper.querySelector<HTMLElement>(PREVIEW_IMAGE_SELECTOR);
    const timestamp = playbackTimestampToMs(wrapper.querySelector("p")?.textContent);

    if (image && image.getClientRects().length > 0 && timestamp !== null) {
      previewImage = image;
      timestampMs = timestamp;

      break;
    }
  }

  let indicator = previewImage?.querySelector<HTMLElement>(PREVIEW_INDICATOR_SELECTOR);

  for (const existing of globalThis.document.querySelectorAll<HTMLElement>(
    PREVIEW_INDICATOR_SELECTOR,
  )) {
    if (existing !== indicator) {
      existing.remove();
    }
  }

  const watched =
    timestampMs !== null &&
    ranges.some(([startMs, endMs]) => startMs < timestampMs + 1_000 && endMs > timestampMs);

  if (!previewImage || !watched) {
    indicator?.remove();

    return;
  }

  if (!indicator) {
    indicator = globalThis.document.createElement("span");
    indicator.dataset.hyperTwitchWatchHistoryPreview = "";
    indicator.setAttribute("aria-hidden", "true");
    indicator.style.boxShadow = `inset 0 0 0 3px ${WATCHED_SEGMENT_COLOR}`;
    indicator.style.inset = "0";
    indicator.style.pointerEvents = "none";
    indicator.style.position = "absolute";
    indicator.style.zIndex = "2";
    previewImage.append(indicator);
  }
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

export function renderWatchHistoryOverlay(
  snapshot: Extract<StreamTimelineSnapshot, { kind: "vod" }>,
  ranges: readonly WatchRange[],
) {
  const durationMs = Math.round(snapshot.video.duration * 1_000);
  const anchor = findSeekBar(snapshot.video);

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    removeWatchHistoryOverlays();

    return;
  }

  renderPreviewIndicator(snapshot.video, ranges);

  if (!anchor) {
    globalThis.document.querySelectorAll(OVERLAY_SELECTOR).forEach((element) => element.remove());

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
