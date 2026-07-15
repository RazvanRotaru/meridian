import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootConfig } from "./bootConfig";
import {
  canonicalizeProjectionRequest,
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionRequest,
} from "../graph/graphProjectionClient";
import { loadBootGraph, prepareBootstrap } from "./bootstrap";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "repo", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("projection-aware graph boot", () => {
  it("boots from the overview projection without requesting the complete artifact", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("manifest")) return json(manifest());
      if (url.includes("projection")) return json(projectionEnvelope(init, "overview-1"));
      throw new Error(`unexpected full graph request: ${url}`);
    }));

    const loaded = await loadBootGraph(config());

    expect(loaded.artifact).toEqual(ARTIFACT);
    expect(loaded.projection?.projectionId).toBe("overview-1");
    expect(urls).toEqual([
      "/api/graph/manifest?id=graph-1",
      "/api/graph/projection?id=graph-1",
    ]);
  });

  it("surfaces an advertised projection failure instead of silently materializing /api/graph", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("manifest")) return json(manifest());
      return new Response("unavailable", { status: 503 });
    }));

    await expect(loadBootGraph(config())).rejects.toThrow("graph projection fetch failed (503)");
    expect(urls.some((url) => url === "/api/graph?id=graph-1")).toBe(false);
  });

  it("keeps complete-artifact loading isolated to the explicit Vite sample source", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return json(ARTIFACT);
    }));

    const loaded = await loadBootGraph({
      ...config(),
      graphSource: { kind: "dev-sample", artifactUrl: "/sample-graph.json" },
    });

    expect(urls).toEqual(["/sample-graph.json"]);
    expect(loaded.dataSource).toBeNull();
    expect(loaded.projection).toBeNull();
  });

  it("builds the live store before URL/layout hydration is allowed to begin", async () => {
    vi.stubGlobal("window", {
      __MERIDIAN__: {
        projectionManifestUrl: "/api/graph/manifest?id=graph-1",
        projectionUrl: "/api/graph/projection?id=graph-1",
        metaUrl: "/api/meta?id=graph-1",
        overlayUrl: "/api/overlay?id=graph-1",
        traceUrl: "/api/traces?id=graph-1",
        hasOverlay: false,
        overlayKind: null,
        envRequired: true,
        preselectedEnv: null,
        telemetrySources: [],
        preselectedTelemetrySourceId: null,
        sourceUrl: null,
        syntheticExecutionUrl: null,
        syntheticExecutionTrust: null,
        syntheticScenarios: [],
        githubSource: null,
        defaultEnv: null,
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? json(manifest())
      : json(projectionEnvelope(init, "overview-1"))));

    const prepared = await prepareBootstrap();

    expect(prepared.store.getState().artifact).toEqual(ARTIFACT);
    expect(prepared.store.getState().moduleLayoutStatus).toBe("idle");
    expect(prepared.store.getState().moduleRfNodes).toEqual([]);
    expect(prepared.hydrate).toEqual(expect.any(Function));
  });
});

function config(): BootConfig {
  return {
    graphSource: {
      kind: "projections",
      manifestUrl: "/api/graph/manifest?id=graph-1",
      projectionUrl: "/api/graph/projection?id=graph-1",
    },
    metaUrl: "/api/meta?id=graph-1",
    overlayUrl: "/api/overlay?id=graph-1",
    traceUrl: "/api/traces?id=graph-1",
    traceAvailable: false,
    hasOverlay: false,
    overlayKind: null,
    envRequired: true,
    preselectedEnv: null,
    telemetrySources: [],
    preselectedTelemetrySourceId: null,
    sourceUrl: null,
    syntheticExecutionUrl: null,
    syntheticExecutionTrust: null,
    syntheticScenarios: [],
    githubSource: null,
    defaultEnv: null,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function projectionEnvelope(init: RequestInit | undefined, projectionId: string) {
  const request = canonicalizeProjectionRequest(JSON.parse(String(init?.body)) as GraphProjectionRequest);
  return {
    projectionId,
    request,
    artifact: ARTIFACT,
    childCounts: {},
    completeness: { complete: true, reasons: [], omittedNodes: 0, omittedEdges: 0 },
    residentBytes: 1,
  };
}

function manifest() {
  return {
    version: 2,
    graphId: "graph-1",
    contentId: "0".repeat(64),
    graphSummary: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: 0,
      edgeCount: 0,
    },
    defaultView: OVERVIEW_PROJECTION_REQUEST,
  };
}
