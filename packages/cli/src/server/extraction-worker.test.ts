import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../errors";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  extractionWorkerHeapMb,
  runExtractionWorker,
  MAX_EXTRACTION_WORKER_STDERR_BYTES,
} from "./extraction-worker";
import type { SerializablePipelineRequest } from "./extraction-worker";
import { GRAPH_PROJECTION_FORMAT_VERSION } from "./graph-projection-bundle";
import {
  GraphGenerationLifecycle,
  type GraphGenerationStage,
} from "./graph-generation-lifecycle";
import { parseGraphGenerationStagePath } from "./graph-cache-layout";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const tempDirectories: string[] = [];
const outputStages: GraphGenerationStage[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const stageResults = await Promise.allSettled(
    outputStages.splice(0).map((stage) => stage.release()),
  );
  const directoryResults = await Promise.allSettled(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  const failures = [...stageResults, ...directoryResults].flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "extraction worker fixture cleanup failed");
});

describe("extractionWorkerHeapMb", () => {
  it("preserves Meridian's prior 8 GiB extraction ceiling by default", () => {
    vi.stubEnv("MERIDIAN_EXTRACTION_WORKER_HEAP_MB", "");
    vi.stubEnv("NODE_OPTIONS", "");
    expect(extractionWorkerHeapMb()).toBe(8_192);
  });

  it("honors an explicit worker limit and a larger user-pinned Node limit", () => {
    vi.stubEnv("MERIDIAN_EXTRACTION_WORKER_HEAP_MB", "6144");
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=12288");
    expect(extractionWorkerHeapMb()).toBe(6_144);

    vi.stubEnv("MERIDIAN_EXTRACTION_WORKER_HEAP_MB", "");
    expect(extractionWorkerHeapMb()).toBe(12_288);
  });
});

describe("runExtractionWorker", () => {
  it("runs the real source worker and returns only file-backed metadata and warnings", async () => {
    const root = join(REPO, "examples", "orders-api");
    const output = await workerOutput();
    expect(parseGraphGenerationStagePath(
      output.lifecycleCacheRoot,
      dirname(output.artifactOutputPath),
    )).not.toBeNull();
    const result = await runExtractionWorker({
      absoluteRoot: root,
      cwd: root,
      project: join(root, "tsconfig.json"),
      materializeBoundary: true,
    }, output);

    const artifact = JSON.parse(await readFile(result.artifactPath, "utf8")) as { target: { language: string }; nodes: unknown[] };
    expect(artifact.target.language).toBe("typescript");
    expect(artifact.nodes.length).toBeGreaterThan(0);
    expect(result.graphSummary.nodeCount).toBe(artifact.nodes.length);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^TypeScript: /),
    ]));
    expect(result.kind).toBe("file");
  }, 15_000);

  it("round-trips an explicitly safe CliError from the real worker", async () => {
    const root = join(REPO, "examples", "orders-api");
    const error = await rejectionOf(runExtractionWorker({
      absoluteRoot: root,
      cwd: root,
      language: "not-a-language",
      materializeBoundary: true,
    }, await workerOutput()));

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: EXIT.extractor, details: [] });
    expect((error as Error).message).toContain("no extractor for language 'not-a-language'");
  });

  it("preserves safe CliError details and defensively redacts a token from the response", { timeout: 15_000 }, async () => {
    const token = "github_pat_worker_transport_secret_123456789";
    const entry = await customWorker(`
      process.once("message", (message) => {
        const token = message.token;
        const encoded = Buffer.from("x-access-token:" + token, "utf8").toString("base64");
        const inArgv = process.argv.some((value) => value.includes(token));
        const inEnv = Object.values(process.env).some((value) => value && value.includes(token));
        process.send({
          type: "error",
          error: {
            kind: "cli",
            exitCode: 3,
            message: "validation rejected " + token,
            details: [
              "argv=" + inArgv,
              "env=" + inEnv,
              "AUTHORIZATION: basic " + encoded,
              "label=" + message.request.changedSinceLabel,
            ],
          },
        }, () => process.disconnect());
      });
    `);

    const previous = { github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = token;
    process.env.GH_TOKEN = `${token}-secondary`;
    let error: unknown;
    try {
      error = await rejectionOf(runExtractionWorker(dummyRequest({
        changedSince: "refs/meridian/jobs/test/base",
        changedSinceLabel: "origin/main",
      }), { ...(await workerOutput()), workerEntry: entry, token }));
    } finally {
      restoreEnvironment("GITHUB_TOKEN", previous.github);
      restoreEnvironment("GH_TOKEN", previous.gh);
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: EXIT.validation });
    expect((error as CliError).details.slice(0, 2)).toEqual(["argv=false", "env=false"]);
    expect(`${(error as Error).message}\n${(error as CliError).details.join("\n")}`).not.toContain(token);
    expect((error as CliError).details[2]).toBe("AUTHORIZATION: basic ***");
    expect((error as CliError).details[3]).toBe("label=origin/main");
  });

  it("keeps untrusted stderr bounded and out of the returned transport error", async () => {
    const entry = await customWorker(`
      process.once("message", () => {
        process.stderr.write("sensitive-marker-".repeat(${MAX_EXTRACTION_WORKER_STDERR_BYTES * 4}), () => process.exit(2));
      });
    `);

    const error = await rejectionOf(runExtractionWorker(dummyRequest(), {
      ...(await workerOutput()), workerEntry: entry,
    }));
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: EXIT.internal, details: [] });
    expect((error as Error).message).toBe("extraction worker exited without a valid response");
    expect((error as Error).message).not.toContain("sensitive-marker");
  });

  it("sends SIGTERM, escalates to SIGKILL, and rejects only after the child closes", { timeout: 15_000 }, async () => {
    const directory = await temporaryDirectory();
    const ready = join(directory, "ready");
    const entry = await customWorker(`
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      process.once("message", (message) => {
        writeFileSync(message.request.absoluteRoot, "ready");
        setInterval(() => {}, 1_000);
      });
    `, directory);
    const controller = new AbortController();
    const reason = new Error("subscriber left");
    reason.name = "AbortError";
    const pending = runExtractionWorker(dummyRequest({ absoluteRoot: ready }), {
      ...(await workerOutput()),
      workerEntry: entry,
      signal: controller.signal,
      terminateGraceMs: 40,
    });
    await waitForFile(ready);

    const started = Date.now();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    if (process.platform !== "win32") {
      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    }
  });

  it("does not fork at all for an already-aborted subscriber", async () => {
    const controller = new AbortController();
    const reason = new Error("already gone");
    controller.abort(reason);
    await expect(runExtractionWorker(dummyRequest(), {
      ...(await workerOutput()),
      signal: controller.signal,
      workerEntry: "/does/not/exist.cjs",
    })).rejects.toBe(reason);
  });

  it("enforces an overall extraction timeout", async () => {
    const entry = await customWorker(`
      process.on("SIGTERM", () => {});
      process.once("message", () => setInterval(() => {}, 1_000));
    `);
    const error = await rejectionOf(runExtractionWorker(dummyRequest(), {
      ...(await workerOutput()),
      workerEntry: entry,
      timeoutMs: 30,
      terminateGraceMs: 20,
    }));
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: EXIT.extractor, message: "extraction timed out after 1s" });
  });

  it("kills descendant processes when a worker is cancelled", { timeout: 15_000 }, async () => {
    const directory = await temporaryDirectory();
    const ready = join(directory, "descendant-pid");
    const entry = await customWorker(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      process.once("message", (message) => {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(message.request.absoluteRoot, String(descendant.pid));
        setInterval(() => {}, 1_000);
      });
    `, directory);
    const controller = new AbortController();
    const pending = runExtractionWorker(dummyRequest({ absoluteRoot: ready }), {
      ...(await workerOutput()),
      workerEntry: entry,
      signal: controller.signal,
      terminateGraceMs: 30,
    });
    await waitForFile(ready);
    const descendantPid = Number.parseInt(await readFile(ready, "utf8"), 10);
    expect(processExists(descendantPid)).toBe(true);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(processExists(descendantPid)).toBe(false);
  });

  it("kills residual process-group members before settling a normal worker exit", { timeout: 15_000 }, async () => {
    const directory = await temporaryDirectory();
    const descendantFile = join(directory, "normal-exit-descendant-pid");
    const entry = await customWorker(`
      ${projectionBundleWriter()}
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.once("message", (message) => {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        descendant.unref();
        writeFileSync(message.request.absoluteRoot, String(descendant.pid));
        const serialized = JSON.stringify({
          schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
          generatedAt: "2026-07-14T00:00:00.000Z",
          generator: { name: "meridian", version: "test" },
          target: { name: "test", root: ".", language: "typescript" },
          nodes: [],
          edges: [],
        });
        writeFileSync(message.artifactOutputPath, serialized);
        const projectionDirectory = writeProjectionBundle(message.artifactOutputPath);
        process.send({
          type: "result",
          result: {
            kind: "file",
            artifactPath: message.artifactOutputPath,
            artifactBytes: Buffer.byteLength(serialized),
            artifactSha256: require("node:crypto").createHash("sha256").update(serialized).digest("hex"),
            projectionDirectory,
            projectionBytes: 1,
            projectionSha256: "b".repeat(64),
            projectionContentId: "0".repeat(64),
            graphSummary: {
              schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
              generatedAt: "2026-07-14T00:00:00.000Z",
              nodeCount: 0,
              edgeCount: 0,
            },
            changedFiles: [],
            hintedFiles: [],
            warnings: [],
          },
        }, () => {
          process.disconnect();
          setTimeout(() => process.exit(0), 50);
        });
      });
    `, directory);

    await runExtractionWorker(dummyRequest({ absoluteRoot: descendantFile }), {
      ...(await workerOutput()), workerEntry: entry,
    });
    const descendantPid = Number.parseInt(await readFile(descendantFile, "utf8"), 10);
    expect(processExists(descendantPid)).toBe(false);
  });

  it("surfaces a bounded failure when POSIX cannot confirm process-group disappearance", async () => {
    if (process.platform === "win32") return;
    const entry = await customWorker(`
      ${projectionBundleWriter()}
      const { writeFileSync } = require("node:fs");
      process.once("message", (message) => {
        const serialized = JSON.stringify({
          schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
          generatedAt: "2026-07-14T00:00:00.000Z",
          generator: { name: "meridian", version: "test" },
          target: { name: "test", root: ".", language: "typescript" },
          nodes: [],
          edges: [],
        });
        writeFileSync(message.artifactOutputPath, serialized);
        const projectionDirectory = writeProjectionBundle(message.artifactOutputPath);
        process.send({
          type: "result",
          result: {
            kind: "file",
            artifactPath: message.artifactOutputPath,
            artifactBytes: Buffer.byteLength(serialized),
            artifactSha256: require("node:crypto").createHash("sha256").update(serialized).digest("hex"),
            projectionDirectory,
            projectionBytes: 1,
            projectionSha256: "b".repeat(64),
            projectionContentId: "0".repeat(64),
            graphSummary: {
              schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
              generatedAt: "2026-07-14T00:00:00.000Z",
              nodeCount: 0,
              edgeCount: 0,
            },
            changedFiles: [],
            hintedFiles: [],
            warnings: [],
          },
        }, () => process.disconnect());
      });
    `);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) =>
      pid < 0 ? true : realKill(pid, signal as NodeJS.Signals | 0)
    ) as typeof process.kill);

    const error = await rejectionOf(runExtractionWorker(dummyRequest(), {
      ...(await workerOutput()),
      workerEntry: entry,
      processTreeKillWaitMs: 30,
    }));
    expect(error).toMatchObject({
      exitCode: EXIT.internal,
      message: "could not confirm extraction worker process tree termination",
    });
  });
});

function dummyRequest(overrides: Partial<SerializablePipelineRequest> = {}): SerializablePipelineRequest {
  return { absoluteRoot: "/unused", cwd: "/unused", materializeBoundary: true, ...overrides };
}

async function customWorker(source: string, existingDirectory?: string): Promise<string> {
  const directory = existingDirectory ?? await temporaryDirectory();
  const entry = join(directory, `worker-${Math.random().toString(16).slice(2)}.cjs`);
  await writeFile(entry, source, { mode: 0o600 });
  return entry;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meridian-extraction-worker-"));
  tempDirectories.push(directory);
  return directory;
}

async function workerOutput(): Promise<{ artifactOutputPath: string; lifecycleCacheRoot: string }> {
  const directory = await mkdtemp(join(tmpdir(), "meridian-extraction-output-"));
  tempDirectories.push(directory);
  const lifecycleCacheRoot = await realpath(directory);
  const lifecycle = new GraphGenerationLifecycle({ cacheRoot: lifecycleCacheRoot });
  const stage = await lifecycle.reserveStage();
  outputStages.push(stage);
  return {
    artifactOutputPath: join(stage.directory, "artifact.json"),
    lifecycleCacheRoot,
  };
}

function projectionBundleWriter(): string {
  return `
    function writeProjectionBundle(artifactPath) {
      const { createHash } = require("node:crypto");
      const { dirname, join } = require("node:path");
      const { mkdirSync, writeFileSync } = require("node:fs");
      const projectionDirectory = join(dirname(artifactPath), "graph-projections");
      mkdirSync(projectionDirectory, { recursive: true });
      const moduleOverview = JSON.stringify({ roots: [], edges: [] });
      const reachabilitySummary = JSON.stringify({
        summary: {
          callables: 0,
          covered: 0,
          indirect: 0,
          uncovered: 0,
          percent: 0,
          testNodes: 0,
          unresolvedFromTests: 0,
        },
        worstRows: [],
      });
      const serviceTopology = JSON.stringify({
        version: 1,
        clusters: [],
        metrics: [],
        featuresByUnit: [],
        couplings: [],
      });
      writeFileSync(join(projectionDirectory, "module-overview.json"), moduleOverview);
      writeFileSync(join(projectionDirectory, "module-overview-without-tests.json"), moduleOverview);
      writeFileSync(join(projectionDirectory, "reachability-summary.json"), reachabilitySummary);
      writeFileSync(join(projectionDirectory, "service-topology.json"), serviceTopology);
      writeFileSync(join(projectionDirectory, "manifest.json"), JSON.stringify({
        formatVersion: ${GRAPH_PROJECTION_FORMAT_VERSION},
        contentId: "0".repeat(64),
        graphSummary: {
          schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
          generatedAt: "2026-07-14T00:00:00.000Z",
          nodeCount: 0,
          edgeCount: 0,
        },
        repositorySummary: { overviewPackageCount: 0, sourceFileCount: 0, testSourceFileCount: 0 },
        header: {
          schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
          generatedAt: "2026-07-14T00:00:00.000Z",
          generator: { name: "meridian", version: "test" },
          target: { name: "test", root: ".", language: "typescript" },
        },
        shardCount: 256,
        roots: { count: 0, refs: [] },
        moduleOverviewRoots: {
          all: { count: 0, refs: [] },
          withoutTests: { count: 0, refs: [] },
        },
        uiEntryIds: {
          all: { count: 0, refs: [] },
          withoutTests: { count: 0, refs: [] },
        },
        changed: { count: 0, refs: [] },
        symbols: {
          map: { count: 0, refs: [], scopeCounts: { public: 0, all: 0, private: 0 } },
          logic: { count: 0, refs: [], scopeCounts: { public: 0, all: 0, private: 0 } },
        },
        filePathCount: 0,
        extensions: { entryModuleCount: 0, changedPathCount: 0, changedMetaBytes: 0, flowCount: 0 },
        facts: {
          moduleOverviewBytes: Buffer.byteLength(moduleOverview),
          moduleOverviewWithoutTestsBytes: Buffer.byteLength(moduleOverview),
          serviceTopology: {
            version: 1,
            bytes: Buffer.byteLength(serviceTopology),
            sha256: createHash("sha256").update(serviceTopology).digest("hex"),
          },
          reachabilitySummaryBytes: Buffer.byteLength(reachabilitySummary),
        },
      }));
      writeFileSync(join(dirname(artifactPath), "synthetic-capability.json"), JSON.stringify({
        version: 1,
        state: "absent",
        scenarios: [],
        sourceFingerprint: null,
        artifactCommit: null,
        warning: null,
      }));
      return projectionDirectory;
    }
  `;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected promise to reject");
  } catch (error) {
    return error;
  }
}

function restoreEnvironment(name: "GITHUB_TOKEN" | "GH_TOKEN", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
