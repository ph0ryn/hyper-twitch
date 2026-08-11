import { afterEach, assert, test, vi } from "vitest";

import { browser } from "#imports";

import { streamTimeMessages } from "../../utils/streamTime/protocol";
import { installStreamTimeBackground } from "./streamTime";

type Listener = (...arguments_: unknown[]) => unknown;

const listeners = {
  beforeRequest: undefined as Listener | undefined,
  message: undefined as Listener | undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

test("stops and restarts playlist capture with the content session", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 500 }));

  vi.spyOn(browser.tabs.onRemoved, "addListener").mockImplementation(() => {});

  vi.spyOn(browser.webRequest.onBeforeRequest, "addListener").mockImplementation((listener) => {
    listeners.beforeRequest = listener as Listener;
  });

  vi.spyOn(browser.webRequest.onCompleted, "addListener").mockImplementation(() => {});

  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation((listener) => {
    listeners.message = listener as Listener;
  });

  installStreamTimeBackground();

  const sendMessage = listeners.message;
  const sendBeforeRequest = listeners.beforeRequest;

  assert.ok(sendMessage);
  assert.ok(sendBeforeRequest);

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
