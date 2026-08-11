import { assert, test } from "vitest";

import { findPlaybackMode } from "./streamTime";

test("recognizes Twitch VOD routes", () => {
  const vod = { key: "vod:2842330566", kind: "vod", videoId: "2842330566" } as const;

  assert.deepEqual(findPlaybackMode("/videos/2842330566"), vod);
  assert.deepEqual(findPlaybackMode("/bakumatsu_shishi/video/2842330566"), vod);

  assert.deepEqual(findPlaybackMode("/bakumatsu_shishi"), {
    key: "live:/bakumatsu_shishi",
    kind: "live",
  });
});
