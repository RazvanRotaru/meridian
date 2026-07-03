import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes built asset URLs relative so the CLI can serve the SPA from any path.
// `worker.format: "es"` lets the ELK layout worker load via `new URL(..., import.meta.url)`.
export default defineConfig({
  plugins: [react()],
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
