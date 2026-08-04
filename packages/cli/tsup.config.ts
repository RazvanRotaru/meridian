import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";
import { computeAnalysisBuildFingerprint } from "./src/analysis-runtime-fingerprint";

const analysisBuildFingerprint = computeAnalysisBuildFingerprint(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const analysisBuildDefine = {
  __MERIDIAN_ANALYSIS_BUILD_FINGERPRINT__: JSON.stringify(analysisBuildFingerprint),
};

export default defineConfig([
  {
    entry: ["src/bin.ts", "src/repository-analysis-worker.ts", "src/graph-project-worker.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    sourcemap: true,
    target: "es2022",
    banner: { js: "#!/usr/bin/env node" },
    define: analysisBuildDefine,
  },
  {
    entry: ["src/synthetic-oci-worker.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: false,
    target: "es2022",
    define: analysisBuildDefine,
    // The container receives this one file only: never mount host node_modules into the sandbox.
    noExternal: [/.*/],
    // ts-morph includes CommonJS TypeScript internals that dynamically require Node built-ins.
    banner: { js: "import { createRequire as __meridianCreateRequire } from 'node:module'; import { fileURLToPath as __meridianFileURLToPath } from 'node:url'; import { dirname as __meridianDirname } from 'node:path'; const require = __meridianCreateRequire(import.meta.url); const __filename = __meridianFileURLToPath(import.meta.url); const __dirname = __meridianDirname(__filename);" },
  },
]);
