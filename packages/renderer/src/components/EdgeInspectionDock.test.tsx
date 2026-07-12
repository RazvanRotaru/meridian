import { renderToStaticMarkup } from "react-dom/server";
import type { Edge } from "@xyflow/react";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import type { EdgeEvidenceContext } from "../graph/edgeEvidence";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import { CodePanel } from "./CodePanel";
import { EdgeInspectionDock } from "./EdgeInspectionDock";

const SOURCE: GraphNode = {
  id: "ts:src/a.ts#A.run",
  kind: "method",
  qualifiedName: "A.run",
  displayName: "run",
  location: { file: "src/a.ts", startLine: 1, endLine: 80 },
};
const TARGET: GraphNode = {
  id: "ts:src/b.ts#B.go",
  kind: "method",
  qualifiedName: "B.go",
  displayName: "go",
  location: { file: "src/b.ts", startLine: 1, endLine: 60 },
};
const LINK: GraphEdge = {
  id: "calls:A.run->B.go",
  source: SOURCE.id,
  target: TARGET.id,
  kind: "calls",
  resolution: "resolved",
  callSites: [{ file: "src/a.ts", line: 26, col: 43, endLine: 26, endCol: 78 }],
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [SOURCE, TARGET],
  edges: [LINK],
};
const WIRE: Edge = {
  id: "wire:A.run->B.go",
  source: SOURCE.id,
  target: TARGET.id,
  data: { relationKind: "calls", underlyingEdgeIds: [LINK.id] },
};
const CONTEXT: EdgeEvidenceContext = {
  edgeId: LINK.id,
  source: SOURCE.id,
  target: TARGET.id,
  kind: "calls",
  site: LINK.callSites![0]!,
};

function storeWithCode(edge = true) {
  const index = buildGraphIndex(ARTIFACT);
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index,
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
  store.setState({
    codeView: {
      node: SOURCE,
      code: Array.from({ length: 10 }, (_, index) => `line ${index + 21}`).join("\n"),
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 21,
      ...(edge ? {
        edgeEvidence: {
          contexts: [CONTEXT],
          activeIndex: 0,
          focusStartLine: 26,
          focusEndLine: 26,
        },
      } : {}),
    },
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return store;
}

describe("EdgeInspectionDock", () => {
  it("puts highlighted source beside wire evidence in one non-modal, one-close dock", () => {
    const markup = renderToStaticMarkup(
      <StoreProvider store={storeWithCode()}>
        <EdgeInspectionDock pair={[WIRE]} labelOf={(id) => id === SOURCE.id ? "run" : "go"} onClose={() => {}} onDrill={() => {}} />
      </StoreProvider>,
    );

    expect(markup).toContain("data-edge-inspection-dock=\"true\"");
    expect(markup).toContain("aria-label=\"Edge inspection\"");
    expect(markup).toContain("aria-label=\"Highlighted edge source\"");
    expect(markup).toContain("data-edge-evidence-line=\"true\"");
    expect(markup).toContain("Evidence 1 of 1");
    expect(markup).toContain("src/a.ts:26:43–78");
    expect(markup.match(/aria-label="Close edge inspection"/g)).toHaveLength(1);
    expect(markup).not.toContain("aria-modal");
    expect(markup.indexOf("Highlighted edge source")).toBeLessThan(markup.indexOf("Close edge inspection"));
  });

  it("keeps the global centered code modal out of edge inspection", () => {
    const markup = renderToStaticMarkup(
      <StoreProvider store={storeWithCode()}><CodePanel /></StoreProvider>,
    );
    expect(markup).toBe("");
  });

  it("keeps relationship metadata useful when source retrieval is unavailable", () => {
    const store = storeWithCode();
    store.setState({ codeView: null });
    const state = store.getState();
    Object.assign(store, { getInitialState: () => state });

    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <EdgeInspectionDock pair={[WIRE]} labelOf={(id) => id === SOURCE.id ? "run" : "go"} onClose={() => {}} onDrill={() => {}} />
      </StoreProvider>,
    );

    expect(markup).toContain("aria-label=\"Edge inspection\"");
    expect(markup).toContain("run");
    expect(markup).toContain("go");
    expect(markup).toContain("a.ts:26:43–78");
    expect(markup).not.toContain("aria-label=\"Highlighted edge source\"");
  });

  it("leaves ordinary node source in the existing centered modal", () => {
    const markup = renderToStaticMarkup(
      <StoreProvider store={storeWithCode(false)}><CodePanel /></StoreProvider>,
    );
    expect(markup).toContain("aria-label=\"Source code\"");
    expect(markup).toContain("aria-modal=\"true\"");
    expect(markup).not.toContain("data-edge-inspection-dock");
  });
});
