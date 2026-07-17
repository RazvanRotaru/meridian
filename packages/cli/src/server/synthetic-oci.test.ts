import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphArtifact, SyntheticExecution } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import {
  buildSyntheticOciDockerArgs,
  parseSyntheticOciResult,
  runSyntheticScenarioInOci,
  SYNTHETIC_OCI_IMAGE,
  SYNTHETIC_OCI_RESULT_PREFIX,
  syntheticPrSandboxRuntimeSupported,
  syntheticOciContainerUser,
} from "./synthetic-oci";
import { syntheticSourceFingerprint } from "./synthetic-fingerprint";
import {
  parseSyntheticCompilationJob,
  parseSyntheticOciJob,
  parseSyntheticWorkerError,
  SYNTHETIC_WORKER_ERROR_PREFIX,
} from "./synthetic-worker-job";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SHOPFRONT = join(REPO, "examples", "shopfront");
const ociIt = process.env.MERIDIAN_OCI_SMOKE === "1" ? it : it.skip;

describe("synthetic OCI boundary", () => {
  it("builds a fail-closed, resource-bounded docker invocation", () => {
    const args = buildSyntheticOciDockerArgs(
      "meridian-synthetic-test",
      "/checkout/pr-head",
      "/cache/artifacts/head.json",
      "/opt/meridian/dist/synthetic-oci-worker.js",
      "1000:1000",
    );
    expect(args.slice(0, 3)).toEqual(["run", "--pull=never", "--rm"]);
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(option(args, "--cap-drop")).toBe("ALL");
    expect(option(args, "--security-opt")).toBe("no-new-privileges");
    expect(option(args, "--pids-limit")).toBe("64");
    expect(option(args, "--memory")).toBe("512m");
    expect(option(args, "--cpus")).toBe("1");
    expect(option(args, "--user")).toBe("1000:1000");
    expect(args).toContain("--interactive");
    expect(option(args, "--tmpfs")).toMatch(/noexec.*nosuid.*nodev/);
    expect(args.filter((value) => value.startsWith("type=bind"))).toEqual([
      "type=bind,src=/checkout/pr-head,dst=/source,readonly",
      "type=bind,src=/cache/artifacts/head.json,dst=/artifact.json,readonly",
      "type=bind,src=/opt/meridian/dist/synthetic-oci-worker.js,dst=/opt/meridian/synthetic-oci-worker.js,readonly",
    ]);
    expect(args).toContain(SYNTHETIC_OCI_IMAGE);
    expect(SYNTHETIC_OCI_IMAGE).toBe("node:22");
    expect(args.join(" ")).not.toMatch(/docker\.sock|node_modules|--privileged|--network=(?!none)|--pull=(?!never)/);
    expect(args.filter((value) => value.startsWith("type=bind"))).toHaveLength(3);
    for (const name of [
      "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "FTP_PROXY", "ftp_proxy",
      "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "NODE_OPTIONS",
    ]) {
      expect(containerEnvironment(args)).toContain(`${name}=`);
    }
    expect(args.slice(-4)).toEqual(["run-oci", "-", "/source", "/artifact.json"]);
  });

  it("maps the sandbox to a non-root host identity and refuses root", () => {
    const user = syntheticOciContainerUser();
    if (typeof process.getuid !== "function") {
      expect(user).toBe("65532:65532");
    } else if (process.getuid() === 0) {
      expect(user).toBeNull();
    } else {
      expect(user).toBe(`${process.getuid()}:${typeof process.getgid === "function" ? process.getgid() : process.getuid()}`);
    }
  });

  it("accepts only strict, bounded worker jobs", () => {
    const artifact = minimalArtifact();
    expect(parseSyntheticCompilationJob({
      artifact,
      scenario: {
        id: "root",
        label: "Root",
        rootId: "ts:src/index.ts#root",
        defaultInput: null,
        invoke: { module: "src/index.ts", export: "root" },
      },
    }).scenario.id).toBe("root");
    expect(parseSyntheticOciJob({
      scenarioId: "root",
      expectedSourceFingerprint: "a".repeat(64),
    }).inputOverrides).toEqual([]);
    expect(() => parseSyntheticOciJob({
      scenarioId: "root",
      expectedSourceFingerprint: "a".repeat(64),
      ambientEnvironment: { SECRET: "no" },
    })).toThrow(/invalid/i);
    expect(() => parseSyntheticOciJob({
      scenarioId: "root",
      expectedSourceFingerprint: "not-a-fingerprint",
    })).toThrow(/invalid/i);
  });

  it("parses one strict result envelope and rejects logs or malformed results", () => {
    const result = minimalExecution();
    expect(parseSyntheticOciResult(`${SYNTHETIC_OCI_RESULT_PREFIX}${JSON.stringify({ ok: true, result })}\n`))
      .toEqual(result);
    expect(() => parseSyntheticOciResult(JSON.stringify(result))).toThrow(/no result/i);
    expect(() => parseSyntheticOciResult(
      `${SYNTHETIC_OCI_RESULT_PREFIX}${JSON.stringify({ ok: true, result: { ...result, unexpected: process.env } })}\n`,
    )).toThrow(/malformed/i);
    expect(() => parseSyntheticOciResult(
      `${SYNTHETIC_OCI_RESULT_PREFIX}${JSON.stringify({ ok: false, result })}\n`,
    )).toThrow(/malformed/i);
  });

  it("maps only a code/status worker error envelope across the trust boundary", () => {
    const parsed = parseSyntheticWorkerError(
      `${SYNTHETIC_WORKER_ERROR_PREFIX}${JSON.stringify({
        ok: false,
        error: { code: "compile-failed", status: 422 },
      })}\n`,
      "OCI",
    );
    expect(parsed).toMatchObject({ code: "compile-failed", status: 422 });
    expect(parsed?.message).not.toMatch(/path|stack|source/i);
    expect(parseSyntheticWorkerError(
      `${SYNTHETIC_WORKER_ERROR_PREFIX}${JSON.stringify({
        ok: false,
        error: { code: "compile-failed", status: 422, message: "secret" },
      })}\n`,
      "OCI",
    )).toBeNull();
  });

  ociIt("runs the real shopfront scenario inside the hardened container", async () => {
    expect(syntheticPrSandboxRuntimeSupported()).toBe(true);
    const { artifact } = await extractToArtifact({
      absoluteRoot: SHOPFRONT,
      cwd: SHOPFRONT,
      project: join(SHOPFRONT, "tsconfig.json"),
      materializeBoundary: true,
    });
    const root = mkdtempSync(join(tmpdir(), "meridian-oci-test-"));
    try {
      const artifactPath = join(root, "artifact.json");
      writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");
      const result = await runSyntheticScenarioInOci({
        sourceRoot: SHOPFRONT,
        artifactPath,
        scenarioId: "shopfront-add-item-unavailable",
        expectedRootId: "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem",
        expectedSourceFingerprint: syntheticSourceFingerprint(SHOPFRONT, artifact),
      });
      expect(result.outcome).toBe("completed");
      expect(result.trace.status).toBe("ok");
      expect(result.output).toMatchObject({ status: 200, body: { id: "synthetic_cart", items: [] } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function containerEnvironment(args: string[]): string[] {
  return args.flatMap((value, index) => value === "--env" ? [args[index + 1]!] : []);
}

function minimalArtifact(): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [{
      id: "ts:src/index.ts#root",
      kind: "function",
      qualifiedName: "root",
      displayName: "root",
      parentId: null,
      location: { file: "src/index.ts", startLine: 1, endLine: 1 },
    }],
    edges: [],
  };
}

function minimalExecution(): SyntheticExecution {
  return {
    executionVersion: "1.0.0",
    scenarioId: "root",
    rootId: "ts:src/index.ts#root",
    generatedAt: "2026-07-14T00:00:00.000Z",
    input: null,
    outcome: "completed",
    output: null,
    trace: {
      traceId: "00000000000000000000000000000001",
      name: "root",
      rootSpanId: "0000000000000001",
      startedAtUnixNano: "1",
      endedAtUnixNano: "2",
      status: "ok",
      attributes: {},
      spans: [{
        spanId: "0000000000000001",
        nodeId: "ts:src/index.ts#root",
        name: "root",
        kind: "internal",
        startedAtUnixNano: "1",
        endedAtUnixNano: "2",
        status: "ok",
        attributes: {},
        events: [],
      }],
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
    },
    snapshots: [],
    inputOverrideResults: [],
    watchHits: [],
    warnings: [],
  };
}
