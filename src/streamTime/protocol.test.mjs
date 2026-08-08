import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateStreamSyncPlaybackRate,
  calculateStreamSync,
  interpolateArchiveTime,
  interpolateStreamTime,
  isStreamSyncAligned,
  parseMediaPlaylist,
  projectStreamSyncTarget,
} from "./protocol.ts";

function syncParticipant(overrides = {}) {
  const report = {
    currentAbsoluteMs: 98_000,
    playbackRate: 1,
    reportedAt: 100_000,
    ...overrides,
  };

  return report;
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

test("projects a ready sync target from its background calculation time", () => {
  assert.equal(projectStreamSyncTarget(86_000, 100_000, 100_125), 86_125);
  assert.equal(projectStreamSyncTarget(86_000, 100_000, 99_875), 86_000);
});

test("adjusts playback speed toward the shared moment", () => {
  assert.equal(calculateStreamSyncPlaybackRate(0), 1);
  assert.equal(calculateStreamSyncPlaybackRate(0.01), 0.995);
  assert.equal(calculateStreamSyncPlaybackRate(0.1), 0.95);
  assert.equal(calculateStreamSyncPlaybackRate(0.2), 0.9);
  assert.equal(calculateStreamSyncPlaybackRate(1), 0.5);
  assert.equal(calculateStreamSyncPlaybackRate(-0.2), 1.1);
  assert.equal(calculateStreamSyncPlaybackRate(-1), 1.5);
});

test("reports alignment independently from continued rate correction", () => {
  assert.equal(isStreamSyncAligned(0), true);
  assert.equal(isStreamSyncAligned(0.1), true);
  assert.equal(isStreamSyncAligned(-0.1), true);
  assert.equal(isStreamSyncAligned(0.101), false);
  assert.equal(isStreamSyncAligned(Number.NaN), false);
});

test("selects the slowest current playback moment", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant(),
        syncParticipant({
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
        targetAbsoluteMs: 91_000,
        targetAtMs: 100_000,
      },
      targetState: { targetAbsoluteMs: 91_000, updatedAt: 100_000 },
    },
  );
});

test("recovers the same target after the coordinator restarts", () => {
  const participant = syncParticipant({
    currentAbsoluteMs: 75_000,
    reportedAt: 100_000,
  });

  assert.deepEqual(calculateStreamSync([participant, participant], undefined, 100_000), {
    response: {
      participantCount: 2,
      status: "ready",
      targetAbsoluteMs: 75_000,
      targetAtMs: 100_000,
    },
    targetState: { targetAbsoluteMs: 75_000, updatedAt: 100_000 },
  });
});

test("does not jump forward when a participant leaves", () => {
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
          currentAbsoluteMs: 101_000,
          reportedAt: 104_000,
        }),
        syncParticipant({
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
        targetAtMs: 104_000,
      },
      targetState: { targetAbsoluteMs: 90_000, updatedAt: 104_000 },
    },
  );
});

test("keeps a stable target through playback timing jitter", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          currentAbsoluteMs: 89_500,
          reportedAt: 101_000,
        }),
        syncParticipant({
          currentAbsoluteMs: 89_600,
          reportedAt: 101_000,
        }),
      ],
      { targetAbsoluteMs: 90_000, updatedAt: 100_000 },
      101_000,
    ),
    {
      response: {
        participantCount: 2,
        status: "ready",
        targetAbsoluteMs: 91_000,
        targetAtMs: 101_000,
      },
      targetState: { targetAbsoluteMs: 91_000, updatedAt: 101_000 },
    },
  );
});

test("moves a stable target backward after a sustained stall", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          currentAbsoluteMs: 88_300,
          reportedAt: 101_000,
        }),
        syncParticipant({
          currentAbsoluteMs: 88_400,
          reportedAt: 101_000,
        }),
      ],
      { targetAbsoluteMs: 90_000, updatedAt: 100_000 },
      101_000,
    ),
    {
      response: {
        participantCount: 2,
        status: "ready",
        targetAbsoluteMs: 88_300,
        targetAtMs: 101_000,
      },
      targetState: { targetAbsoluteMs: 88_300, updatedAt: 101_000 },
    },
  );
});

test("moves backward when a slower participant joins", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          currentAbsoluteMs: 101_000,
          reportedAt: 105_000,
        }),
        syncParticipant({
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
        targetAbsoluteMs: 89_000,
        targetAtMs: 105_000,
      },
      targetState: { targetAbsoluteMs: 89_000, updatedAt: 105_000 },
    },
  );
});

test("projects each participant with its playback rate", () => {
  assert.deepEqual(
    calculateStreamSync(
      [
        syncParticipant({
          currentAbsoluteMs: 90_000,
          playbackRate: 0.5,
          reportedAt: 99_000,
        }),
        syncParticipant({
          currentAbsoluteMs: 95_000,
          playbackRate: 1.5,
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
        targetAbsoluteMs: 90_500,
        targetAtMs: 100_000,
      },
      targetState: { targetAbsoluteMs: 90_500, updatedAt: 100_000 },
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
