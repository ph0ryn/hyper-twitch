// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { keyboardShortcutsRuntime } from "./keyboardShortcuts";
import { overlayFeedbackRuntime } from "./overlayFeedback";
import { skipMutedSegmentsRuntime } from "./skipMutedSegments";

import type { ContentScriptContext } from "#imports";

const ctx = {} as ContentScriptContext;
let cleanup = () => {};
let cleanupOverlay = () => {};
let cleanupKeyboard = () => {};
let video = globalThis.document.createElement("video");

function metadata(nodes = [{ duration: 180, offset: 13680 }], id = "2873681373") {
  return {
    data: { video: { id, muteInfo: { mutedSegmentConnection: { nodes } } } },
  };
}

function createVideo() {
  const element = globalThis.document.createElement("video");

  Object.defineProperties(element, {
    duration: { configurable: true, value: 48180 },
    paused: { configurable: true, value: false },
    readyState: { configurable: true, value: 4 },
    seeking: { configurable: true, value: false },
  });

  globalThis.document.querySelector('[data-a-target="video-player"]')!.replaceChildren(element);

  return element;
}

function update(position: number, event = "timeupdate") {
  video.currentTime = position;
  video.dispatchEvent(new Event(event));
}

async function mount(response = metadata()) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response));
  cleanup = skipMutedSegmentsRuntime.mount(ctx, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.window.history.replaceState(null, "", "/videos/2873681373");
  globalThis.document.body.innerHTML = '<div data-a-target="video-player"></div>';
  video = createVideo();
});

afterEach(() => {
  cleanup();
  cleanupOverlay();
  cleanupKeyboard();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.document.body.replaceChildren();
});

test("shows the skipped mute duration and hides feedback without disabling skipping", async () => {
  cleanupOverlay = overlayFeedbackRuntime.mount(ctx, new AbortController().signal);
  await mount();
  update(13700);
  expect(video.currentTime).toBe(13860);

  expect(globalThis.document.querySelector("[data-hyper-twitch-feedback]")?.textContent).toBe(
    "Skipped muted section · +160 s",
  );

  await vi.advanceTimersByTimeAsync(2000);
  expect(globalThis.document.querySelector("[data-hyper-twitch-feedback]")).toBeNull();
  cleanupOverlay();
  update(13680);
  expect(video.currentTime).toBe(13860);
  expect(globalThis.document.querySelector("[data-hyper-twitch-feedback]")).toBeNull();
});

test("skips the reported VOD mute interval on entry, with an exclusive end", async () => {
  await mount();
  update(13679.9);
  expect(video.currentTime).toBe(13679.9);
  update(13680);
  expect(video.currentTime).toBe(13860);
  update(13859.9);
  expect(video.currentTime).toBe(13860);
  update(13860);
  expect(video.currentTime).toBe(13860);
  update(14000);
  expect(video.currentTime).toBe(14000);
});

test("cancels a pending keyboard skip without clearing automatic skip feedback", async () => {
  cleanupOverlay = overlayFeedbackRuntime.mount(ctx, new AbortController().signal);
  cleanupKeyboard = keyboardShortcutsRuntime.mount(ctx, new AbortController().signal);
  await mount();
  video.currentTime = 13679.9;

  video.dispatchEvent(
    new globalThis.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
  );

  video.dispatchEvent(new globalThis.KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
  update(13680);
  // Browsers emit seeking asynchronously after currentTime is assigned.
  video.dispatchEvent(new Event("seeking"));
  await vi.advanceTimersByTimeAsync(300);
  expect(video.currentTime).toBe(13860);

  expect(globalThis.document.querySelector("[data-hyper-twitch-feedback]")?.textContent).toBe(
    "Skipped muted section · +180 s",
  );
});

test("skips when metadata arrives during the muted section", async () => {
  video.currentTime = 13700;
  await mount();
  expect(video.currentTime).toBe(13860);
});

test("merges touching and overlapping mute intervals before seeking", async () => {
  await mount(
    metadata([
      { duration: 30, offset: 180 },
      { duration: 60, offset: 100 },
      { duration: 30, offset: 150 },
      { duration: 20, offset: 300 },
    ]),
  );

  update(100);
  expect(video.currentTime).toBe(210);
  update(250);
  expect(video.currentTime).toBe(250);
  update(305);
  expect(video.currentTime).toBe(320);
});

test("waits while paused or seeking, then skips on resume or seek completion", async () => {
  await mount();
  Object.defineProperty(video, "paused", { configurable: true, value: true });
  update(13700);
  expect(video.currentTime).toBe(13700);
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  video.dispatchEvent(new Event("playing"));
  expect(video.currentTime).toBe(13860);
  Object.defineProperty(video, "seeking", { configurable: true, value: true });
  update(13700);
  expect(video.currentTime).toBe(13700);
  Object.defineProperty(video, "seeking", { configurable: true, value: false });
  video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(13860);
});

test("handles a replaced player and stops immediately after cleanup", async () => {
  await mount();
  video = createVideo();
  update(13700, "loadedmetadata");
  expect(video.currentTime).toBe(13860);
  cleanup();
  update(13700);
  expect(video.currentTime).toBe(13700);
});

test("leaves other videos and a different route alone", async () => {
  await mount();
  const preview = globalThis.document.createElement("video");

  globalThis.document.body.append(preview);
  preview.currentTime = 13700;
  preview.dispatchEvent(new Event("timeupdate"));
  expect(preview.currentTime).toBe(13700);
  globalThis.window.history.replaceState(null, "", "/videos/456");
  update(13700);
  expect(video.currentTime).toBe(13700);
});

test.each(["video-ad-label", "video-ad-countdown", "ad-countdown-progress-bar"])(
  "does not seek while Twitch displays %s",
  async (target) => {
    await mount(metadata([{ duration: 180, offset: 0 }]));
    const marker = globalThis.document.createElement("span");

    marker.dataset.aTarget = target;
    video.parentElement!.append(marker);
    update(5);
    expect(video.currentTime).toBe(5);
    marker.remove();
    update(5, "playing");
    expect(video.currentTime).toBe(180);
  },
);

test.each(["/channel", "/channel/clip/example", "/directory"])(
  "does not request metadata or seek on %s",
  async (pathname) => {
    globalThis.window.history.replaceState(null, "", pathname);
    await mount();
    update(13700);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(13700);
  },
);

test("supports the channel VOD route and leaves a VOD with no muted sections alone", async () => {
  globalThis.window.history.replaceState(null, "", "/channel/video/2873681373");
  await mount(metadata([]));
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  update(13700);
  expect(video.currentTime).toBe(13700);
  await vi.advanceTimersByTimeAsync(60000);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("clamps a muted tail at the video end and ignores an unready player", async () => {
  await mount(metadata([{ duration: 180, offset: 48100 }]));
  Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
  update(48110);
  expect(video.currentTime).toBe(48110);
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(48180);
});

test("reports a failed request, retries, and cancels retries on disable", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(Response.json(metadata()));

  video.currentTime = 13700;
  cleanup = skipMutedSegmentsRuntime.mount(ctx, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalled();
  expect(video.currentTime).toBe(13700);
  await vi.advanceTimersByTimeAsync(4999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(video.currentTime).toBe(13860);
  cleanup();
  request.mockResolvedValue(new Response(null, { status: 503 }));
  cleanup = skipMutedSegmentsRuntime.mount(ctx, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  cleanup();
  await vi.advanceTimersByTimeAsync(60000);
  expect(request).toHaveBeenCalledTimes(3);
});

test("aborts an in-flight request and ignores its late result", async () => {
  let resolve = (_response: Response) => {};
  const request = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const controller = new AbortController();

  cleanup = skipMutedSegmentsRuntime.mount(ctx, controller.signal);
  controller.abort();
  expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  resolve(Response.json(metadata()));
  await vi.advanceTimersByTimeAsync(0);
  update(13700);
  expect(video.currentTime).toBe(13700);
});

test.each([
  { errors: [{ message: "Unavailable" }], ...metadata() },
  metadata([{ duration: -1, offset: 13680 }]),
  metadata([{ duration: 180, offset: -1 }]),
  metadata(undefined, "456"),
  { data: { video: { id: "2873681373" } } },
])("reports invalid metadata without seeking", async (response) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await mount(response as ReturnType<typeof metadata>);
  update(13700);
  expect(video.currentTime).toBe(13700);
  expect(error).toHaveBeenCalled();
});
