import assert from "node:assert/strict";
import test from "node:test";

import { interpolateArchiveTime, interpolateStreamTime, parseMediaPlaylist } from "./protocol.ts";

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
