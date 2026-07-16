import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { graphSummaryFor } from "./inspection-snapshot-store";
import { injectViewBoot } from "./web-boot";
import { sendMeta, sendView } from "./web-graph";
import type { Context } from "./web-server";
import { artifactSourceFor, type ArtifactSource } from "./web-source";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("injectViewBoot", () => {
  it("exposes the exact PR-session source only for a GitHub-sourced graph", () => {
    const github = injectViewBoot("<head></head>", "graph-1", { kind: "github", owner: "octo", repo: "repo" });
    const local = injectViewBoot("<head></head>", "graph-2", { kind: "other" });

    expect(github).toContain('"overlayUrl":"/api/overlay?id=graph-1"');
    expect(github).toContain('"traceUrl":"/api/traces?id=graph-1"');
    expect(local).toContain('"traceUrl":"/api/traces?id=graph-2"');
    expect(github).toContain('"projectionManifestUrl":"/api/graph/manifest?id=graph-1"');
    expect(github).toContain('"projectionUrl":"/api/graph/projection?id=graph-1"');
    expect(github).toContain('"preparedReviewUrl":null');
    expect(github).not.toContain('"graphUrl"');
    expect(github).toContain('"telemetrySources":[{"id":"demo"');
    expect(github).toContain('"label":"Synthetic demo"');
    expect(github).toContain('"preselectedTelemetrySourceId":null');
    expect(github).toContain('"githubSource":{"repository":"octo/repo","subdir":""}');
    expect(github).toContain('"syntheticExecutionUrl":null');
    expect(github).toContain('"syntheticScenarios":[]');
    expect(github).toContain('"syntheticExecutionTrust":null');
    expect(local).toContain('"githubSource":null');
  });

  it("advertises a per-id synthetic endpoint only for an enabled local scenario catalog", () => {
    const scenario = {
      id: "place-order",
      label: "Place an order",
      rootId: "ts:src/services/orderService.ts#OrderService.placeOrder",
      defaultInput: { customerId: "cust_demo", lines: [] },
    };
    const html = injectViewBoot("<head></head>", "graph-2", { kind: "path" }, [scenario], { mode: "local" });

    expect(html).toContain('"syntheticExecutionUrl":"/api/synthetic-executions?id=graph-2"');
    expect(html).toContain('"syntheticScenarios":[{"id":"place-order"');
    expect(html).toContain('"syntheticExecutionTrust":{"mode":"local"}');

    const remote = injectViewBoot(
      "<head></head>",
      "graph-3",
      { kind: "github", owner: "octo", repo: "repo" },
      [scenario],
    );
    expect(remote).toContain('"syntheticExecutionUrl":null');
    expect(remote).toContain('"syntheticScenarios":[]');

    const sandboxed = injectViewBoot(
      "<head></head>",
      "graph-4",
      { kind: "github", owner: "octo", repo: "repo" },
      [scenario],
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
    );
    expect(sandboxed).toContain('"syntheticExecutionUrl":"/api/synthetic-executions?id=graph-4"');
    expect(sandboxed).toContain('"syntheticScenarios":[{"id":"place-order"');
    expect(sandboxed).toContain(
      '"syntheticExecutionTrust":{"mode":"sandboxed-pr","provenance":{"repository":"octo/repo","headSha":"abc123"}}',
    );
  });

  it("does not advertise execution authority without an authored scenario catalog", () => {
    const html = injectViewBoot(
      "<head></head>",
      "graph-empty",
      { kind: "github", owner: "octo", repo: "repo" },
      null,
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
    );

    expect(html).toContain('"syntheticExecutionUrl":null');
    expect(html).toContain('"syntheticScenarios":[]');
    expect(html).toContain('"syntheticExecutionTrust":null');
  });
});

describe("artifact source execution identity", () => {
  it("retains local path provenance instead of collapsing it into the generic non-GitHub case", () => {
    expect(artifactSourceFor({ kind: "path", value: "/repo" })).toEqual({ kind: "path" });
    expect(artifactSourceFor({ kind: "github", value: "octo/repo" })).toMatchObject({ kind: "github" });
  });
});

describe("sendView", () => {
  it("derives the exact PR-session source from the stored artifact source", () => {
    expect(capturedView({ kind: "github", owner: "octo", repo: "repo" })).toContain(
      '"githubSource":{"repository":"octo/repo","subdir":""}',
    );
    expect(capturedView({ kind: "other" })).toContain('"githubSource":null');
  });
});

describe("sendMeta synthetic capability", () => {
  const scenario = {
    id: "flow",
    label: "Flow",
    rootId: "ts:src/a.ts#flow",
    defaultInput: {},
  };

  it("returns the exact local graph capability", () => {
    expect(capturedMeta({ kind: "path" }, { mode: "local" }, [scenario])).toMatchObject({
      syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
      syntheticScenarios: [{ id: "flow" }],
      syntheticExecutionTrust: { mode: "local" },
    });
  });

  it("does not return sandbox provenance before a scenario exists", () => {
    expect(capturedMeta(
      { kind: "github", owner: "octo", repo: "repo" },
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
      [],
    )).toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
  });

  it("does not leak a missing or source-mismatched capability", () => {
    expect(capturedMeta({ kind: "github", owner: "octo", repo: "repo" }, null, [scenario])).toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
    expect(capturedMeta(
      { kind: "path" },
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
      [scenario],
    )).toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
  });
});

function capturedView(source: ArtifactSource): string {
  const id = "graph-1";
  const root = mkdtempSync(join(tmpdir(), "meridian-view-boot-"));
  temporary.push(root);
  const artifactPath = join(root, "artifact.json");
  const artifact = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "test", root: ".", language: "typescript" },
    nodes: [],
    edges: [],
  } as GraphArtifact;
  writeGraphProjectionBundle(join(root, GRAPH_PROJECTION_DIRECTORY), artifact);
  const ctx = {
    localGraphFiles: new Map([[id, {
      artifactPath,
      graphSummary: graphSummaryFor(artifact),
      projectionDirectory: join(root, GRAPH_PROJECTION_DIRECTORY),
    }]]),
    sourceRoots: new Map(),
    sources: new Map([[id, source]]),
    inspectionSnapshots: {
      resolveArtifact: () => null,
      resolveSource: () => null,
      resolveSyntheticCapability: () => null,
      resolveDescriptor: () => null,
    },
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: false,
    syntheticPrSandboxRuntimeSupported: () => false,
    rendererIndex: "<head></head>",
  } as unknown as Context;
  let html = "";
  const response = {
    writeHead: vi.fn(),
    end: vi.fn((body: string) => {
      html = body;
    }),
  } as unknown as ServerResponse;

  sendView(ctx, response, id);
  return html;
}

function capturedMeta(
  source: ArtifactSource,
  trust: import("./web-boot").SyntheticExecutionTrust | null,
  scenarios: import("@meridian/core").SyntheticScenarioDescriptor[],
): Record<string, unknown> {
  const id = "graph-1";
  const root = mkdtempSync(join(tmpdir(), "meridian-meta-boot-"));
  temporary.push(root);
  const artifactPath = join(root, "artifact.json");
  writeFileSync(artifactPath, "{}", "utf8");
  writeFileSync(join(root, "synthetic-capability.json"), JSON.stringify({
    version: 1,
    state: scenarios.length > 0 ? "ready" : "absent",
    scenarios,
    sourceFingerprint: scenarios.length > 0 ? "a".repeat(64) : null,
    artifactCommit: trust?.mode === "sandboxed-pr" ? trust.provenance.headSha : null,
    warning: null,
  }), "utf8");
  const summary = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    nodeCount: 0,
    edgeCount: 0,
  };
  const descriptor = {
    graphSummary: summary,
    source: { metadata: source },
  };
  const ctx = {
    localGraphFiles: source.kind === "path" ? new Map([[id, {
      artifactPath,
      graphSummary: summary,
      projectionDirectory: join(root, GRAPH_PROJECTION_DIRECTORY),
    }]]) : new Map(),
    sourceRoots: source.kind === "path" ? new Map([[id, root]]) : new Map(),
    sources: new Map([[id, source]]),
    allowSyntheticExecution: trust?.mode === "local",
    allowSyntheticPrExecution: trust?.mode === "sandboxed-pr",
    syntheticPrSandboxRuntimeSupported: () => true,
    inspectionSnapshots: {
      resolveArtifact: () => source.kind === "github" ? { descriptor, path: artifactPath } : null,
      resolveDescriptor: () => source.kind === "github" ? descriptor : null,
      resolveSource: () => source.kind === "github" ? { sourceDir: root, metadata: source } : null,
      resolveSyntheticCapability: () => source.kind === "github" ? {
        capability: {
          version: 1,
          state: scenarios.length > 0 ? "ready" : "absent",
          scenarios,
          sourceFingerprint: scenarios.length > 0 ? "a".repeat(64) : null,
          artifactCommit: trust?.mode === "sandboxed-pr" ? trust.provenance.headSha : null,
          warning: null,
        },
        executionTrust: trust?.mode === "sandboxed-pr" ? trust : null,
      } : null,
    },
  } as unknown as Context;
  let body = "";
  const response = {
    writeHead: vi.fn(),
    end: vi.fn((chunk: string) => {
      body = chunk;
    }),
  } as unknown as ServerResponse;

  sendMeta(ctx, response, id);
  return JSON.parse(body) as Record<string, unknown>;
}
