import { defineBackground } from "wxt/utils/define-background";

import { installStreamTimeBackground } from "../../src/streamTime/background";
import { installWatchHistoryBackground } from "../../src/watchHistory/background";

export default defineBackground(() => {
  installStreamTimeBackground();
  installWatchHistoryBackground();
});
