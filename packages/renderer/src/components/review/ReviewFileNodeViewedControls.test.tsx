import type { GraphArtifact, GraphNode } from "@meridian/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildGraphIndex } from "../../graph/graphIndex";
import { createBlueprintStore } from "../../state/store";
import { StoreProvider } from "../../state/StoreContext";
import { SurfaceInteractionScope } from "../canvas/SurfaceInteractionContext";
import {
  REVIEW_NODE_VIEWED_CSS,
  ReviewNodeViewedChrome,
  ReviewViewedButton,
} from "./ReviewFileNodeViewedControls";

const FOLDER_ID = "ts:src";
const FILE_ID = "ts:src/a.ts";
const UNIT_ID = "ts:src/a.ts#run";
const OUTSIDE_FILE_ID = "ts:other/b.ts";
const FOLDER_NODE: GraphNode = {
  id: FOLDER_ID,
  kind: "package",
  qualifiedName: "src",
  displayName: "src",
  location: { file: "src", startLine: 1, endLine: 1 },
};
const FILE_NODE: GraphNode = {
  id: FILE_ID,
  kind: "module",
  qualifiedName: "src/a.ts",
  displayName: "a.ts",
  parentId: FOLDER_ID,
  location: { file: "src/a.ts", startLine: 1, endLine: 30 },
};
const UNIT_NODE: GraphNode = {
  id: UNIT_ID,
  kind: "function",
  qualifiedName: "run",
  displayName: "run",
  location: { file: "src/a.ts", startLine: 4, endLine: 12 },
};
const OUTSIDE_FILE_NODE: GraphNode = {
  id: OUTSIDE_FILE_ID,
  kind: "module",
  qualifiedName: "other/b.ts",
  displayName: "b.ts",
  location: { file: "other/b.ts", startLine: 1, endLine: 20 },
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [FOLDER_NODE, FILE_NODE, UNIT_NODE, OUTSIDE_FILE_NODE],
  edges: [],
};

describe("ReviewNodeViewedChrome", () => {
  it("renders graph-scaled folder, file, and unit states in periwinkle without a fixed toolbar transform", () => {
    const markup = renderReviewNodes({ fingerprint: "unit-fingerprint" });

    expect(markup.match(/data-review-view-state="done"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).toContain('data-review-viewed-scope="folder"');
    expect(markup).toContain('data-review-viewed-scope="file"');
    expect(markup).toContain('data-review-viewed-scope="unit"');
    expect(markup).toContain("Viewed src folder — click to unmark");
    expect(markup).toContain("#A78BFA");
    expect(markup).toContain("background-color:#A78BFA1A");
    expect(markup).not.toContain("#3FB950");
    expect(markup).not.toContain("transform:scale");
    expect(markup).not.toContain("VIEWED");
    expect(markup).toContain("top:-10px;right:-10px");
    expect(markup).toContain("inset:-1px");
  });

  it("uses a dashed, icon-distinct stale state and hides controls outside the review surface", () => {
    const stale = renderReviewNodes({ fingerprint: "old-fingerprint" });
    const disabled = renderReviewNodes({ fingerprint: "unit-fingerprint", enabled: false });

    expect(stale).toContain('data-review-view-state="stale"');
    expect(stale).toMatch(/data-review-viewed-scope="folder" data-review-view-state="stale"/);
    expect(stale).toContain("dashed");
    expect(disabled).not.toContain("data-review-view-state");
  });

  it("keeps todo controls quiet but discoverable until hover or keyboard focus", () => {
    expect(REVIEW_NODE_VIEWED_CSS).toContain('[data-review-view-state="todo"] .review-node-viewed-indicator');
    expect(REVIEW_NODE_VIEWED_CSS).toContain("opacity: 0.28");
    expect(REVIEW_NODE_VIEWED_CSS).toContain(":hover .review-node-viewed-indicator");
    expect(REVIEW_NODE_VIEWED_CSS).toContain(":focus-within .review-node-viewed-indicator");
    expect(REVIEW_NODE_VIEWED_CSS).not.toContain("pointer-events: none");
  });

  it("does not add folder progress chrome without an exact review-rollup membership", () => {
    const markup = renderReviewNodes({ fingerprint: "unit-fingerprint", folderMembers: [] });

    expect(markup).not.toContain('data-review-viewed-scope="folder"');
    expect(markup).toContain('data-review-viewed-scope="file"');
  });

  it("bulk-toggles only the files represented by the folder rollup", () => {
    const store = reviewStore({ folderMembers: [FILE_ID] });

    store.getState().toggleReviewFileViewed("other/b.ts");
    const outsideTick = store.getState().reviewFileTicks["other/b.ts"];
    store.getState().toggleReviewFilesViewed(["src/a.ts"]);

    expect(store.getState().reviewUnitTicks[UNIT_ID]).toBeDefined();
    expect(store.getState().reviewFileTicks["other/b.ts"]).toBe(outsideTick);

    store.getState().toggleReviewFilesViewed(["src/a.ts"]);
    expect(store.getState().reviewUnitTicks[UNIT_ID]).toBeUndefined();
    expect(store.getState().reviewFileTicks["other/b.ts"]).toBe(outsideTick);
  });
});

describe("ReviewViewedButton", () => {
  it("stops graph gestures and delegates exactly one semantic toggle", () => {
    const onToggle = vi.fn();
    const button = ReviewViewedButton({
      nodeId: UNIT_ID,
      scope: "unit",
      state: "done",
      label: "Viewed run — click to unmark",
      onToggle,
    });
    const stopPropagation = vi.fn();

    button.props.onPointerDown({ stopPropagation });
    button.props.onClick({ stopPropagation });
    button.props.onDoubleClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledTimes(3);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button.props.className).toContain("nodrag nopan");
    expect(button.props["aria-pressed"]).toBe(true);
  });
});

function renderReviewNodes({
  fingerprint,
  enabled = true,
  folderMembers = [FILE_ID],
}: {
  fingerprint?: string;
  enabled?: boolean;
  folderMembers?: string[];
}): string {
  const store = reviewStore({ fingerprint, folderMembers });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <SurfaceInteractionScope
        readOnly={false}
        selectionOverride={null}
        reviewProgressEnabled={enabled}
      >
        <ReviewNodeViewedChrome nodeId={FOLDER_ID} scope="folder" borderRadius={8}>
          <div>folder</div>
        </ReviewNodeViewedChrome>
        <ReviewNodeViewedChrome nodeId={FILE_ID} scope="file" borderRadius={8}>
          <div>file</div>
        </ReviewNodeViewedChrome>
        <ReviewNodeViewedChrome nodeId={UNIT_ID} scope="unit" borderRadius={6}>
          <div>unit</div>
        </ReviewNodeViewedChrome>
      </SurfaceInteractionScope>
    </StoreProvider>,
  );
}

function reviewStore({
  fingerprint,
  folderMembers,
}: {
  fingerprint?: string;
  folderMembers: string[];
}) {
  const index = buildGraphIndex(ARTIFACT);
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: "",
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  store.setState({
    reviewFiles: [{
      path: "src/a.ts",
      status: "modified",
      moduleId: FILE_ID,
      isTest: false,
      units: [{
        nodeId: UNIT_ID,
        displayName: "run",
        kind: "function",
        startLine: 4,
        endLine: 12,
        depth: 0,
        isTest: false,
        fingerprint: "unit-fingerprint",
      }],
      fingerprint: "file-fingerprint",
      blastRadius: 0,
      deletedImpact: null,
    }, {
      path: "other/b.ts",
      status: "modified",
      moduleId: OUTSIDE_FILE_ID,
      isTest: false,
      units: [],
      fingerprint: "outside-file-fingerprint",
      blastRadius: 0,
      deletedImpact: null,
    }],
    reviewUnitTicks: fingerprint === undefined ? {} : { [UNIT_ID]: { at: "now", fingerprint } },
    reviewFileTicks: {},
    minimalRollups: folderMembers.length === 0 ? {} : { [FOLDER_ID]: folderMembers },
  });
  const snapshot = store.getState();
  Object.assign(store, { getInitialState: () => snapshot });
  return store;
}
