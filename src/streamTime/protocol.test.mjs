import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateStreamSync,
  interpolateArchiveTime,
  interpolateStreamTime,
  parseMediaPlaylist,
} from "./protocol.ts";

function syncParticipant(overrides = {}) {
  const report = {
    bufferedEndAbsoluteMs: 105_000,
    bufferedStartAbsoluteMs: 80_000,
    currentAbsoluteMs: 98_000,
    reportedAt: 100_000,
    ...overrides,
  };

  return {
    joinedAt: report.reportedAt,
    joinedCurrentAbsoluteMs: report.currentAbsoluteMs,
    ...report,
    ...overrides,
  };
}

test("parses consecutive HLS program times and resolves segment URLs", () => {
  const segments = parseMediaPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-08T00:00:00.000Z",
      "#EXTINF:2.5,",
      "segments/one.ts#ignored",
      "#EXTINF:3,",
      "https://video.ttvnw.net/segments/two.ts?sig=abc",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4,",
      "segments/ignored-without-a-new-program-time.ts",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-08T00:01:00.000Z",
      "#EXTINF:2,",
      "segments/three.ts",
    ].join("\n"),
    "https://video.ttvnw.net/live/index.m3u8",
  );

  assert.deepEqual(segments, [
    {
      durationMs: 2_500,
      programDateTimeMs: Date.parse("2026-08-08T00:00:00.000Z"),
      url: "https://video.ttvnw.net/live/segments/one.ts",
    },
    {
      durationMs: 3_000,
      programDateTimeMs: Date.parse("2026-08-08T00:00:02.500Z"),
      url: "https://video.ttvnw.net/segments/two.ts?sig=abc",
    },
    {
      durationMs: 2_000,
      programDateTimeMs: Date.parse("2026-08-08T00:01:00.000Z"),
      url: "https://video.ttvnw.net/live/segments/three.ts",
    },
  ]);
});

test("interpolates the stream timestamp from the media timeline", () => {
  assert.equal(
    interpolateStreamTime({ absoluteEndMs: 1_700_000_010_000, mediaEnd: 120.5 }, 122.25),
    1_700_000_011_750,
  );
});

test("interpolates the archive timestamp from its start time", () => {
  assert.equal(interpolateArchiveTime(1_700_000_000_000, 122.25), 1_700_000_122_250);
});

test("waits for a second sync participant", () => {
  assert.deepEqual(calculateStreamSync([syncParticipant()], undefined, 100_000), {
    response: { participantCount: 1, status: "waiting" },
    targetState: undefined,
  });
});

test("adds a safety delay behind the slowest joining participant", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant(),
        syncParticipant({
          bufferedEndAbsoluteMs: 98_000,
          currentAbsoluteMs: 90_000,
          reportedAt: 99_000,
        }),
      ],
      undefined,
      100_000,
    ),
    {
      response: {
        participantCount: 2,
        status: "ready",
        targetAbsoluteMs: 86_000,
      },
      targetState: { targetAbsoluteMs: 86_000, updatedAt: 100_000 },
    },
  );
});

test("recovers the same target after the coordinator restarts", () => {
  const participant = syncParticipant({
    bufferedEndAbsoluteMs: 105_000,
    bufferedStartAbsoluteMs: 60_000,
    currentAbsoluteMs: 75_000,
    joinedAt: 90_000,
    joinedCurrentAbsoluteMs: 70_000,
    reportedAt: 100_000,
  });

  assert.deepEqual(calculateStreamSync([participant, participant], undefined, 100_000), {
    response: {
      participantCount: 2,
      status: "ready",
      targetAbsoluteMs: 75_000,
    },
    targetState: { targetAbsoluteMs: 75_000, updatedAt: 100_000 },
  });
});

test("does not jump forward when a participant leaves and buffers improve", () => {
  const targetState = { targetAbsoluteMs: 86_000, updatedAt: 100_000 };
  const waiting = calculateStreamSync([syncParticipant()], targetState, 102_000);

  assert.deepEqual(waiting, {
    response: { participantCount: 1, status: "waiting" },
    targetState,
  });

  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          bufferedEndAbsoluteMs: 110_000,
          currentAbsoluteMs: 101_000,
          reportedAt: 104_000,
        }),
        syncParticipant({
          bufferedEndAbsoluteMs: 109_000,
          currentAbsoluteMs: 100_000,
          reportedAt: 104_000,
        }),
      ],
      waiting.targetState,
      104_000,
    ),
    {
      response: {
        participantCount: 2,
        status: "ready",
        targetAbsoluteMs: 90_000,
      },
      targetState: { targetAbsoluteMs: 90_000, updatedAt: 104_000 },
    },
  );
});

test("moves backward when a slower participant joins", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          bufferedEndAbsoluteMs: 110_000,
          currentAbsoluteMs: 101_000,
          reportedAt: 105_000,
        }),
        syncParticipant({
          bufferedEndAbsoluteMs: 99_000,
          currentAbsoluteMs: 89_000,
          reportedAt: 105_000,
        }),
      ],
      { targetAbsoluteMs: 90_000, updatedAt: 104_000 },
      105_000,
    ),
    {
      response: {
        participantCount: 2,
        status: "ready",
        targetAbsoluteMs: 84_000,
      },
      targetState: { targetAbsoluteMs: 84_000, updatedAt: 105_000 },
    },
  );
});

test("waits when the target is outside a participant buffer", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({ bufferedStartAbsoluteMs: 95_500, currentAbsoluteMs: 99_000 }),
        syncParticipant({
          bufferedEndAbsoluteMs: 100_000,
          currentAbsoluteMs: 90_000,
        }),
      ],
      undefined,
      100_000,
    ),
    {
      response: { participantCount: 2, status: "waiting" },
      targetState: { targetAbsoluteMs: 85_000, updatedAt: 100_000 },
    },
  );
});

test("discards the target when every participant leaves", () => {
  assert.deepEqual(
    calculateStreamSync([], { targetAbsoluteMs: 86_000, updatedAt: 100_000 }, 101_000),
    {
      response: { participantCount: 0, status: "waiting" },
      targetState: undefined,
    },
  );
});
