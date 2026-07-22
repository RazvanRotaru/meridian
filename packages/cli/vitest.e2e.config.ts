import { defineConfig } from "vitest/config";

// End-to-end tests drive either a real browser or real process/filesystem integrations. Keep them
// out of the highly parallel unit run (`*.e2e.ts`, not `*.test.ts`), serialize their shared host
// resources, and give OS/browser operations realistic timeouts.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
