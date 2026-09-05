// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { keyboardShortcutsRuntime } from "./keyboardShortcuts";
import { overlayFeedbackRuntime } from "./overlayFeedback";

import type { ContentScriptContext } from "#imports";

let video = globalThis.document.createElement("video");
let cleanupKeyboard = () => {};
let cleanupOverlay = () => {};
const ctx = {} as ContentScriptContext;

function key(
  keyValue: string,
  type = "keydown",
  options: { repeat?: boolean; target?: EventTarget } = {},
) {
  const event = new globalThis.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: keyValue,
    repeat: options.repeat,
  });

  (options.target ?? video).dispatchEvent(event);

  return event;
}

function tap(value: string) {
  key(value);
  key(value, "keyup");
}

function feedback() {
  return globalThis.document.querySelector("[data-hyper-twitch-feedback]")?.textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.window.history.replaceState(null, "", "/videos/123");
  globalThis.document.body.innerHTML = '<div data-a-target="video-player"><video></video></div>';
  video = globalThis.document.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 1000 });
  Object.defineProperty(video, "readyState", { value: 4 });
  video.currentTime = 100;
  cleanupOverlay = overlayFeedbackRuntime.mount(ctx, new AbortController().signal);
  cleanupKeyboard = keyboardShortcutsRuntime.mount(ctx, new AbortController().signal);
});

afterEach(() => {
  cleanupKeyboard();
  cleanupOverlay();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.document.body.replaceChildren();
});

test("shows each net offset and seeks once after right, right, right, left", () => {
  const seek = vi.spyOn(video, "currentTime", "set");
  const native = vi.fn();

  video.addEventListener("keydown", native);

  for (const [value, seconds] of [
    ["ArrowRight", 10],
    ["ArrowRight", 20],
    ["ArrowRight", 30],
    ["ArrowLeft", 20],
  ] as const) {
    tap(value);
    expect(feedback()).toBe(`+${seconds} s`);
    expect(video.currentTime).toBe(100);
    vi.advanceTimersByTime(50);
  }

  expect(native).not.toHaveBeenCalled();
  expect(seek).not.toHaveBeenCalled();
  vi.advanceTimersByTime(249);
  expect(video.currentTime).toBe(100);
  vi.advanceTimersByTime(1);
  expect(video.currentTime).toBe(120);
  vi.advanceTimersByTime(1000);
  expect(video.currentTime).toBe(120);
  expect(feedback()).toBeUndefined();
  expect(seek).toHaveBeenCalledExactlyOnceWith(120);
});

test("combines J/L with arrows and supports net rewind and cancellation", () => {
  tap("j");
  tap("j");
  tap("l");
  tap("ArrowRight");
  expect(feedback()).toBe("−20 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(80);
  tap("j");
  tap("l");
  expect(feedback()).toBe("0 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(80);
});

test("holds the batch open until all held seek keys are released", () => {
  key("l");
  vi.advanceTimersByTime(1000);
  expect(video.currentTime).toBe(100);
  key("l", "keydown", { repeat: true });
  key("l", "keyup");
  vi.advanceTimersByTime(299);
  expect(video.currentTime).toBe(100);
  vi.advanceTimersByTime(1);
  expect(video.currentTime).toBe(160);
});

test("clamps the displayed amount at both ends", () => {
  video.currentTime = 5;
  tap("j");
  expect(feedback()).toBe("−5 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(0);
  video.currentTime = 995;
  tap("l");
  expect(feedback()).toBe("+5 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(1000);
});

test("overlay can be disabled without disabling shortcuts", () => {
  cleanupOverlay();
  tap("l");
  expect(feedback()).toBeUndefined();
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(130);
});

test("disabling shortcuts cancels pending work and restores native keys", () => {
  tap("l");
  cleanupKeyboard();
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(100);
  expect(feedback()).toBeUndefined();
  expect(key("ArrowRight").defaultPrevented).toBe(false);
});

test("ignores editable fields, menus, modifiers, composition, and live streams", () => {
  for (const markup of [
    "<input>",
    "<textarea></textarea>",
    '<div contenteditable="true"></div>',
    '<div role="slider" tabindex="0"></div>',
    '<div role="menu"><button>Speed</button></div>',
  ]) {
    const host = globalThis.document.createElement("div");

    host.innerHTML = markup;
    globalThis.document.body.append(host);
    expect(key("l", "keydown", { target: host.firstElementChild! }).defaultPrevented).toBe(false);
  }

  for (const options of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    const event = new globalThis.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "l",
      ...options,
    });

    video.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }

  globalThis.window.history.replaceState(null, "", "/example");
  expect(key("l").defaultPrevented).toBe(false);
  vi.advanceTimersByTime(500);
  expect(video.currentTime).toBe(100);
});

test("K toggles playback immediately and does not repeat while held", async () => {
  const play = vi.spyOn(video, "play").mockResolvedValue();

  tap("k");
  expect(play).toHaveBeenCalledTimes(1);
  key("k", "keydown", { repeat: true });
  expect(play).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  Object.defineProperty(video, "paused", { value: false });
  const pause = vi.spyOn(video, "pause");

  tap("k");
  expect(pause).toHaveBeenCalledTimes(1);
});

test("cancels on focus loss, external seek, or video replacement", () => {
  tap("l");
  globalThis.window.dispatchEvent(new Event("blur"));
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(100);
  tap("l");
  video.dispatchEvent(new Event("seeking"));
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(100);
  tap("l");
  video.remove();
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(100);
  expect(feedback()).toBeUndefined();
});

test("applies the offset to the position reached during normal playback", () => {
  tap("l");
  video.currentTime = 100.25;
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(130.25);
});

test("aborting the runtime cancels pending work and removes the overlay", () => {
  cleanupKeyboard();
  const controller = new AbortController();

  cleanupKeyboard = keyboardShortcutsRuntime.mount(ctx, controller.signal);
  tap("l");
  controller.abort();
  vi.advanceTimersByTime(1000);
  expect(video.currentTime).toBe(100);
  expect(feedback()).toBeUndefined();
  expect(key("l").defaultPrevented).toBe(false);
});

test("preserves the signed sum when opposing presses exceed either boundary", () => {
  video.currentTime = 5;
  tap("j");
  tap("j");
  tap("l");
  expect(feedback()).toBe("−5 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(0);
  video.currentTime = 995;
  tap("l");
  tap("l");
  tap("j");
  expect(feedback()).toBe("+5 s");
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(1000);
});

test("shows K feedback during a pending skip without losing the skip", () => {
  Object.defineProperty(video, "paused", { value: false });
  tap("l");
  tap("k");
  expect(feedback()).toBe("Paused");
  expect(video.currentTime).toBe(100);
  vi.advanceTimersByTime(300);
  expect(video.currentTime).toBe(130);
  expect(feedback()).toBe("+30 s");
});
