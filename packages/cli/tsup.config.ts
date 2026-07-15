import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: [
      "src/bin.ts",
      "src/server/extraction-worker-child.ts",
      "src/server/standalone-view-mock-worker-child.ts",
    ],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    target: "es2022",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/synthetic-oci-worker.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: false,
    target: "es2022",
    // The container receives this one file only: never mount host node_modules into the sandbox.
    noExternal: [/.*/],
    // ts-morph includes CommonJS TypeScript internals that dynamically require Node built-ins.
    banner: { js: "import { createRequire as __meridianCreateRequire } from 'node:module'; import { fileURLToPath as __meridianFileURLToPath } from 'node:url'; import { dirname as __meridianDirname } from 'node:path'; const require = __meridianCreateRequire(import.meta.url); const __filename = __meridianFileURLToPath(import.meta.url); const __dirname = __meridianDirname(__filename);" },
  },
]);
