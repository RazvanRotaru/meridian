import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import buildConfiguration from "../tsup.config";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI build memory boundary", () => {
  it("ships analysis and graph-projection workers as split production entries", () => {
    if (!Array.isArray(buildConfiguration)) {
      throw new TypeError("expected one build configuration per worker boundary");
    }
    const [parentAndAnalysisWorker, syntheticOciWorker] = buildConfiguration;

    expect(parentAndAnalysisWorker?.entry).toEqual([
      "src/bin.ts",
      "src/repository-analysis-worker.ts",
      "src/graph-project-worker.ts",
    ]);
    expect(parentAndAnalysisWorker?.splitting).toBe(true);
    expect(parentAndAnalysisWorker?.clean).toBe(true);
    expect(syntheticOciWorker?.entry).toEqual(["src/synthetic-oci-worker.ts"]);
    expect(syntheticOciWorker?.clean).toBe(false);
  });

  it("includes every built worker and its split chunks in the published package", () => {
    const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };

    expect(packageJson.files).toContain("dist");
  });
});
