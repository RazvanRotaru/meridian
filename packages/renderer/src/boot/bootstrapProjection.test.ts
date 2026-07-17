import {
  deriveGraphStructure,
  graphProjectionIdentityPreimage,
  type GraphArtifact,
} from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootConfig } from "./bootConfig";
import {
  canonicalizeProjectionRequest,
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionRequest,
} from "../graph/graphProjectionClient";
import { loadBootGraph, prepareBootstrap } from "./bootstrap";
import { RecentAllocationBudget } from "../state/recentViewProjectionCache";

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
      if (url.includes("projection")) return projectionJson(init);
      throw new Error(`unexpected full graph request: ${url}`);
    }));

    const loaded = await loadBootGraph(config());

    expect(loaded.artifact).toEqual(ARTIFACT);
    expect(loaded.projection?.projectionId).toBe(await projectionIdForTest(OVERVIEW_PROJECTION_REQUEST));
    expect(urls).toEqual([
      "/api/graph/manifest?id=graph-1",
      "/api/graph/projection?id=graph-1",
    ]);
  });

  it("attaches boot projections to the caller-supplied shared inactive budget", async () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 1, maxRecentBytes: 1_000_000 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? json(manifest())
      : projectionJson(init)));
    const loaded = await loadBootGraph(config(), budget);

    const staged = await loaded.dataSource!.stage({
      ...OVERVIEW_PROJECTION_REQUEST,
      focusIds: ["ts:focus"],
    }, {
      endpoints: {
        graphId: "graph-1",
        manifestUrl: "/api/graph/manifest?id=graph-1",
        projectionUrl: "/api/graph/projection?id=graph-1",
        searchUrl: "/api/graph/search?id=graph-1",
      },
    });
    staged.commit();
    staged.release();

    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(loaded.projection!.residentBytes);
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

  it("rejects a boot manifest whose graph identity differs from its injected capability", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return json({ ...manifest(), graphId: "misrouted-graph" });
    }));

    await expect(loadBootGraph(config())).rejects.toThrow(
      "manifest identity mismatch: expected 'graph-1', received 'misrouted-graph'",
    );
    expect(urls).toEqual(["/api/graph/manifest?id=graph-1"]);
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
        projectionGraphId: "graph-1",
        projectionManifestUrl: "/api/graph/manifest?id=graph-1",
        projectionUrl: "/api/graph/projection?id=graph-1",
        graphSearchUrl: "/api/graph/search?id=graph-1",
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
        preparedReviewUrl: null,
        defaultEnv: null,
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? json(manifest())
      : projectionJson(init)));

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
      graphId: "graph-1",
      manifestUrl: "/api/graph/manifest?id=graph-1",
      projectionUrl: "/api/graph/projection?id=graph-1",
      searchUrl: "/api/graph/search?id=graph-1",
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
    preparedReviewUrl: null,
    defaultEnv: null,
  };
}

function json(value: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function projectionJson(init: RequestInit | undefined): Promise<Response> {
  const request = canonicalizeProjectionRequest(JSON.parse(String(init?.body)) as GraphProjectionRequest);
  const structure = deriveGraphStructure(ARTIFACT.nodes, ARTIFACT.edges);
  const projectionId = await projectionIdForTest(request);
  const moduleOverview = request.focusIds.length === 0
    && (request.view === "modules" || request.view === "ui")
    ? structure.moduleOverview
    : null;
  return json({
    version: 6,
    contentId: "0".repeat(64),
    projectionId,
    request,
    artifact: ARTIFACT,
    hierarchy: {
      moduleOverviewRootIds: moduleOverview?.roots.map((root) => root.id) ?? [],
      nodes: Object.fromEntries(structure.hierarchyById),
    },
    viewFacts: {
      moduleOverview,
      service: null,
      review: null,
    },
    analysis: { reachability: null },
    completeness: { complete: true, reasons: [], omittedNodes: 0, omittedEdges: 0 },
    residentBytes: 1,
  }, {
    "x-meridian-projection-id": projectionId,
    "x-meridian-resident-bytes": "1",
  });
}

async function projectionIdForTest(request: GraphProjectionRequest): Promise<string> {
  const input = new TextEncoder().encode(
    graphProjectionIdentityPreimage("0".repeat(64), request),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function manifest() {
  const structure = deriveGraphStructure(ARTIFACT.nodes, ARTIFACT.edges);
  return {
    version: 6,
    graphId: "graph-1",
    contentId: "0".repeat(64),
    graphSummary: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: 0,
      edgeCount: 0,
    },
    repositorySummary: structure.repositorySummary,
    defaultView: OVERVIEW_PROJECTION_REQUEST,
  };
}
