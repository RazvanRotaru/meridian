import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeStatus, GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import { CodePanel } from "./CodePanel";

const FILE = "src/order.ts";
const NODE: GraphNode = {
  id: "ts:src/order.ts#Order",
  kind: "interface",
  qualifiedName: "Order",
  displayName: "Order",
  parentId: null,
  location: { file: FILE, startLine: 17, endLine: 20 },
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [NODE],
  edges: [],
};

function sourceModal(options: { live: boolean; status?: ChangeStatus }) {
  const status = options.status ?? "modified";
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
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
    review: {
      context: {
        changedFiles: [{ path: FILE, status, hunks: [{ start: 19, end: 19 }] }],
        baseRef: "main",
        baseSha: "base",
        headRef: "feature",
        reviewKey: "test-review",
        warnings: [],
      },
      rows: [],
      flows: {},
    },
    prReviewed: options.live ? 77 : null,
    reviewFileDelta: {
      [FILE]: { added: 1, deleted: status === "deleted" ? 4 : 1, status: status === "deleted" ? "removed" : "modified" },
    },
    codeView: {
      node: NODE,
      code: "before\nstill before\nchanged\nafter",
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 17,
      changedLineKinds: new Map([[19, "modified"]]),
      changedLines: new Set([19]),
    },
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(<StoreProvider store={store}><CodePanel /></StoreProvider>);
}

describe("CodePanel review comments", () => {
  it("offers a line draft on every visible HEAD row in a live PR review", () => {
    const markup = sourceModal({ live: true });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(4);
    for (const line of [17, 18, 19, 20]) {
      expect(markup).toContain(`aria-label="Comment on line ${line}"`);
    }
  });

  it("keeps artifact-only reviews limited to their anchorable changed rows", () => {
    const markup = sourceModal({ live: false });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Comment on line 19"');
  });

  it("does not offer HEAD-line drafts for a file removed by the PR", () => {
    const markup = sourceModal({ live: true, status: "deleted" });

    expect(markup).not.toContain('aria-label="Comment on line ');
  });
});
