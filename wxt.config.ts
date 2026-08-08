import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    description: "Enhance the Twitch viewing experience.",
    host_permissions: ["https://www.twitch.tv/*", "https://*.ttvnw.net/*"],
    name: "Hyper Twitch",
    permissions: ["storage", "webRequest"],
  },
});
