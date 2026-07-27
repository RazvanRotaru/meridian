import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_BUILD_INPUTS,
  analysisRuntimeFingerprint,
  combineAnalysisBuildFingerprints,
  computeAnalysisBuildFingerprint,
  computeCurrentAnalysisRuntimeFingerprint,
} from "./analysis-runtime-fingerprint";
import { computeAnalysisExecutionFingerprint } from "./analysis-execution-fingerprint";
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

  it.each([
    "packages/core/tsup.config.ts",
    "packages/extractor-python/tsup.config.ts",
    "packages/extractor-typescript/tsup.config.ts",
  ])("covers executable build configuration %s", (input) => {
    expect(ANALYSIS_BUILD_INPUTS).toContain(input);
  });

  it("changes cache identities when worker or resolved dependency bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-analysis-execution-"));
    temporaryRoots.push(root);
    const cliRoot = join(root, "cli");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(join(cliRoot, "dist"), { recursive: true });
    mkdirSync(runtimeRoot);
    const cliManifest = join(cliRoot, "package.json");
    const worker = join(cliRoot, "dist", "repository-analysis-worker.js");
    const runtimeManifest = join(runtimeRoot, "package.json");
    const runtimeEntry = join(runtimeRoot, "runtime.js");
    writeFileSync(cliManifest, JSON.stringify({
      name: "@meridian/cli",
      version: "0.1.0",
      dependencies: { "@meridian/fake-runtime": "0.1.0" },
    }));
    writeFileSync(worker, "export const worker = 1;\n");
    writeFileSync(runtimeManifest, JSON.stringify({
      name: "@meridian/fake-runtime",
      version: "0.1.0",
    }));
    writeFileSync(runtimeEntry, "export const runtime = 1;\n");
    const executionFingerprint = () => computeAnalysisExecutionFingerprint({
      rootPackageManifest: cliManifest,
      workerEntry: worker,
      resolveDependencyManifest: (name) => (
        name === "@meridian/fake-runtime" ? runtimeManifest : undefined
      ),
    });
    const sourceFingerprint = "a".repeat(64);
    const first = combineAnalysisBuildFingerprints(
      sourceFingerprint,
      executionFingerprint(),
    );

    writeFileSync(worker, "export const worker = 2;\n");
    const changedWorker = combineAnalysisBuildFingerprints(
      sourceFingerprint,
      executionFingerprint(),
    );
    expect(changedWorker).not.toBe(first);

    writeFileSync(worker, "export const worker = 1;\n");
    writeFileSync(runtimeEntry, "export const runtime = 2;\n");
    const changedDependency = combineAnalysisBuildFingerprints(
      sourceFingerprint,
      executionFingerprint(),
    );
    expect(changedDependency).not.toBe(first);

    const source = { kind: "github", owner: "org", repo: "repo" } as const;
    const body = {
      id: "graph",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/runtime-bytes",
    };
    expect(prAnalysisKey(
      source,
      body,
      analysisRuntimeFingerprint({ buildFingerprint: changedWorker }),
    )).not.toBe(prAnalysisKey(
      source,
      body,
      analysisRuntimeFingerprint({ buildFingerprint: first }),
    ));
    expect(prAnalysisKey(
      source,
      body,
      analysisRuntimeFingerprint({ buildFingerprint: changedDependency }),
    )).not.toBe(prAnalysisKey(
      source,
      body,
      analysisRuntimeFingerprint({ buildFingerprint: first }),
    ));
  });

  it("rejects links inside a resolved runtime package", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "meridian-analysis-execution-link-"));
    temporaryRoots.push(root);
    const cliRoot = join(root, "cli");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(join(cliRoot, "dist"), { recursive: true });
    mkdirSync(runtimeRoot);
    const cliManifest = join(cliRoot, "package.json");
    const worker = join(cliRoot, "dist", "repository-analysis-worker.js");
    const runtimeManifest = join(runtimeRoot, "package.json");
    writeFileSync(cliManifest, JSON.stringify({
      name: "@meridian/cli",
      version: "0.1.0",
      dependencies: { "@meridian/fake-runtime": "0.1.0" },
    }));
    writeFileSync(worker, "export const worker = 1;\n");
    writeFileSync(runtimeManifest, JSON.stringify({
      name: "@meridian/fake-runtime",
      version: "0.1.0",
    }));
    writeFileSync(join(runtimeRoot, "runtime.js"), "export const runtime = 1;\n");
    symlinkSync("runtime.js", join(runtimeRoot, "linked-runtime.js"));

    expect(() => computeAnalysisExecutionFingerprint({
      rootPackageManifest: cliManifest,
      workerEntry: worker,
      resolveDependencyManifest: () => runtimeManifest,
    })).toThrow("must not contain links");
  });

  it("fails closed when the execution closure exceeds its bounds", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-analysis-execution-limit-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    const manifest = join(root, "package.json");
    const worker = join(root, "dist", "repository-analysis-worker.js");
    writeFileSync(manifest, JSON.stringify({ name: "@meridian/cli", version: "0.1.0" }));
    writeFileSync(worker, "export const worker = 1;\n");

    expect(() => computeAnalysisExecutionFingerprint({
      rootPackageManifest: manifest,
      workerEntry: worker,
      limits: { maxFiles: 1 },
    })).toThrow("runtime file limit exceeded");
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
    expect(computeCurrentAnalysisRuntimeFingerprint()).toEqual(fingerprint);
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
