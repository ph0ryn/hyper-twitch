import { afterEach, assert, test, vi } from "vitest";

import { browser } from "#imports";

import { streamTimeMessages } from "../../utils/streamTime/protocol";
import { installStreamTimeBackground } from "./streamTime";

type Listener = (...arguments_: unknown[]) => unknown;

const listeners = {
  beforeRequest: undefined as Listener | undefined,
  completed: undefined as Listener | undefined,
  message: undefined as Listener | undefined,
};

afterEach(() => {
  listeners.beforeRequest = undefined;
  listeners.completed = undefined;
  listeners.message = undefined;
  vi.restoreAllMocks();
});

function installBackground() {
  vi.spyOn(browser.tabs.onRemoved, "addListener").mockImplementation(() => {});

  vi.spyOn(browser.webRequest.onBeforeRequest, "addListener").mockImplementation((listener) => {
    listeners.beforeRequest = listener as Listener;
  });

  vi.spyOn(browser.webRequest.onCompleted, "addListener").mockImplementation((listener) => {
    listeners.completed = listener as Listener;
  });

  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation((listener) => {
    listeners.message = listener as Listener;
  });

  installStreamTimeBackground();

  const { beforeRequest, completed, message } = listeners;

  assert.ok(beforeRequest);
  assert.ok(completed);
  assert.ok(message);

  return { sendBeforeRequest: beforeRequest, sendCompleted: completed, sendMessage: message };
}

test("stops and restarts playlist capture with the content session", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 500 }));

  const { sendBeforeRequest, sendMessage } = installBackground();

  const sender = { tab: { id: 7 } };

  await sendMessage({ sessionId: "session", type: streamTimeMessages.subscribe }, sender);
  sendBeforeRequest({ tabId: 7, url: "https://video.ttvnw.net/first.m3u8" });

  assert.strictEqual(fetchMock.mock.calls.length, 1);

  await sendMessage({ sessionId: "session", type: streamTimeMessages.captureComplete }, sender);
  sendBeforeRequest({ tabId: 7, url: "https://video.ttvnw.net/second.m3u8" });

  assert.strictEqual(fetchMock.mock.calls.length, 1);

  await sendMessage({ sessionId: "next-session", type: streamTimeMessages.subscribe }, sender);

  assert.strictEqual(
    await sendMessage({ sessionId: "session", type: streamTimeMessages.captureComplete }, sender),
    false,
  );

  sendBeforeRequest({ tabId: 7, url: "https://video.ttvnw.net/third.m3u8" });

  assert.strictEqual(fetchMock.mock.calls.length, 2);

  await sendMessage(
    { sessionId: "next-session", type: streamTimeMessages.captureComplete },
    sender,
  );

  await sendMessage(
    {
      report: { currentAbsoluteMs: 1, playbackRate: 1, reportedAt: Date.now() },
      sessionId: "next-session",
      type: streamTimeMessages.updateSync,
    },
    sender,
  );

  sendBeforeRequest({ tabId: 7, url: "https://video.ttvnw.net/fourth.m3u8" });

  assert.strictEqual(fetchMock.mock.calls.length, 2);

  await sendMessage(
    { sessionId: "restored-session", type: streamTimeMessages.getLatestSegment },
    { tab: { id: 8 } },
  );

  sendBeforeRequest({ tabId: 8, url: "https://video.ttvnw.net/restored.m3u8" });

  assert.strictEqual(fetchMock.mock.calls.length, 3);
});

test("returns the completed segment indexed from a media playlist", async () => {
  const playlistUrl = "https://video.ttvnw.net/channel/index.m3u8";
  const segmentUrl = "https://video.ttvnw.net/channel/segment.ts";
  const programDateTime = "2026-08-11T12:34:56.000Z";

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${programDateTime}\n#EXTINF:2.0,\nsegment.ts\n`,
    ),
  );

  const { sendBeforeRequest, sendCompleted, sendMessage } = installBackground();

  const sender = { tab: { id: 9 } };

  await sendMessage({ sessionId: "indexed-session", type: streamTimeMessages.subscribe }, sender);
  sendBeforeRequest({ tabId: 9, url: playlistUrl });
  sendCompleted({ tabId: 9, timeStamp: 1_234, url: segmentUrl });

  await vi.waitFor(async () => {
    assert.deepEqual(
      await sendMessage(
        { sessionId: "indexed-session", type: streamTimeMessages.getLatestSegment },
        sender,
      ),
      {
        completedAt: 1_234,
        durationMs: 2_000,
        programDateTimeMs: Date.parse(programDateTime),
        url: segmentUrl,
      },
    );
  });
});
