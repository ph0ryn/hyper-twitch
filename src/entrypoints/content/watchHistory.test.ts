import { afterEach, assert, test, vi } from "vitest";

import { browser, type ContentScriptContext } from "#imports";

import { watchHistoryRuntime } from "./watchHistory";

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

afterEach(() => {
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
