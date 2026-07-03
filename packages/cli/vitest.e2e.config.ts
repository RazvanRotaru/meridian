import { defineConfig } from "vitest/config";

// The end-to-end suite drives a real headless browser against `blueprint view`, so it is
// kept out of the default unit run (`*.e2e.ts`, not `*.test.ts`) and given generous timeouts.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
