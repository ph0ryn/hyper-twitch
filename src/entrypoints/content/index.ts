import { defineContentScript } from "wxt/utils/define-content-script";

import { runFeatureRuntimes } from "./featureRuntime";

export default defineContentScript({
  main(ctx) {
    runFeatureRuntimes(ctx);
  },
  matches: ["*://*.twitch.tv/*"],
});
