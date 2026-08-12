import type { PlaybackKind } from "./playback";

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

interface ClockPlacement {
  before?: HTMLElement;
  kind: PlaybackKind;
  nativeTime?: HTMLElement;
  nativeWrapper?: HTMLElement;
  parent: HTMLElement;
}

export interface ClockElements {
  root: HTMLElement;
  timer: HTMLElement;
  visibleText: HTMLElement;
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

function findNativeLiveTime() {
  return [...globalThis.document.querySelectorAll<HTMLElement>(".live-time")].find(
    (element) =>
      !element.closest(CLOCK_SELECTOR) &&
      element.getClientRects().length > 0 &&
      hasShareAncestor(element),
  );
}

function findShareButton() {
  for (const selector of [VOD_SHARE_SELECTOR, SHARE_SELECTOR]) {
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

export function findClockPlacement(kind: PlaybackKind): ClockPlacement | null {
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

export function ensureClock(placement: ClockPlacement): ClockElements {
  let root = globalThis.document.querySelector<HTMLElement>(CLOCK_SELECTOR);
  let created = false;

  if (root && root.dataset.hyperTwitchStreamTimeKind !== placement.kind) {
    root.remove();
    root = null;
  }

  if (!root) {
    created = true;

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

  if (created) {
    styleClock(root, timer, placement.kind);
  }

  return { root, timer, visibleText };
}

export function removeClocks() {
  globalThis.document.querySelectorAll(CLOCK_SELECTOR).forEach((element) => element.remove());
}

export function renderClock(clock: ClockElements, timestamp?: number) {
  let renderKey = "syncing";

  if (timestamp !== undefined) {
    renderKey = String(Math.floor(timestamp / 1_000));
  }

  if (clock.root.dataset.renderKey === renderKey) {
    return;
  }

  let accessibleText = "syncing";
  let visibleText = "syncing…";

  if (timestamp !== undefined) {
    accessibleText = accessibleFormatter.format(timestamp);
    visibleText = visibleFormatter.format(timestamp);
  }

  const nextAccessibleText = `Approximate stream time: ${accessibleText}`;

  clock.root.dataset.renderKey = renderKey;
  clock.visibleText.textContent = `≈ ${visibleText}`;
  clock.timer.setAttribute("aria-label", nextAccessibleText);
  clock.root.title = nextAccessibleText;
}
