import { assert, test } from "vitest";

import { findPlaybackMode, findVideoObjectStart } from "./playback";

test("recognizes Twitch VOD routes", () => {
  const vod = { key: "vod:2842330566", kind: "vod", videoId: "2842330566" } as const;

  assert.deepEqual(findPlaybackMode("/videos/2842330566"), vod);
  assert.deepEqual(findPlaybackMode("/bakumatsu_shishi/video/2842330566"), vod);

  assert.deepEqual(findPlaybackMode("/bakumatsu_shishi"), {
    key: "live:/bakumatsu_shishi",
    kind: "live",
  });

  assert.deepEqual(findPlaybackMode("/bakumatsu_shishi/"), {
    key: "live:/bakumatsu_shishi",
    kind: "live",
  });

  assert.isUndefined(findPlaybackMode("/"));
  assert.isUndefined(findPlaybackMode("/bakumatsu_shishi/clip/example"));
  assert.isUndefined(findPlaybackMode("/directory/category/just-chatting"));
  assert.isUndefined(findPlaybackMode("/settings/profile"));
});

test("finds an archive start in structured video metadata", () => {
  const uploadDate = "2026-08-11T12:34:56Z";

  assert.equal(
    findVideoObjectStart({
      "@graph": [{ "@type": ["Thing", "VideoObject"], uploadDate }],
    }),
    Date.parse(uploadDate),
  );

  assert.isUndefined(findVideoObjectStart({ "@type": "VideoObject", uploadDate: "invalid" }));
});
