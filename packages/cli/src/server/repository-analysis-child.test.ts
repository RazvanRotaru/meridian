import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import {
  runRepositoryAnalysisChild,
  runRepositoryArtifactRestampChild,
  verifyRepositoryArtifactFile,
} from "./repository-analysis-child";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("repository analysis child", () => {
  it("runs real repository analysis and returns only file-backed compact metadata", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const branchOutputPath = join(directory, "artifact-main.json");
    const root = join(REPO, "examples", "orders-api");

    const result = await runRepositoryAnalysisChild({
      absoluteRoot: root,
      cwd: root,
      targetName: "orders-api",
      vcs: { repository: "https://example.test/orders-api.git", commit: "a".repeat(40) },
    }, {
      artifactOutputPath,
      branchVariant: { artifactOutputPath: branchOutputPath, branch: "main" },
      timeoutMs: 30_000,
    });

    const artifact = JSON.parse(readFileSync(artifactOutputPath, "utf8")) as GraphArtifact;
    expect(result.material).toMatchObject({
      kind: "verified-file",
      path: artifactOutputPath,
      byteDigest: createHash("sha256").update(readFileSync(artifactOutputPath)).digest("hex"),
    });
    expect(result.summary.nodeCount).toBe(artifact.nodes.length);
    expect(result.summary.edgeCount).toBe(artifact.edges.length);
    expect(result.target).toEqual(artifact.target);
    expect(result.emptySideHints).toEqual([expect.stringMatching(/\.ts$/)]);
    expect(result.sourceFiles).toContain("src/server.ts");
    expect(artifact.target.vcs?.branch).toBeUndefined();
    expect(result.branchVariant?.target.vcs?.branch).toBe("main");
    expect((JSON.parse(readFileSync(branchOutputPath, "utf8")) as GraphArtifact).target.vcs?.branch).toBe("main");
    expect(result).not.toHaveProperty("artifact");
    expect(result).not.toHaveProperty("nodes");
    expect(result).not.toHaveProperty("edges");
    expect(await verifyRepositoryArtifactFile(
      artifactOutputPath,
      result.byteLength,
      result.material.byteDigest,
      result.summary,
    )).toMatchObject({ kind: "verified-file", path: artifactOutputPath });
    expect(await verifyRepositoryArtifactFile(
      artifactOutputPath,
      result.byteLength,
      "0".repeat(64),
      result.summary,
    )).toBeNull();
    const controller = new AbortController();
    const reason = new Error("cache waiter left");
    controller.abort(reason);
    await expect(verifyRepositoryArtifactFile(
      artifactOutputPath,
      result.byteLength,
      result.material.byteDigest,
      result.summary,
      controller.signal,
    )).rejects.toBe(reason);
  }, 30_000);

  it("validates and restamps branch provenance entirely in a one-shot child", async () => {
    const directory = temporaryDirectory();
    const inputArtifactPath = join(directory, "neutral.json");
    const artifactOutputPath = join(directory, "branch.json");
    const artifact = fixtureArtifact();
    const inputBytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
    writeFileSync(inputArtifactPath, inputBytes, { mode: 0o600 });

    const result = await runRepositoryArtifactRestampChild({
      inputArtifactPath,
      expectedInputDigest: createHash("sha256").update(inputBytes).digest("hex"),
      branch: "feature/review",
    }, { artifactOutputPath, id: "branch-variant" });

    const output = JSON.parse(readFileSync(artifactOutputPath, "utf8")) as GraphArtifact;
    expect(output.target.vcs?.branch).toBe("feature/review");
    expect(result.target.vcs?.branch).toBe("feature/review");
    expect(result.changedSinceBaseRef).toBe("a".repeat(40));
    expect(result.changedFiles).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/z.ts", previousPath: "src/old-z.ts", status: "renamed" },
    ]);
    expect(result.sourceFiles).toEqual(["src/index.ts"]);
    expect(result.emptySideHints).toEqual([]);
  }, 15_000);

  it("does not start a child for an already-aborted request", async () => {
    const directory = temporaryDirectory();
    const reason = new Error("subscriber left before admission");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, {
      artifactOutputPath: join(directory, "artifact.json"),
      signal: controller.signal,
      workerEntry: "/does/not/exist.cjs",
    })).rejects.toBe(reason);
  });

  it("kills the complete process group and rejects only after descendants disappear", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const pidPath = `${artifactOutputPath}.pid`;
    const workerEntry = customWorker(directory, `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      process.once("message", (message) => {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        descendant.unref();
        writeFileSync(message.artifactOutputPath + ".pid", String(descendant.pid));
        setInterval(() => {}, 1000);
      });
    `);
    const controller = new AbortController();
    const reason = new Error("last waiter disconnected");
    reason.name = "AbortError";
    const pending = runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, {
      artifactOutputPath,
      signal: controller.signal,
      workerEntry,
      terminateGraceMs: 40,
      processTreeKillWaitMs: 2_000,
    });
    await waitForFile(pidPath);
    const descendantPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    expect(processExists(descendantPid)).toBe(true);

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(processExists(descendantPid)).toBe(false);
    expect(existsSync(artifactOutputPath)).toBe(false);
  }, 15_000);

  it("removes residual descendants before resolving a normal worker result", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const pidPath = `${artifactOutputPath}.pid`;
    const workerEntry = customWorker(directory, `
      const { createHash } = require("node:crypto");
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.once("message", (message) => {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        descendant.unref();
        writeFileSync(message.artifactOutputPath + ".pid", String(descendant.pid));
        const artifact = ${JSON.stringify(fixtureArtifact())};
        const bytes = Buffer.from(JSON.stringify(artifact) + "\\n", "utf8");
        writeFileSync(message.artifactOutputPath, bytes, { flag: "wx", mode: 0o600 });
        process.send({
          type: "result",
          result: {
            kind: "file",
            operation: message.type,
            id: message.id,
            artifactPath: message.artifactOutputPath,
            artifactBytes: bytes.byteLength,
            artifactSha256: createHash("sha256").update(bytes).digest("hex"),
            branchVariant: null,
            graphSummary: {
              schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
              generatedAt: artifact.generatedAt,
              nodeCount: artifact.nodes.length,
              edgeCount: artifact.edges.length,
            },
            target: artifact.target,
            changedFiles: [],
            emptySideHints: [],
            sourceFiles: ["src/index.ts"],
            changedSinceBaseRef: null,
            warnings: [],
          },
        }, () => {
          process.disconnect();
          setTimeout(() => process.exit(0), 20);
        });
      });
    `);

    await runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, { artifactOutputPath, workerEntry, processTreeKillWaitMs: 2_000 });

    const descendantPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    expect(processExists(descendantPid)).toBe(false);
  }, 15_000);

  it("keeps child stderr and unexpected failures out of the returned error", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const workerEntry = customWorker(directory, `
      process.once("message", () => {
        process.stderr.write("private/source/path github_pat_12345678901234567890".repeat(10000));
        process.exit(2);
      });
    `);

    const error = await rejectionOf(runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, { artifactOutputPath, workerEntry }));

    expect(error).toMatchObject({
      exitCode: 1,
      message: "repository analysis worker exited without a valid response",
    });
    expect((error as Error).message).not.toContain("private/source/path");
    expect((error as Error).message).not.toContain("github_pat_");
  }, 15_000);

  it("enforces the reserved heap after custom worker arguments", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const heapPath = `${artifactOutputPath}.heap`;
    const workerEntry = customWorker(directory, `
      const { writeFileSync } = require("node:fs");
      const { getHeapStatistics } = require("node:v8");
      process.once("message", (message) => {
        const heapMb = getHeapStatistics().heap_size_limit / (1024 * 1024);
        writeFileSync(message.artifactOutputPath + ".heap", String(heapMb));
        setInterval(() => {}, 1000);
      });
    `);
    const controller = new AbortController();
    const reason = new Error("heap probe complete");
    const pending = runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, {
      artifactOutputPath,
      signal: controller.signal,
      workerEntry,
      workerExecArgv: ["--max-old-space-size=2048"],
      workerHeapMb: 1_024,
    });

    await waitForFile(heapPath);
    expect(Number(readFileSync(heapPath, "utf8"))).toBeLessThan(1_536);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  }, 15_000);

  it("stream-verifies the child digest before creating a verified-file proof", async () => {
    const directory = temporaryDirectory();
    const artifactOutputPath = join(directory, "artifact.json");
    const workerEntry = customWorker(directory, `
      const { writeFileSync } = require("node:fs");
      process.once("message", (message) => {
        const artifact = ${JSON.stringify(fixtureArtifact())};
        const bytes = Buffer.from(JSON.stringify(artifact) + "\\n", "utf8");
        writeFileSync(message.artifactOutputPath, bytes, { flag: "wx", mode: 0o600 });
        process.send({
          type: "result",
          result: {
            kind: "file",
            operation: message.type,
            id: message.id,
            artifactPath: message.artifactOutputPath,
            artifactBytes: bytes.byteLength,
            artifactSha256: "f".repeat(64),
            branchVariant: null,
            graphSummary: {
              schemaVersion: ${JSON.stringify(SCHEMA_VERSION)},
              generatedAt: artifact.generatedAt,
              nodeCount: artifact.nodes.length,
              edgeCount: artifact.edges.length,
            },
            target: artifact.target,
            changedFiles: [],
            emptySideHints: [],
            sourceFiles: ["src/index.ts"],
            changedSinceBaseRef: null,
            warnings: [],
          },
        }, () => process.disconnect());
      });
    `);

    const error = await rejectionOf(runRepositoryAnalysisChild({
      absoluteRoot: "/unused",
      cwd: "/unused",
    }, { artifactOutputPath, workerEntry }));

    expect(error).toMatchObject({
      exitCode: 1,
      message: "could not verify repository analysis worker artifact",
    });
    expect(existsSync(artifactOutputPath)).toBe(false);
  }, 15_000);
});

function fixtureArtifact(): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-21T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name: "fixture",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://example.test/repo.git", commit: "b".repeat(40) },
    },
    nodes: [{
      id: "ts:src/index.ts",
      kind: "module",
      qualifiedName: "src/index.ts",
      displayName: "index.ts",
      language: "typescript",
      location: { file: "src/index.ts", startLine: 1, endLine: 2 },
    }],
    edges: [],
    extensions: {
      changedSince: {
        baseRef: "a".repeat(40),
        manifest: [
          { path: "src/z.ts", previousPath: "src/old-z.ts", status: "renamed" },
          { path: "src/a.ts", status: "modified" },
        ],
      },
    },
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "meridian-analysis-child-"));
  directories.push(directory);
  return directory;
}

function customWorker(directory: string, source: string): string {
  const path = join(directory, `worker-${Math.random().toString(16).slice(2)}.cjs`);
  writeFileSync(path, source, { mode: 0o600 });
  return path;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
