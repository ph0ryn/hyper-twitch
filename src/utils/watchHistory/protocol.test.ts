import { assert, test } from "vitest";

import {
  createSerialQueue,
  isLiveWatchMetadata,
  isVodWatchMetadata,
  isValidWatchRange,
  isWatchHistoryRequest,
  parseLiveWatchMetadata,
  parseVodWatchMetadata,
  watchHistoryMessages,
} from "./protocol.ts";

import type { WatchRange } from "./model.ts";

test("parses live metadata and rejects a response for another login", () => {
  const payload = {
    data: {
      user: {
        id: "42",
        login: "Creator",
        stream: {
          createdAt: "2026-08-09T00:00:00.000Z",
          id: "99",
        },
      },
    },
  };

  assert.deepEqual(parseLiveWatchMetadata(payload, "creator"), {
    createdAtMs: Date.parse("2026-08-09T00:00:00.000Z"),
    kind: "live",
    login: "creator",
    ownerId: "42",
    streamId: "99",
  });

  assert.strictEqual(parseLiveWatchMetadata(payload, "different_creator"), null);

  assert.strictEqual(
    parseLiveWatchMetadata(
      {
        data: {
          user: {
            ...payload.data.user,
            stream: { createdAt: -1, id: "99" },
          },
        },
      },
      "creator",
    ),
    null,
  );

  assert.strictEqual(
    parseLiveWatchMetadata(
      { data: { user: { id: "42", login: "creator", stream: null } } },
      "creator",
    ),
    null,
  );

  assert.strictEqual(isLiveWatchMetadata(parseLiveWatchMetadata(payload, "creator")), true);
});

test("accepts archive VOD metadata and rejects non-archives or broken payloads", () => {
  const payload = {
    data: {
      video: {
        broadcastType: "ARCHIVE",
        id: "123",
        owner: { id: "42", login: "Creator" },
        recordedAt: "2026-08-09T00:00:00.000Z",
      },
    },
  };

  assert.deepEqual(parseVodWatchMetadata(payload, "123"), {
    broadcastType: "ARCHIVE",
    kind: "vod",
    login: "creator",
    ownerId: "42",
    recordedAtMs: Date.parse("2026-08-09T00:00:00.000Z"),
    videoId: "123",
  });

  assert.strictEqual(
    parseVodWatchMetadata(
      { data: { video: { ...payload.data.video, broadcastType: "HIGHLIGHT" } } },
      "123",
    ),
    null,
  );

  assert.strictEqual(parseVodWatchMetadata({ errors: [{ message: "bad" }] }, "123"), null);

  assert.strictEqual(isVodWatchMetadata(parseVodWatchMetadata(payload, "123")), true);
});

test("validates message payloads and integer watch ranges", () => {
  assert.strictEqual(isValidWatchRange([0, 1_000]), true);

  assert.strictEqual(isValidWatchRange([0, 1.5]), false);

  assert.strictEqual(
    isWatchHistoryRequest({
      type: watchHistoryMessages.getVodMetadata,
      videoId: "123",
    }),
    true,
  );

  assert.strictEqual(
    isWatchHistoryRequest({
      ranges: [[0, 1_000]],
      type: watchHistoryMessages.mergeVodRanges,
      videoId: "123",
    }),
    true,
  );

  assert.strictEqual(
    isWatchHistoryRequest({
      ranges: [[0, 1.5]],
      type: watchHistoryMessages.mergeVodRanges,
      videoId: "123",
    }),
    false,
  );

  assert.strictEqual(isWatchHistoryRequest(null), false);

  assert.strictEqual(isWatchHistoryRequest({ type: "watchHistory:unknown" }), false);
});

test("serializes storage read-merge-write operations", async () => {
  const enqueue = createSerialQueue();
  let storedRanges: WatchRange[] = [];

  const merge = (range: WatchRange) =>
    enqueue(async () => {
      const latest = [...storedRanges];

      await Promise.resolve();
      storedRanges = [...latest, range];
    });

  await Promise.all([merge([0, 1_000]), merge([2_000, 3_000])]);

  assert.deepEqual(storedRanges, [
    [0, 1_000],
    [2_000, 3_000],
  ]);
});
