import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { graphSummaryFor } from "./graph-generation-contract";
import type { GraphCapabilityHandle } from "./graph-capability-store";
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
    expect(github).toContain('"projectionGraphId":"graph-1"');
    expect(github).toContain('"projectionManifestUrl":"/api/graph/manifest?id=graph-1"');
    expect(github).toContain('"projectionUrl":"/api/graph/projection?id=graph-1"');
    expect(github).toContain('"graphSearchUrl":"/api/graph/search?id=graph-1"');
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
  it("derives the exact PR-session source from the stored artifact source", async () => {
    await expect(capturedView({ kind: "github", owner: "octo", repo: "repo" })).resolves.toContain(
      '"githubSource":{"repository":"octo/repo","subdir":""}',
    );
    await expect(capturedView({ kind: "other" })).resolves.toContain('"githubSource":null');
  });
});

describe("sendMeta synthetic capability", () => {
  const scenario = {
    id: "flow",
    label: "Flow",
    rootId: "ts:src/a.ts#flow",
    defaultInput: {},
  };

  it("returns the exact local graph capability", async () => {
    await expect(capturedMeta({ kind: "path" }, { mode: "local" }, [scenario])).resolves.toMatchObject({
      syntheticExecutionUrl: "/api/synthetic-executions?id=graph-1",
      syntheticScenarios: [{ id: "flow" }],
      syntheticExecutionTrust: { mode: "local" },
    });
  });

  it("does not return sandbox provenance before a scenario exists", async () => {
    await expect(capturedMeta(
      { kind: "github", owner: "octo", repo: "repo" },
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
      [],
    )).resolves.toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
  });

  it("does not leak a missing or source-mismatched capability", async () => {
    await expect(capturedMeta({ kind: "github", owner: "octo", repo: "repo" }, null, [scenario]))
      .resolves.toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
    await expect(capturedMeta(
      { kind: "path" },
      { mode: "sandboxed-pr", provenance: { repository: "octo/repo", headSha: "abc123" } },
      [scenario],
    )).resolves.toMatchObject({
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    });
  });
});

async function capturedView(source: ArtifactSource): Promise<string> {
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
  const summary = graphSummaryFor(artifact);
  const handle = graphHandle({ artifactPath, root, source, summary, trust: null, scenarios: [] });
  const ctx = {
    shutdownSignal: new AbortController().signal,
    graphCapabilities: { acquire: async () => handle },
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: false,
    syntheticPrSandboxRuntimeSupported: () => false,
    rendererIndex: "<head></head>",
  } as unknown as Context;
  let html = "";
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn((body: string) => {
      html = body;
    }),
  }) as unknown as ServerResponse;

  await sendView(ctx, request(), response, id);
  return html;
}

async function capturedMeta(
  source: ArtifactSource,
  trust: import("./web-boot").SyntheticExecutionTrust | null,
  scenarios: import("@meridian/core").SyntheticScenarioDescriptor[],
): Promise<Record<string, unknown>> {
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
  const handle = graphHandle({ artifactPath, root, source, summary, trust, scenarios });
  const ctx = {
    shutdownSignal: new AbortController().signal,
    allowSyntheticExecution: trust?.mode === "local",
    allowSyntheticPrExecution: trust?.mode === "sandboxed-pr",
    syntheticPrSandboxRuntimeSupported: () => true,
    graphCapabilities: { acquire: async () => handle },
  } as unknown as Context;
  let body = "";
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn((chunk: string) => {
      body = chunk;
    }),
  }) as unknown as ServerResponse;

  await sendMeta(ctx, request(), response, id);
  return JSON.parse(body) as Record<string, unknown>;
}

function request(): IncomingMessage {
  return Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage;
}

function graphHandle(input: {
  artifactPath: string;
  root: string;
  source: ArtifactSource;
  summary: { schemaVersion: string; generatedAt: string; nodeCount: number; edgeCount: number };
  trust: import("./web-boot").SyntheticExecutionTrust | null;
  scenarios: import("@meridian/core").SyntheticScenarioDescriptor[];
}): GraphCapabilityHandle {
  const signal = new AbortController().signal;
  return {
    descriptor: {
      graphSummary: input.summary,
      source: { metadata: input.source },
    },
    artifactPath: input.artifactPath,
    projectionDirectory: join(input.root, GRAPH_PROJECTION_DIRECTORY),
    generationDirectory: input.root,
    source: {
      rootDir: input.root,
      sourceDir: input.root,
      subdir: "",
      metadata: input.source,
      owner: null,
    },
    synthetic: {
      capability: {
        version: 1,
        state: input.scenarios.length > 0 ? "ready" : "absent",
        scenarios: input.scenarios,
        sourceFingerprint: input.scenarios.length > 0 ? "a".repeat(64) : null,
        artifactCommit: input.trust?.mode === "sandboxed-pr" ? input.trust.provenance.headSha : null,
        warning: null,
      },
      executionTrust: input.trust?.mode === "sandboxed-pr" ? input.trust : null,
    },
    signal,
    renew: async () => {},
    release: async () => {},
  } as GraphCapabilityHandle;
}
