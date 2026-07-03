import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
});
