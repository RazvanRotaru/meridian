import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_BUILD_INPUTS,
  analysisRuntimeFingerprint,
  computeAnalysisBuildFingerprint,
} from "./analysis-runtime-fingerprint";
import { prAnalysisKey } from "./server/web-pr-cache";
import {
  canonicalPrRevisionIdentity,
  populatedPrHeadRevisionIdentity,
} from "./server/web-pr-revision-cache";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("analysis runtime fingerprint", () => {
  it("hashes input paths and bytes deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-analysis-build-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "src", "__pycache__"));
    writeFileSync(join(root, "src", "extract.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "src", "éxtract.ts"), "export const unicode = true;\n");
    writeFileSync(join(root, "src", "__pycache__", "extract.pyc"), "generated-1");
    writeFileSync(join(root, "lock.yaml"), "typescript: 6.0.3\n");

    const first = computeAnalysisBuildFingerprint(root, ["src", "lock.yaml"]);
    expect(computeAnalysisBuildFingerprint(root, ["lock.yaml", "src"])).toBe(first);
    writeFileSync(join(root, "src", "__pycache__", "extract.pyc"), "generated-2");
    expect(computeAnalysisBuildFingerprint(root, ["src", "lock.yaml"])).toBe(first);

    writeFileSync(join(root, "src", "extract.ts"), "export const value = 2;\n");
    expect(computeAnalysisBuildFingerprint(root, ["src", "lock.yaml"])).not.toBe(first);
  });

  it("covers the Python analyzer implementation in the build digest inputs", () => {
    expect(ANALYSIS_BUILD_INPUTS).toContain("packages/extractor-python/python");
  });

  it("records the exact process and installed TypeScript toolchain", () => {
    const fingerprint = analysisRuntimeFingerprint();
    const require = createRequire(import.meta.url);
    const packageVersion = (name: string): string => (
      JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as { version: string }
    ).version;

    expect(analysisRuntimeFingerprint()).toBe(fingerprint);
    expect(fingerprint).toEqual({
      formatVersion: 1,
      buildFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      processInstanceNonce: expect.stringMatching(/^[a-f0-9]{32}$/),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      typescriptVersion: (require("ts-morph") as { ts: { version: string } }).ts.version,
      tsMorphVersion: packageVersion("ts-morph"),
    });
  });

  it("invalidates both pair and canonical revision identities when provenance changes", () => {
    const current = analysisRuntimeFingerprint();
    const changedFingerprints = [
      analysisRuntimeFingerprint({
        buildFingerprint: current.buildFingerprint === "f".repeat(64)
          ? "e".repeat(64)
          : "f".repeat(64),
      }),
      analysisRuntimeFingerprint({ nodeVersion: `${current.nodeVersion}-changed` }),
      analysisRuntimeFingerprint({ platform: current.platform === "linux" ? "darwin" : "linux" }),
      analysisRuntimeFingerprint({ arch: `${current.arch}-changed` }),
      analysisRuntimeFingerprint({ typescriptVersion: `${current.typescriptVersion}-changed` }),
      analysisRuntimeFingerprint({ tsMorphVersion: `${current.tsMorphVersion}-changed` }),
      analysisRuntimeFingerprint({
        processInstanceNonce: current.processInstanceNonce === "f".repeat(32)
          ? "e".repeat(32)
          : "f".repeat(32),
      }),
    ];
    const source = { kind: "github", owner: "org", repo: "repo" } as const;
    const body = {
      id: "graph",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/runtime",
    };
    const canonicalInputs = {
      repositoryKey: "repository-key",
      repositoryUrl: "https://github.com/org/repo.git",
      commit: "a".repeat(40),
      targetName: "org/repo",
    };

    const firstRevision = canonicalPrRevisionIdentity({
      ...canonicalInputs,
      runtimeFingerprint: current,
    });
    const firstHeadRevision = populatedPrHeadRevisionIdentity({
      ...canonicalInputs,
      branch: body.headRef,
      changedSince: "b".repeat(40),
      runtimeFingerprint: current,
    });
    expect(firstRevision.analysisRuntimeFingerprint).toEqual(current);
    expect(firstHeadRevision.analysisRuntimeFingerprint).toEqual(current);
    for (const changed of changedFingerprints) {
      expect(prAnalysisKey(source, body, changed)).not.toBe(prAnalysisKey(source, body, current));
      expect(canonicalPrRevisionIdentity({
        ...canonicalInputs,
        runtimeFingerprint: changed,
      })).not.toEqual(firstRevision);
      expect(populatedPrHeadRevisionIdentity({
        ...canonicalInputs,
        branch: body.headRef,
        changedSince: "b".repeat(40),
        runtimeFingerprint: changed,
      })).not.toEqual(firstHeadRevision);
    }
  });
});
