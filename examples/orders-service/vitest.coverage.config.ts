import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fixtureRoot,
  test: {
    include: ["test-runtime/**/*.vitest.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      reportsDirectory: "coverage",
      reporter: [["json", { file: "coverage-final.json" }]],
    },
  },
});
