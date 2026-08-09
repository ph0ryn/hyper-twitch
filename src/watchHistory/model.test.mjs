import assert from "node:assert/strict";
import test from "node:test";

import {
  isLiveWatchRecord,
  isVodWatchRecord,
  liveMediaRangesToUtcRanges,
  mergeWatchRanges,
  normalizeLogin,
  playbackTimestampToMs,
  sanitizeWatchRanges,
  subtractWatchRanges,
  timeRangesToWatchRanges,
  toVodWatchRanges,
  watchRangeToOverlay,
} from "./model.ts";

const anchor = { absoluteEndMs: 1_700_000_010_000, mediaEnd: 100 };

test("normalizes Twitch logins", () => {
  assert.equal(normalizeLogin("  Some_Channel "), "some_channel");
  assert.equal(normalizeLogin(""), null);
  assert.equal(normalizeLogin("not valid"), null);
});

test("parses playback timestamps from hover previews", () => {
  assert.equal(playbackTimestampToMs("06:39:16"), 23_956_000);
  assert.equal(playbackTimestampToMs("5:00"), 300_000);
  assert.equal(playbackTimestampToMs("01:60"), null);
  assert.equal(playbackTimestampToMs("not a timestamp"), null);
});

test("sanitizes and merges finite integer ranges", () => {
  assert.deepEqual(
    sanitizeWatchRanges(
      [
        [-1, 5],
        [5, 10],
        [1_012, 2_000],
        [3_002, 4_000],
        [Number.NaN, 1],
        [2, 2.5],
      ],
      { minimumMs: 0 },
    ),
    [
      [0, 10],
      [1_012, 2_000],
      [3_002, 4_000],
    ],
  );

  assert.deepEqual(
    mergeWatchRanges([
      [0, 1_000],
      [2_000, 3_000],
    ]),
    [[0, 3_000]],
  );

  assert.deepEqual(
    mergeWatchRanges([
      [0, 1_000],
      [2_001, 3_000],
    ]),
    [
      [0, 1_000],
      [2_001, 3_000],
    ],
  );
});

test("converts TimeRanges-like seconds to relative milliseconds", () => {
  const timeRanges = {
    end(index) {
      if (index === 0) {
        return 1.25;
      }

      return 4.001;
    },
    length: 2,
    start(index) {
      if (index === 0) {
        return 0.25;
      }

      return 3.001;
    },
  };

  assert.deepEqual(timeRangesToWatchRanges(timeRanges, 500), [
    [750, 1_750],
    [3_501, 4_501],
  ]);

  assert.deepEqual(
    timeRangesToWatchRanges({
      end() {
        return 1;
      },
      length: 2,
      start() {
        throw new Error("range replaced");
      },
    }),
    [],
  );
});

test("subtracts playback that happened before tracking started", () => {
  assert.deepEqual(
    subtractWatchRanges(
      [
        [0, 160_000],
        [200_000, 240_000],
      ],
      [
        [0, 150_000],
        [210_000, 220_000],
      ],
    ),
    [
      [150_000, 160_000],
      [200_000, 210_000],
      [220_000, 240_000],
    ],
  );
});

test("maps live media ranges to UTC using the stream anchor", () => {
  assert.deepEqual(liveMediaRangesToUtcRanges([[99_000, 101_000]], anchor), [
    [1_700_000_009_000, 1_700_000_011_000],
  ]);

  assert.deepEqual(
    liveMediaRangesToUtcRanges(
      {
        end() {
          return 101;
        },
        length: 1,
        start() {
          return 99;
        },
      },
      anchor,
    ),
    [[1_700_000_009_000, 1_700_000_011_000]],
  );
});

test("combines direct VOD ranges with matching live ranges and clips to duration", () => {
  const directRecord = {
    kind: "vod",
    ranges: [[10_000, 20_000]],
    updatedAt: 1_700_000_100_000,
    version: 1,
    videoId: "123",
  };
  const liveRecord = {
    kind: "live",
    login: "creator",
    ownerId: "42",
    streams: {
      provisional: {
        createdAtMs: 1_700_000_000_000,
        ranges: [
          [1_699_999_999_000, 1_700_000_005_000],
          [1_700_000_019_000, 1_700_000_050_000],
        ],
        updatedAt: 1_700_000_100_000,
      },
    },
    updatedAt: 1_700_000_100_000,
    version: 1,
  };

  assert.deepEqual(
    toVodWatchRanges(directRecord, [liveRecord], {
      durationMs: 30_000,
      login: "CREATOR",
      ownerId: "42",
      recordedAtMs: 1_700_000_000_000,
    }),
    [
      [0, 5_000],
      [10_000, 30_000],
    ],
  );
});

test("uses login for provisional live records but excludes owner mismatches", () => {
  const liveRecord = {
    kind: "live",
    login: "creator",
    streams: {
      stream: { ranges: [[0, 5_000]], updatedAt: 1 },
    },
    updatedAt: 1,
    version: 1,
  };

  assert.deepEqual(
    toVodWatchRanges(null, [liveRecord], {
      durationMs: 10_000,
      login: "CREATOR",
      ownerId: "42",
      recordedAtMs: 0,
    }),
    [[0, 5_000]],
  );

  assert.deepEqual(
    toVodWatchRanges(null, [{ ...liveRecord, ownerId: "99" }], {
      durationMs: 10_000,
      login: "CREATOR",
      ownerId: "42",
      recordedAtMs: 0,
    }),
    [],
  );
});

test("returns overlay percentages after clipping", () => {
  assert.deepEqual(watchRangeToOverlay([-1_000, 2_500], 10_000), {
    leftPercent: 0,
    widthPercent: 25,
  });

  assert.deepEqual(watchRangeToOverlay([5_000, 20_000], 10_000), {
    leftPercent: 50,
    widthPercent: 50,
  });

  assert.equal(watchRangeToOverlay([0, 1_000], 0), null);
});

test("validates versioned stored records", () => {
  assert.equal(
    isVodWatchRecord({
      kind: "vod",
      ranges: [[0, 1_000]],
      updatedAt: 1,
      version: 1,
      videoId: "123",
    }),
    true,
  );

  assert.equal(
    isVodWatchRecord({
      kind: "vod",
      ranges: [],
      updatedAt: 1,
      version: 2,
      videoId: "123",
    }),
    false,
  );

  assert.equal(
    isLiveWatchRecord({
      kind: "live",
      login: "creator",
      streams: {
        stream: { ranges: [], updatedAt: 1 },
      },
      updatedAt: 1,
      version: 1,
    }),
    true,
  );

  assert.equal(
    isLiveWatchRecord({
      kind: "live",
      login: "Creator",
      streams: {},
      updatedAt: 1,
      version: 1,
    }),
    false,
  );
});
