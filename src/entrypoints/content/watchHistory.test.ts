// @vitest-environment happy-dom
import { afterEach, assert, test, vi } from "vitest";

import { browser, type ContentScriptContext } from "#imports";

import { watchHistoryRuntime } from "./watchHistory";

import type { WatchHistoryRequest } from "../../utils/watchHistory/protocol";
import type { StreamTimelineSnapshot } from "./streamTime";

const streamTimeMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));

vi.mock("./streamTime", () => ({
  subscribeStreamTimeline: streamTimeMocks.subscribe,
}));

vi.mock("./watchHistoryOverlay", () => ({
  removeWatchHistoryOverlays: vi.fn(),
  renderWatchHistoryOverlay: vi.fn(),
}));

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }

  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  streamTimeMocks.subscribe.mockReset();
});

test("retries the final watch-history write once after cleanup", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());

  let playedEndSeconds = 0;
  let playedLength = 0;
  const video = {
    addEventListener: vi.fn(),
    played: {
      end: () => playedEndSeconds,
      get length() {
        return playedLength;
      },
      start: () => 0,
    },
  } as unknown as HTMLVideoElement;

  streamTimeMocks.subscribe.mockImplementation(
    (_ctx: ContentScriptContext, _signal: AbortSignal, subscriber: (value: unknown) => void) => {
      subscriber({
        anchor: { absoluteEndMs: 1_000_000, mediaEnd: 10 },
        key: "live:/example_channel",
        kind: "live",
        video,
      });

      return () => {};
    },
  );

  const sendMessage = vi
    .spyOn(browser.runtime, "sendMessage")
    .mockRejectedValue(new Error("background unavailable"));
  const controller = new AbortController();
  const cleanup = watchHistoryRuntime.mount({} as ContentScriptContext, controller.signal);

  playedEndSeconds = 10;
  playedLength = 1;
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);

  assert.strictEqual(sendMessage.mock.calls.length, 1);

  await vi.advanceTimersByTimeAsync(5_000);

  assert.strictEqual(sendMessage.mock.calls.length, 2);

  await vi.advanceTimersByTimeAsync(5_000);

  assert.strictEqual(sendMessage.mock.calls.length, 2);
  cleanup();
});

function mockMessages(
  resolve: (message: WatchHistoryRequest) => Promise<unknown> = async () => ({ record: {} }),
) {
  const requests: WatchHistoryRequest[] = [];

  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(((message: WatchHistoryRequest) => {
    requests.push(message);

    return resolve(message);
  }) as typeof browser.runtime.sendMessage);

  return requests;
}

function createVideo(playedEnd = 30) {
  const video = globalThis.document.createElement("video");
  let end = playedEnd;

  Object.defineProperties(video, {
    paused: { configurable: true, value: false },
    played: {
      value: {
        end: () => end,
        get length() {
          return Number(end > 0);
        },
        start: () => 0,
      },
    },
    seeking: { configurable: true, value: false },
  });

  return {
    setPlayedEnd: (value: number) => {
      end = value;
    },
    video,
  };
}

function mountHistory(snapshot: StreamTimelineSnapshot) {
  let subscriber: (value: StreamTimelineSnapshot) => void = () => {};

  streamTimeMocks.subscribe.mockImplementation(
    (_ctx: ContentScriptContext, _signal: AbortSignal, next: typeof subscriber) => {
      subscriber = next;
      next(snapshot);

      return () => {};
    },
  );

  const cleanup = watchHistoryRuntime.mount(
    {} as ContentScriptContext,
    new AbortController().signal,
  );

  cleanups.push(cleanup);

  return { cleanup, navigate: (next: StreamTimelineSnapshot) => subscriber(next) };
}

test.each(["vod", "live"])(
  "records replayed %s sections after enabling history without recording unwatched baseline sections",
  async (kind) => {
    vi.useFakeTimers();
    const { video } = createVideo();
    const requests = mockMessages();

    video.currentTime = 5;
    let offsetMs = 0;

    if (kind === "live") {
      offsetMs = 1_000_000;

      mountHistory({
        anchor: { absoluteEndMs: offsetMs, mediaEnd: 0 },
        key: "live:/example",
        kind: "live",
        video,
      });
    } else {
      mountHistory({ archiveStartMs: 1000000, key: "vod:123", kind: "vod", video, videoId: "123" });
    }

    video.dispatchEvent(new Event("playing"));
    video.currentTime = 10;
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(0);
    const writes = requests.filter(
      (message) =>
        message.type === "watchHistory:mergeVodRanges" ||
        message.type === "watchHistory:mergeLiveRanges",
    );

    const write = writes.at(-1);

    assert.ok(write);
    assert.deepEqual(write.ranges, [[offsetMs + 5000, offsetMs + 10000]]);
  },
);

test("does not record seeked-over baseline sections", async () => {
  vi.useFakeTimers();
  const { video } = createVideo();
  const requests = mockMessages();

  mountHistory({ archiveStartMs: 1000000, key: "vod:123", kind: "vod", video, videoId: "123" });
  video.dispatchEvent(new Event("playing"));
  Object.defineProperty(video, "seeking", { configurable: true, value: true });
  video.currentTime = 20;
  video.dispatchEvent(new Event("seeking"));
  Object.defineProperty(video, "seeking", { configurable: true, value: false });
  video.dispatchEvent(new Event("seeked"));
  video.currentTime = 25;
  video.dispatchEvent(new Event("timeupdate"));
  video.dispatchEvent(new Event("pause"));
  await vi.advanceTimersByTimeAsync(0);
  const writes = requests.filter((message) => message.type === "watchHistory:mergeVodRanges");

  const write = writes.at(-1);

  assert.ok(write);
  assert.deepEqual(write.ranges, [[20000, 25000]]);
});

test.each(["navigation", "cleanup"])(
  "preserves watched sections until delayed VOD metadata arrives after %s",
  async (transition) => {
    vi.useFakeTimers();
    const metadata = Promise.withResolvers<unknown>();
    const { video, setPlayedEnd } = createVideo(0);
    const requests = mockMessages(async (message) => {
      if (message.type === "watchHistory:getVodMetadata") {
        return metadata.promise;
      }

      return { record: {} };
    });
    const runtime = mountHistory({
      archiveStartMs: undefined,
      key: "vod:123",
      kind: "vod",
      video,
      videoId: "123",
    });

    setPlayedEnd(10);
    video.currentTime = 10;
    video.dispatchEvent(new Event("timeupdate"));

    if (transition === "cleanup") {
      runtime.cleanup();
    } else {
      runtime.navigate({ key: "live:/example", kind: "live", video: createVideo(0).video });
    }

    // Playback after detach must not be added to the captured write.
    setPlayedEnd(20);
    video.currentTime = 20;
    video.dispatchEvent(new Event("timeupdate"));

    metadata.resolve({
      broadcastType: "ARCHIVE",
      kind: "vod",
      login: "example",
      ownerId: "42",
      recordedAtMs: 1000000,
      videoId: "123",
    });

    await vi.advanceTimersByTimeAsync(0);
    const writes = requests.filter((message) => message.type === "watchHistory:mergeVodRanges");

    const write = writes.at(-1);

    assert.ok(write);
    assert.strictEqual(write.videoId, "123");
    assert.deepEqual(write.ranges, [[0, 10000]]);
  },
);
