import { renderToStaticMarkup } from "react-dom/server";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../../graph/graphIndex";
import { createBlueprintStore } from "../../state/store";
import { StoreProvider } from "../../state/StoreContext";
import { deriveRelatedCodeGroups, RelatedCodeRail } from "./RelatedCodeRail";

const CURRENT = node("ts:src/current.ts#current", "current", "src/current.ts", 10);
const ALPHA = node("ts:src/alpha.ts#Alpha.run", "Alpha.run", "src/alpha.ts", 4);
const BETA = node("ts:src/beta.ts#Beta.go", "Beta.go", "src/beta.ts", 21);
const ZETA = node("ts:src/zeta.ts#Zeta.render", "Zeta.render", "src/zeta.ts", 7);
const EXTERNAL = node("ext:library#outside", "outside", "library", 1, "external");

const EDGES: GraphEdge[] = [
  edge("calls:alpha-1", ALPHA.id, CURRENT.id, "calls"),
  edge("calls:alpha-2", ALPHA.id, CURRENT.id, "calls"),
  edge("calls:beta", CURRENT.id, BETA.id, "calls"),
  edge("imports:alpha", CURRENT.id, ALPHA.id, "imports"),
  edge("renders:zeta", ZETA.id, CURRENT.id, "renders"),
  edge("calls:self", CURRENT.id, CURRENT.id, "calls"),
  edge("calls:external", CURRENT.id, EXTERNAL.id, "calls"),
  edge("calls:missing", CURRENT.id, "ts:src/missing.ts#missing", "calls"),
];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-08-07T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [CURRENT, ALPHA, BETA, ZETA, EXTERNAL],
  edges: EDGES,
};

describe("deriveRelatedCodeGroups", () => {
  it("groups and sorts truthful source-backed one-hop neighbors while deduplicating parallel edges", () => {
    const groups = deriveRelatedCodeGroups(buildGraphIndex(ARTIFACT), CURRENT);

    expect(groups.map((group) => group.relation)).toEqual(["calls", "imports", "renders"]);
    expect(groups).toEqual([
      {
        relation: "calls",
        neighbors: [
          { direction: "incoming", relation: "calls", node: ALPHA, edgeIds: ["calls:alpha-1", "calls:alpha-2"] },
          { direction: "outgoing", relation: "calls", node: BETA, edgeIds: ["calls:beta"] },
        ],
      },
      {
        relation: "imports",
        neighbors: [
          { direction: "outgoing", relation: "imports", node: ALPHA, edgeIds: ["imports:alpha"] },
        ],
      },
      {
        relation: "renders",
        neighbors: [
          { direction: "incoming", relation: "renders", node: ZETA, edgeIds: ["renders:zeta"] },
        ],
      },
    ]);
  });

  it("omits source-backed neighbors that the active session cannot actually open", () => {
    const groups = deriveRelatedCodeGroups(
      buildGraphIndex(ARTIFACT),
      CURRENT,
      (candidate) => candidate.id !== BETA.id,
    );

    expect(groups.flatMap((group) => group.neighbors.map((neighbor) => neighbor.node.id)))
      .not.toContain(BETA.id);
    expect(groups.flatMap((group) => group.neighbors.map((neighbor) => neighbor.node.id)))
      .toContain(ALPHA.id);
  });
});

describe("RelatedCodeRail", () => {
  it("renders loaded-graph content for the shared rail landmark with its own vertical scroll", () => {
    const markup = renderRail(ARTIFACT, CURRENT);

    expect(markup).toContain('<div data-related-code-rail="true"');
    expect(markup).toContain("Related in loaded graph");
    expect(markup).toContain("overflow-y:auto");
    expect(markup).not.toContain("<aside");
    expect(markup).not.toContain('role="complementary"');
    expect(markup).toContain('aria-label="calls relationships"');
    expect(markup).toContain('aria-label="imports relationships"');
    expect(markup).toContain('aria-label="renders relationships"');
    expect(markup.match(/data-related-code-node-id="ts:src\/alpha.ts#Alpha.run"/g)).toHaveLength(2);
    expect(markup).toContain('data-related-code-edge-count="2"');
    expect(markup).toContain('aria-label="Open Alpha.run, incoming calls, in source"');
    expect(markup).toContain('aria-label="Open Beta.go, outgoing calls, in source"');
    expect(markup).toContain("src/beta.ts:21");
    expect(markup).not.toContain("Close");
  });

  it("keeps a visible, honest empty state when no loaded neighbor can open source", () => {
    const isolated: GraphArtifact = { ...ARTIFACT, nodes: [CURRENT], edges: [] };
    const markup = renderRail(isolated, CURRENT);

    expect(markup).toContain('<div data-related-code-rail="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-related-code-empty="true"');
    expect(markup).toContain("No related code in the loaded graph.");
  });
});

function renderRail(artifact: GraphArtifact, currentNode: GraphNode): string {
  const store = createBlueprintStore({
    artifact,
    index: buildGraphIndex(artifact),
    provider: null,
    hasOverlay: false,
    sourceUrl: "/source",
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <RelatedCodeRail currentNode={currentNode} />
    </StoreProvider>,
  );
}

function node(
  id: string,
  displayName: string,
  file: string,
  startLine: number,
  kind: GraphNode["kind"] = "function",
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: displayName,
    displayName,
    parentId: null,
    location: { file, startLine },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: GraphEdge["kind"],
): GraphEdge {
  return { id, source, target, kind, resolution: "resolved" };
}
