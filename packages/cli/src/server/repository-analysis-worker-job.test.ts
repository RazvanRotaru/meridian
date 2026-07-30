import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_PROGRESS_ACTIVITIES,
  SCHEMA_VERSION,
  type GraphArtifact,
} from "@meridian/core";
import {
  changedMetadataForWorker,
  createRepositoryAnalysisProgressReporter,
  emptySideHintsForWorker,
  isRepositoryAnalysisWorkerRequest,
  isRepositoryAnalysisFacts,
  isRepositoryAnalysisProgress,
  isRepositoryAnalysisWorkerResponse,
  MAX_REPOSITORY_WORKER_PROGRESS_EVENTS,
  normalizeRepositoryAnalysisRequest,
  type RepositoryAnalysisProgress,
} from "./repository-analysis-worker-job";

describe("repository analysis worker protocol", () => {
  it("keeps TypeScript shard policy outside the public serializable analysis request", () => {
    const policy = shardPolicy();
    expect(() => normalizeRepositoryAnalysisRequest({
      absoluteRoot: "/repo",
      cwd: "/repo",
      typeScriptRevisionShards: policy,
    } as never)).toThrow("cannot contain a TypeScript shard policy");
  });

  it("strictly validates a server-owned TypeScript shard policy on private IPC", () => {
    const request = {
      type: "analyze",
      id: "analysis",
      request: {
        absoluteRoot: "/repo",
        cwd: "/repo",
        targetName: null,
        vcs: null,
        changedSince: null,
        changedSinceTimeoutMs: null,
        hintedFiles: [],
        allowEmpty: false,
      },
      artifactOutputPath: "/tmp/artifact.json",
      branchVariant: null,
      reviewFingerprints: null,
      progressContext: null,
      typeScriptRevisionShards: shardPolicy(),
    } as const;

    expect(isRepositoryAnalysisWorkerRequest(request)).toBe(true);
    expect(isRepositoryAnalysisWorkerRequest({
      ...request,
      typeScriptRevisionShards: {
        ...request.typeScriptRevisionShards,
        cacheDir: "relative/cache",
      },
    })).toBe(false);
    expect(isRepositoryAnalysisWorkerRequest({
      ...request,
      typeScriptRevisionShards: {
        ...request.typeScriptRevisionShards,
        unexpected: true,
      },
    })).toBe(false);

    const signer = admissionSigner();
    expect(isRepositoryAnalysisWorkerRequest({
      ...request,
      typeScriptRevisionShards: {
        ...request.typeScriptRevisionShards,
        mode: "shadow",
        admission: signer,
      },
    })).toBe(true);
    expect(isRepositoryAnalysisWorkerRequest({
      ...request,
      typeScriptRevisionShards: {
        ...request.typeScriptRevisionShards,
        mode: "admitted",
        admission: {
          version: 1,
          kind: "verifier",
          keyId: signer.keyId,
          publicKeySpki: signer.publicKeySpki,
        },
      },
    })).toBe(true);
    expect(isRepositoryAnalysisWorkerRequest({
      ...request,
      typeScriptRevisionShards: {
        ...request.typeScriptRevisionShards,
        mode: "shadow",
        admission: { ...signer, keyId: "0".repeat(64) },
      },
    })).toBe(false);
  });

  it("sorts canonical status-rich changed files without losing rename provenance", () => {
    const artifact = fixtureArtifact();
    artifact.extensions = {
      changedSince: {
        baseRef: "base",
        manifest: [
          { path: "z/new.ts", previousPath: "z/old.ts", status: "renamed" },
          { path: "a/deleted.py", status: "deleted" },
        ],
      },
    };

    expect(changedMetadataForWorker(artifact, "base")).toEqual({
      changedFiles: [
        { path: "a/deleted.py", status: "deleted" },
        { path: "z/new.ts", previousPath: "z/old.ts", status: "renamed" },
      ],
      changedSinceBaseRef: "base",
    });
  });

  it("returns one representative hint for every selected extractor language", () => {
    const artifact = fixtureArtifact();
    artifact.nodes.push({
      id: "py:src/job.py#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      language: "python",
      location: { file: "src/job.py", startLine: 1 },
    });

    expect(emptySideHintsForWorker(artifact, [], [
      { extensions: [".ts", ".tsx"] },
      { extensions: [".py"] },
    ])).toEqual(["src/index.ts", "src/job.py"]);
  });

  it("rejects a compact child attestation for any schema other than the current schema", () => {
    const response = {
      type: "result",
      result: {
        kind: "file",
        operation: "analyze",
        id: "analysis",
        artifactPath: "/tmp/artifact.json",
        artifactBytes: 10,
        artifactSha256: "a".repeat(64),
        branchVariant: null,
        graphSummary: {
          schemaVersion: "1.99.0",
          generatedAt: "2026-07-21T00:00:00.000Z",
          nodeCount: 0,
          edgeCount: 0,
        },
        target: fixtureArtifact().target,
        changedFiles: [],
        emptySideHints: [],
        sourceFiles: [],
        changedSinceBaseRef: null,
        warnings: [],
      },
    };

    expect(isRepositoryAnalysisWorkerResponse(response)).toBe(false);
    response.result.graphSummary.schemaVersion = SCHEMA_VERSION;
    expect(isRepositoryAnalysisWorkerResponse(response)).toBe(true);
  });

  it("strictly validates persisted compact analysis facts without a worker envelope", () => {
    const facts = {
      summary: {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: "2026-07-21T00:00:00.000Z",
        nodeCount: 1,
        edgeCount: 0,
      },
      target: fixtureArtifact().target,
      changedFiles: [{ path: "src/index.ts", status: "modified" }],
      emptySideHints: ["src/index.ts"],
      sourceFiles: ["src/index.ts"],
      changedSinceBaseRef: "base",
      warnings: [],
    };

    expect(isRepositoryAnalysisFacts(facts)).toBe(true);
    expect(isRepositoryAnalysisFacts({ ...facts, unexpected: true })).toBe(false);
    expect(isRepositoryAnalysisFacts({
      ...facts,
      summary: { ...facts.summary, schemaVersion: "1.99.0" },
    })).toBe(false);
  });

  it("enriches, bounds, and caps real extractor progress while preserving required phases", () => {
    const progress: RepositoryAnalysisProgress[] = [];
    let now = 0;
    let advanceClock = true;
    const report = createRepositoryAnalysisProgressReporter({
      version: 1,
      revision: {
        kind: "head",
        commit: "a".repeat(40),
        execution: { current: 1, total: 2 },
      },
    }, (event) => progress.push(event), () => {
      if (advanceClock) now += 1_001;
      return now;
    });
    const unit = { current: 1, total: 1, path: "." };
    report({ language: "typescript", phase: "project-load", unit, sourceFile: null });
    report({ language: "typescript", phase: "input-proof", unit, sourceFile: null });
    report({
      language: "typescript",
      phase: "input-proof",
      unit,
      sourceFile: { current: 1, total: 2, path: "src/compiler-input.ts" },
    });
    report({ language: "typescript", phase: "input-proof", unit, sourceFile: null });
    for (let current = 1; current <= 600; current += 1) {
      report({
        language: "typescript",
        phase: "structure",
        unit,
        sourceFile: {
          current,
          total: 600,
          path: current === 1 ? `${"nested/".repeat(90)}index.ts` : `src/file-${current}.ts`,
        },
      });
    }
    report({ language: "typescript", phase: "relationships", unit, sourceFile: null });
    report({
      language: "typescript",
      phase: "relationships",
      activity: "logic-flows",
      unit,
      sourceFile: { current: 400, total: 600, path: "src/flow-heavy.ts" },
    });
    report({ language: "typescript", phase: "stitch", unit: null, sourceFile: null });
    report({ language: "typescript", phase: "finalize", unit: null, sourceFile: null });
    advanceClock = false;
    report({
      language: "python",
      phase: "project-load",
      unit,
      sourceFile: null,
    });
    report({
      language: "python",
      phase: "structure",
      unit,
      sourceFile: { current: 1, total: 2, path: "python/start.py" },
    });
    report({
      language: "python",
      phase: "structure",
      unit,
      sourceFile: { current: 2, total: 2, path: "python/end.py" },
    });
    report({ language: "python", phase: "relationships", unit, sourceFile: null });
    report({ language: "python", phase: "stitch", unit: null, sourceFile: null });
    report({ language: "python", phase: "finalize", unit: null, sourceFile: null });

    expect(progress.length).toBeLessThanOrEqual(MAX_REPOSITORY_WORKER_PROGRESS_EVENTS);
    // Dedicated capacity for input-proof file clearing reduces ordinary one-hertz samples while
    // keeping the overall transport cap and every truthful phase/clear transition bounded.
    expect(progress.length).toBeGreaterThan(150);
    expect(progress.slice(-5).map((event) => [event.language, event.phase])).toEqual([
      ["python", "structure"],
      ["python", "structure"],
      ["python", "relationships"],
      ["python", "stitch"],
      ["python", "finalize"],
    ]);
    expect(progress.at(-3)?.phase).toBe("relationships");
    expect(progress.at(-2)?.phase).toBe("stitch");
    expect(progress.at(-1)?.phase).toBe("finalize");
    expect(progress.find((event) => event.activity === "logic-flows")).toMatchObject({
      phase: "relationships",
      sourceFile: { current: 400, total: 600, path: "src/flow-heavy.ts" },
    });
    expect(progress.filter((event) => event.phase === "input-proof").map((event) => (
      event.sourceFile
    ))).toEqual([
      null,
      {
        current: 1,
        total: 2,
        path: "src/compiler-input.ts",
        pathTruncated: false,
      },
      null,
    ]);
    const firstStructureSource = progress.find((event) => (
      event.phase === "structure" && event.sourceFile?.current === 1
    ));
    expect(firstStructureSource?.sourceFile).toMatchObject({
      current: 1,
      total: 600,
      path: expect.stringMatching(/^…\//),
      pathTruncated: true,
    });
    expect(Buffer.byteLength(
      firstStructureSource?.sourceFile?.path ?? "",
      "utf8",
    )).toBeLessThanOrEqual(512);
    expect(progress.every(isRepositoryAnalysisProgress)).toBe(true);
    expect(progress.every((event) => isRepositoryAnalysisWorkerResponse({
      type: "progress",
      id: "analysis",
      progress: event,
    }))).toBe(true);
  });

  it("preserves input-proof file clearing even inside the sampling interval", () => {
    const progress: RepositoryAnalysisProgress[] = [];
    const report = createRepositoryAnalysisProgressReporter({
      version: 1,
      revision: {
        kind: "head",
        commit: "a".repeat(40),
        execution: { current: 1, total: 2 },
      },
    }, (event) => progress.push(event), () => 0);
    const unit = { current: 1, total: 1, path: "." };

    report({ language: "typescript", phase: "project-load", unit, sourceFile: null });
    report({ language: "typescript", phase: "input-proof", unit, sourceFile: null });
    report({
      language: "typescript",
      phase: "input-proof",
      unit,
      sourceFile: { current: 1, total: 2, path: "src/compiler-input.ts" },
    });
    report({ language: "typescript", phase: "input-proof", unit, sourceFile: null });

    expect(progress.map((event) => [event.phase, event.sourceFile])).toEqual([
      ["project-load", null],
      ["input-proof", null],
      [
        "input-proof",
        {
          current: 1,
          total: 2,
          path: "src/compiler-input.ts",
          pathTruncated: false,
        },
      ],
      ["input-proof", null],
    ]);
  });

  it("keeps terminal phase capacity after activity transitions exhaust their reservation", () => {
    const progress: RepositoryAnalysisProgress[] = [];
    const report = createRepositoryAnalysisProgressReporter({
      version: 1,
      revision: {
        kind: "head",
        commit: "a".repeat(40),
        execution: { current: 1, total: 2 },
      },
    }, (event) => progress.push(event), () => 0);
    const unitTotal = 64;

    report({
      language: "typescript",
      phase: "project-load",
      unit: { current: 1, total: unitTotal, path: "packages/unit-1" },
      sourceFile: null,
    });
    report({
      language: "typescript",
      phase: "relationships",
      unit: { current: 1, total: unitTotal, path: "packages/unit-1" },
      sourceFile: null,
    });
    for (let current = 1; current <= unitTotal; current += 1) {
      const unit = {
        current,
        total: unitTotal,
        path: `packages/unit-${current}`,
      };
      for (const activity of EXTRACTION_PROGRESS_ACTIVITIES) {
        report({
          language: "typescript",
          phase: "relationships",
          activity,
          unit,
          sourceFile: {
            current: 1,
            total: 1,
            path: `packages/unit-${current}/src/index.ts`,
          },
        });
      }
    }
    report({ language: "typescript", phase: "stitch", unit: null, sourceFile: null });
    report({ language: "typescript", phase: "finalize", unit: null, sourceFile: null });

    expect(unitTotal * EXTRACTION_PROGRESS_ACTIVITIES.length)
      .toBe(MAX_REPOSITORY_WORKER_PROGRESS_EVENTS);
    expect(progress.length).toBeLessThanOrEqual(MAX_REPOSITORY_WORKER_PROGRESS_EVENTS);
    expect(progress.slice(-2).map((event) => event.phase)).toEqual(["stitch", "finalize"]);
  });

  it("sinks rejected async progress observers without awaiting them", async () => {
    let observations = 0;
    const report = createRepositoryAnalysisProgressReporter({
      version: 1,
      revision: {
        kind: "head",
        commit: "a".repeat(40),
        execution: { current: 1, total: 2 },
      },
    }, async () => {
      observations += 1;
      throw new Error("async progress consumer failed");
    });

    report({
      language: "typescript",
      phase: "project-load",
      unit: { current: 1, total: 1, path: "." },
      sourceFile: null,
    });
    expect(observations).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("truncates an emoji path at a UTF-8 codepoint boundary while retaining a real suffix", () => {
    const progress: RepositoryAnalysisProgress[] = [];
    const report = createRepositoryAnalysisProgressReporter({
      version: 1,
      revision: {
        kind: "merge-base",
        commit: "b".repeat(40),
        execution: { current: 2, total: 2 },
      },
    }, (event) => progress.push(event));
    const original = `src/${"😀".repeat(180)}/nested/final-🧭.ts`;
    report({
      language: "typescript",
      phase: "structure",
      unit: { current: 1, total: 1, path: "." },
      sourceFile: { current: 1, total: 1, path: original },
    });

    const bounded = progress[0]?.sourceFile?.path ?? "";
    expect(progress[0]?.sourceFile?.pathTruncated).toBe(true);
    expect(bounded.startsWith("…/")).toBe(true);
    expect(original.endsWith(bounded.slice("…/".length))).toBe(true);
    expect(bounded).not.toContain("\uFFFD");
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(512);
  });

  it("rejects non-canonical commit ids and out-of-range execution coordinates", () => {
    const progress = {
      version: 1,
      revision: {
        kind: "merge-base",
        commit: "A".repeat(40),
        execution: { current: 1, total: 2 },
      },
      language: "typescript",
      phase: "finalize",
      unit: null,
      sourceFile: null,
    };
    expect(isRepositoryAnalysisProgress(progress)).toBe(false);
    const sha256Progress = {
      ...progress,
      revision: {
        ...progress.revision,
        commit: "b".repeat(64),
        execution: { current: 8, total: 8 },
      },
    };
    expect(isRepositoryAnalysisProgress(sha256Progress)).toBe(true);
    expect(isRepositoryAnalysisProgress({
      ...sha256Progress,
      revision: {
        ...sha256Progress.revision,
        commit: "b".repeat(41),
      },
    })).toBe(false);
    expect(isRepositoryAnalysisProgress({
      ...sha256Progress,
      revision: {
        ...sha256Progress.revision,
        execution: { current: 9, total: 9 },
      },
    })).toBe(false);
    expect(isRepositoryAnalysisProgress({
      ...sha256Progress,
      phase: "relationships",
      activity: "unknown",
    })).toBe(false);
    expect(isRepositoryAnalysisProgress({
      ...sha256Progress,
      phase: "finalize",
      activity: "logic-flows",
    })).toBe(false);
  });
});

function shardPolicy() {
  return {
    version: 1 as const,
    mode: "empty" as const,
    admission: null,
    cacheDir: "/cache/typescript-revision-shards-v1",
    pairCacheDir: null,
    treeOid: "c".repeat(40),
    buildFingerprint: "d".repeat(64),
    analysisPolicyFingerprint: "e".repeat(64),
    runtimeFingerprint: {
      nodeVersion: "v26.0.0",
      platform: "linux",
      arch: "x64",
      typescriptVersion: "6.0.3",
      tsMorphVersion: "28.0.0",
    },
  };
}

function admissionSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  if (!Buffer.isBuffer(publicDer) || !Buffer.isBuffer(privateDer)) {
    throw new Error("could not serialize test admission authority");
  }
  return {
    version: 1 as const,
    kind: "signer" as const,
    keyId: createHash("sha256").update(publicDer).digest("hex"),
    publicKeySpki: publicDer.toString("base64"),
    privateKeyPkcs8: privateDer.toString("base64"),
  };
}

function fixtureArtifact(): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-21T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [{
      id: "ts:src/index.ts",
      kind: "module",
      qualifiedName: "src/index.ts",
      displayName: "index.ts",
      language: "typescript",
      location: { file: "src/index.ts", startLine: 1 },
    }],
    edges: [],
  };
}
