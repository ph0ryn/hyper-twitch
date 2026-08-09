import { defineConfig } from "vitest/config";
import { WxtVitest as wxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [wxtVitest()],
});
