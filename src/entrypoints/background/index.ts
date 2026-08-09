import { defineBackground } from "wxt/utils/define-background";

import { installStreamTimeBackground } from "./streamTime";
import { installWatchHistoryBackground } from "./watchHistory";

export default defineBackground(() => {
  installStreamTimeBackground();
  installWatchHistoryBackground();
});
