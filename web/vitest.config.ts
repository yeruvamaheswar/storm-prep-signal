import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    // Only these stylesheets are processed in tests, so tests/replay-contrast.test.ts can read their `?raw` text.
    css: { include: [/src\/design\/tokens\.css/, /src\/features\/replay\/(replay|zone)\.css/] },
  },
})
