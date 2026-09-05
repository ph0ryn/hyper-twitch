// @vitest-environment happy-dom
import { afterEach, assert, test, vi } from "vitest";

import { subscribeStreamTimeline, type StreamTimelineSnapshot } from "./streamTime";

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
