// @vitest-environment happy-dom
import { afterEach, assert, test, vi } from "vitest";

import {
  streamSyncRuntime,
  subscribeStreamTimeline,
  type StreamTimelineSnapshot,
} from "./streamTime";

import type { ContentScriptContext } from "#imports";

let cleanup = () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.document.body.replaceChildren();
});

function mountTimeline() {
  vi.useFakeTimers();
  globalThis.window.history.replaceState(null, "", "/videos/123");
  globalThis.document.body.innerHTML = '<div data-a-target="video-player"><video></video></div>';
  let latest: StreamTimelineSnapshot | undefined = undefined;
  const ctx = {
    setInterval: (callback: () => void, delay: number) => globalThis.setInterval(callback, delay),
  } as unknown as ContentScriptContext;

  cleanup = subscribeStreamTimeline(ctx, new AbortController().signal, (snapshot) => {
    latest = snapshot;
  });

  return () => latest;
}

test("retries archive metadata after a transient HTTP failure", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(
      new Response(
        '<meta name="amazonbot-content-type" content="vod"><meta property="og:video:release_date" content="2026-09-05T00:00:00Z">',
      ),
    );
  const latest = mountTimeline();

  await vi.advanceTimersByTimeAsync(1000);
  assert.strictEqual(fetchMock.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(10000);
  const snapshot = latest();

  assert.strictEqual(fetchMock.mock.calls.length, 2);
  assert.ok(snapshot?.kind === "vod");
  assert.strictEqual(snapshot.archiveStartMs, Date.parse("2026-09-05T00:00:00Z"));
});

test("does not retry a successfully fetched non-archive document", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html></html>"));
  const latest = mountTimeline();

  await vi.advanceTimersByTimeAsync(60000);
  assert.strictEqual(fetchMock.mock.calls.length, 1);
  const snapshot = latest();

  assert.ok(snapshot?.kind === "vod");
  assert.isNull(snapshot.archiveStartMs);
});

test("stops retrying archive metadata after cleanup", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network error"));

  mountTimeline();
  await vi.advanceTimersByTimeAsync(1000);
  cleanup();
  await vi.advanceTimersByTimeAsync(60000);
  assert.strictEqual(fetchMock.mock.calls.length, 1);
});

test("preserves sync controls across row replacement and removes them on abort", async () => {
  vi.useFakeTimers();
  globalThis.window.history.replaceState(null, "", "/channel");
  const metricsMarkup =
    '<div><span class="live-time"></span></div><div data-viewers><span data-a-target="animated-channel-viewers-count"></span></div><button data-a-target="share-button"></button>';

  globalThis.document.body.innerHTML = `<div data-a-target="video-player"><video></video></div><div data-metrics>${metricsMarkup}</div>`;

  vi.spyOn(globalThis.HTMLElement.prototype, "getClientRects").mockReturnValue([
    new globalThis.DOMRect(0, 0, 100, 20),
  ] as unknown as DOMRectList);

  const ctx = {
    setInterval: (callback: () => void, delay: number) => globalThis.setInterval(callback, delay),
  } as unknown as ContentScriptContext;
  const controller = new AbortController();

  cleanup = streamSyncRuntime.mount(ctx, controller.signal);
  await vi.advanceTimersByTimeAsync(1000);
  const button = globalThis.document.querySelector<HTMLButtonElement>(
    "[data-hyper-twitch-stream-sync]",
  );

  assert.ok(button);
  assert.strictEqual(button.nextElementSibling?.hasAttribute("data-viewers"), true);
  assert.strictEqual(button.textContent, "Sync");
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  button.click();
  assert.strictEqual(button.dataset.state, "waiting");
  assert.strictEqual(button.getAttribute("aria-pressed"), "true");
  assert.strictEqual(button.getAttribute("aria-busy"), "true");
  assert.strictEqual(button.getAttribute("aria-label"), "Stop syncing this live stream");

  const metrics = globalThis.document.querySelector<HTMLElement>("[data-metrics]")!;

  metrics.innerHTML = metricsMarkup;
  await vi.advanceTimersByTimeAsync(1000);
  assert.strictEqual(metrics.querySelector("[data-hyper-twitch-stream-sync]"), button);
  assert.strictEqual(button.nextElementSibling?.hasAttribute("data-viewers"), true);
  assert.strictEqual(button.getAttribute("aria-pressed"), "true");

  assert.strictEqual(
    globalThis.document.querySelectorAll("[data-hyper-twitch-stream-sync-style]").length,
    1,
  );

  button.click();
  assert.strictEqual(button.dataset.state, "sync");
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  assert.strictEqual(button.getAttribute("aria-busy"), "false");

  assert.strictEqual(
    button.getAttribute("aria-label"),
    "Sync this live stream with other live streams",
  );

  controller.abort();
  assert.isNull(globalThis.document.querySelector("[data-hyper-twitch-stream-sync]"));
  assert.isNull(globalThis.document.querySelector("[data-hyper-twitch-stream-sync-style]"));
});
