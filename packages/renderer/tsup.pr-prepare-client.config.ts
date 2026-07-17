import { defineConfig } from "tsup";

/**
 * One dependency-free ESM boundary shared by the pre-renderer landing page and the renderer.
 * Vite owns the SPA build; this second entry deliberately leaves that output intact.
 */
export default defineConfig({
  entry: { "pr-prepare-client": "src/state/prPreparation.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  noExternal: ["@meridian/core/pr-prepare-contract"],
});
