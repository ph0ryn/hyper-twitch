import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerialQueue,
  isLiveWatchMetadata,
  isVodWatchMetadata,
  isValidWatchRange,
  isWatchHistoryRequest,
  parseLiveWatchMetadata,
  parseVodWatchMetadata,
  watchHistoryMessages,
} from "../../src/utils/watchHistory/protocol.ts";

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

  assert.equal(parseLiveWatchMetadata(payload, "different_creator"), null);

  assert.equal(
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

  assert.equal(
    parseLiveWatchMetadata(
      { data: { user: { id: "42", login: "creator", stream: null } } },
      "creator",
    ),
    null,
  );

  assert.equal(isLiveWatchMetadata(parseLiveWatchMetadata(payload, "creator")), true);
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

  assert.equal(
    parseVodWatchMetadata(
      { data: { video: { ...payload.data.video, broadcastType: "HIGHLIGHT" } } },
      "123",
    ),
    null,
  );

  assert.equal(parseVodWatchMetadata({ errors: [{ message: "bad" }] }, "123"), null);

  assert.equal(isVodWatchMetadata(parseVodWatchMetadata(payload, "123")), true);
});

test("validates message payloads and integer watch ranges", () => {
  assert.equal(isValidWatchRange([0, 1_000]), true);

  assert.equal(isValidWatchRange([0, 1.5]), false);

  assert.equal(
    isWatchHistoryRequest({
      type: watchHistoryMessages.getVodMetadata,
      videoId: "123",
    }),
    true,
  );

  assert.equal(
    isWatchHistoryRequest({
      ranges: [[0, 1_000]],
      type: watchHistoryMessages.mergeVodRanges,
      videoId: "123",
    }),
    true,
  );

  assert.equal(
    isWatchHistoryRequest({
      ranges: [[0, 1.5]],
      type: watchHistoryMessages.mergeVodRanges,
      videoId: "123",
    }),
    false,
  );

  assert.equal(isWatchHistoryRequest(null), false);

  assert.equal(isWatchHistoryRequest({ type: "watchHistory:unknown" }), false);
});

test("serializes storage read-merge-write operations", async () => {
  const enqueue = createSerialQueue();
  let storedRanges = [];

  const merge = (range) =>
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
