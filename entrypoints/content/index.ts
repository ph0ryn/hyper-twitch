import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  main() {
    console.log("Hyper Twitch content script loaded.");
  },
  matches: ["*://*.twitch.tv/*"],
});
