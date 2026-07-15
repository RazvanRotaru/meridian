import type { GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import type {
  GraphProjectionActivateOptions,
  GraphProjectionDataSource,
  GraphProjectionManifest,
  GraphProjectionRequest,
  GraphProjectionReviewPairOptions,
  LoadedGraphProjection,
  LoadedReviewProjection,
} from "../graph/graphProjectionClient";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, projectionRequestForState } from "./store";

const PACKAGE = "ts:src";
const FILE = "ts:src/app.ts";
const UNIT = `${FILE}#App`;

function node(id: string, kind: string, parentId: string | null = null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: id, startLine: 1 },
  };
}

const OVERVIEW = artifact([node(PACKAGE, "package")]);
const FOCUSED = artifact([
  node(PACKAGE, "package"),
  node(FILE, "module", PACKAGE),
  node(UNIT, "class", FILE),
]);

describe("view-scoped projection store integration", () => {
  it("rejects PR preparation when no projection transport was installed", () => {
    expect(() => createBlueprintStore({
      artifact: OVERVIEW,
      index: buildGraphIndex(OVERVIEW),
      projectionDataSource: null,
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prsUrl: "",
      prOneUrl: "",
      prFilesUrl: "",
      prRelatedUrl: "",
      prCommentsUrl: "",
      prChecksUrl: "",
      prReviewUrl: "",
      prepareUrl: "/api/pr/prepare",
      prSessionSource: { repository: "o/r", subdir: "" },
    })).toThrow("PR preparation requires graph projection transport");
  });

  it("describes current module, logic, and review navigation without sending whole review membership", () => {
    const store = freshStore(null);
    store.setState({
      viewMode: "logic",
      logicRoot: UNIT,
      logicStack: [UNIT],
      expandedLogic: new Set([`${UNIT}.run`]),
      logicInlineDepth: 2,
      moduleSelected: new Set([FILE]),
      minimalMemberIds: Array.from({ length: 1_000 }, (_, index) => `ts:changed-${index}`),
      prReviewed: 42,
      prPreparedArtifactCurrent: true,
      showTests: true,
    });

    const request = projectionRequestForState(store.getState());
    expect(request).toMatchObject({
      view: "review",
      focusIds: [UNIT, UNIT],
      expandedIds: [`${UNIT}.run`],
      extraIds: [FILE],
      depth: 3,
      radius: 1,
      includeTests: true,
    });
    expect(JSON.stringify(request)).not.toContain("changed-999");
  });

  it("activates the focused projection before deriving the module scene", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED);
    const store = freshStore(dataSource);
    store.setState({ moduleFocus: PACKAGE, moduleExpanded: new Set([FILE]) });

    await store.getState().moduleRelayout();

    expect(dataSource.requests).toHaveLength(1);
    expect(dataSource.requests[0]?.request).toMatchObject({
      view: "modules",
      focusIds: [PACKAGE],
      expandedIds: [FILE],
    });
    expect(store.getState().artifact).toBe(FOCUSED);
    expect(store.getState().activeProjectionKey).toBe("projection-key");
    expect(store.getState().index.nodesById.has(UNIT)).toBe(true);
    expect(store.getState().moduleLayoutStatus).toBe("ready");
  });

  it("aborts a superseded navigation request", async () => {
    const dataSource = new RecordingProjectionSource(FOCUSED, true);
    const store = freshStore(dataSource);
    const first = store.getState().moduleRelayout({ label: "first" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(1));
    store.setState({ moduleFocus: PACKAGE });
    const second = store.getState().moduleRelayout({ label: "second" });
    await vi.waitFor(() => expect(dataSource.requests).toHaveLength(2));

    expect(dataSource.requests[0]?.options.signal?.aborted).toBe(true);
    dataSource.resolveLatest();
    await Promise.all([first, second]);
    expect(store.getState().moduleLayoutStatus).toBe("ready");
  });
});

class RecordingProjectionSource implements GraphProjectionDataSource {
  activeKey: string | undefined;
  readonly requests: Array<{ request: GraphProjectionRequest; options: GraphProjectionActivateOptions }> = [];
  private latestResolve: ((projection: LoadedGraphProjection) => void) | null = null;

  constructor(private readonly projected: GraphArtifact, private readonly deferred = false) {}

  async loadManifest(): Promise<GraphProjectionManifest> {
    return {
      version: 2,
      graphId: "graph-1",
      contentId: "0".repeat(64),
      graphSummary: {
        schemaVersion: OVERVIEW.schemaVersion,
        generatedAt: OVERVIEW.generatedAt,
        nodeCount: OVERVIEW.nodes.length,
        edgeCount: OVERVIEW.edges.length,
      },
      defaultView: {
        view: "modules",
        filePaths: [],
        focusIds: [],
        expandedIds: [],
        extraIds: [],
        depth: 1,
        radius: 0,
        includeTests: false,
      },
    };
  }

  activate(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions = {},
  ): Promise<LoadedGraphProjection> {
    this.requests.push({ request, options });
    if (!this.deferred || this.requests.length > 1) {
      if (this.deferred) {
        return new Promise((resolve) => { this.latestResolve = resolve; });
      }
      return Promise.resolve(this.projection(request));
    }
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
  }

  activateCached(): LoadedGraphProjection | undefined {
    return undefined;
  }

  activateReviewPair(_options: GraphProjectionReviewPairOptions): Promise<LoadedReviewProjection> {
    throw new Error("review pair is not exercised by this focused module-navigation source");
  }

  activateCachedReview(): LoadedReviewProjection | undefined {
    return undefined;
  }

  resolveLatest(): void {
    this.latestResolve?.(this.projection(this.requests.at(-1)!.request));
  }

  private projection(request: GraphProjectionRequest): LoadedGraphProjection {
    const result: LoadedGraphProjection = {
      key: "projection-key",
      projectionId: "projection-id",
      graphId: "graph-1",
      request,
      artifact: this.projected,
      index: buildGraphIndex(this.projected),
      serializedBytes: 100,
      residentBytes: 300,
    };
    this.activeKey = result.key;
    return result;
  }
}

function freshStore(projectionDataSource: GraphProjectionDataSource | null) {
  return createBlueprintStore({
    artifact: OVERVIEW,
    index: buildGraphIndex(OVERVIEW),
    projectionDataSource,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
}

function artifact(nodes: GraphNode[]): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "repo", root: ".", language: "typescript" },
    nodes,
    edges: [],
  };
}
