import type { GraphArtifact, GraphNode } from "@meridian/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildGraphIndex } from "../../graph/graphIndex";
import { createBlueprintStore } from "../../state/store";
import { StoreProvider } from "../../state/StoreContext";
import { SurfaceInteractionScope } from "../canvas/SurfaceInteractionContext";
import {
  REVIEW_NODE_VIEWED_CSS,
  ReviewFileViewedControl,
  ReviewNodeViewedChrome,
  ReviewPreviewViewedControl,
  ReviewViewedButton,
} from "./ReviewFileNodeViewedControls";

const FOLDER_ID = "ts:src";
const FILE_ID = "ts:src/ServiceContainerFactory.ts";
const CLASS_ID = "ts:src/ServiceContainerFactory.ts#OsService";
const UNIT_ID = "ts:src/ServiceContainerFactory.ts#OsService.getWellKnownPath";
const SECOND_UNIT_ID = "ts:src/ServiceContainerFactory.ts#OsService.getTempPath";
const OUTSIDE_FILE_ID = "ts:other/b.ts";
const OUTSIDE_UNIT_ID = "ts:other/b.ts#crossFileChild";
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
  qualifiedName: "src/ServiceContainerFactory.ts",
  displayName: "ServiceContainerFactory",
  parentId: FOLDER_ID,
  location: { file: "src/ServiceContainerFactory.ts", startLine: 1, endLine: 30 },
};
const CLASS_NODE: GraphNode = {
  id: CLASS_ID,
  kind: "class",
  qualifiedName: "OsService",
  displayName: "OsService",
  parentId: FILE_ID,
  location: { file: "src/ServiceContainerFactory.ts", startLine: 3, endLine: 20 },
};
const UNIT_NODE: GraphNode = {
  id: UNIT_ID,
  kind: "function",
  qualifiedName: "OsService.getWellKnownPath",
  displayName: "getWellKnownPath",
  parentId: CLASS_ID,
  location: { file: "src/ServiceContainerFactory.ts", startLine: 4, endLine: 12 },
};
const SECOND_UNIT_NODE: GraphNode = {
  id: SECOND_UNIT_ID,
  kind: "function",
  qualifiedName: "OsService.getTempPath",
  displayName: "getTempPath",
  parentId: CLASS_ID,
  location: { file: "src/ServiceContainerFactory.ts", startLine: 14, endLine: 18 },
};
const OUTSIDE_FILE_NODE: GraphNode = {
  id: OUTSIDE_FILE_ID,
  kind: "module",
  qualifiedName: "other/b.ts",
  displayName: "b.ts",
  location: { file: "other/b.ts", startLine: 1, endLine: 20 },
};
const OUTSIDE_UNIT_NODE: GraphNode = {
  id: OUTSIDE_UNIT_ID,
  kind: "function",
  qualifiedName: "crossFileChild",
  displayName: "crossFileChild",
  parentId: CLASS_ID,
  location: { file: "other/b.ts", startLine: 4, endLine: 8 },
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    FOLDER_NODE,
    FILE_NODE,
    CLASS_NODE,
    UNIT_NODE,
    SECOND_UNIT_NODE,
    OUTSIDE_FILE_NODE,
    OUTSIDE_UNIT_NODE,
  ],
  edges: [],
};

describe("ReviewNodeViewedChrome", () => {
  it("renders graph-scaled folder, file, and unit states in periwinkle without a fixed toolbar transform", () => {
    const markup = renderReviewNodes({ fingerprint: "file-fingerprint" });

    expect(markup.match(/data-review-view-state="done"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(markup).toContain('data-review-viewed-scope="folder"');
    expect(markup).toContain('data-review-viewed-scope="file"');
    expect(markup).toContain('data-review-viewed-scope="unit"');
    expect(markup).toContain("Viewed src folder — click to unmark");
    expect(markup).toContain("Viewed src/ServiceContainerFactory.ts — click to unmark");
    expect(markup).toContain("#A78BFA");
    expect(markup).toContain("background-color:#A78BFA1A");
    expect(markup).not.toContain("#3FB950");
    expect(markup).not.toContain("transform:scale");
    expect(markup).not.toContain("VIEWED");
    expect(markup).toContain("top:-10px;right:-10px");
    expect(markup).toContain("inset:-1px");
  });

  it("keeps a parent todo until every changed child has been viewed", () => {
    const store = reviewStore({ folderMembers: [FILE_ID] });

    store.getState().toggleReviewUnitTick(UNIT_ID);
    const partialMarkup = renderReviewNodesWithStore(store);

    expect(partialMarkup).toMatch(new RegExp(`data-review-node-id="${UNIT_ID}"[^>]+data-review-view-state="done"`));
    expect(partialMarkup).toMatch(new RegExp(`data-review-node-id="${SECOND_UNIT_ID}"[^>]+data-review-view-state="todo"`));
    expect(partialMarkup).toMatch(new RegExp(`data-review-node-id="${CLASS_ID}"[^>]+data-review-view-state="todo"`));
    expect(partialMarkup).toMatch(new RegExp(`data-review-node-id="${FILE_ID}"[^>]+data-review-view-state="todo"`));
    expect(store.getState().reviewFileTicks["src/ServiceContainerFactory.ts"]).toBeUndefined();

    store.getState().toggleReviewUnitTick(SECOND_UNIT_ID);
    const completeMarkup = renderReviewNodesWithStore(store);
    expect(completeMarkup).toMatch(new RegExp(`data-review-node-id="${CLASS_ID}"[^>]+data-review-view-state="done"`));
    expect(completeMarkup).toMatch(new RegExp(`data-review-node-id="${FILE_ID}"[^>]+data-review-view-state="done"`));
    expect(completeMarkup).toContain("Viewed src/ServiceContainerFactory.ts — click to unmark");
  });

  it("aggregates a structural parent against each descendant's owning file state", () => {
    const store = reviewStore({ folderMembers: [FILE_ID] });
    const [sourceFile, outsideFile] = store.getState().reviewFiles;
    store.setState({
      reviewFiles: [
        sourceFile!,
        {
          ...outsideFile!,
          units: [{
            nodeId: OUTSIDE_UNIT_ID,
            displayName: "crossFileChild",
            kind: "function",
            startLine: 4,
            endLine: 8,
            depth: 0,
            isTest: false,
            fingerprint: "outside-unit-fingerprint",
          }],
        },
      ],
      reviewFileViewedStates: {
        [sourceFile!.path]: "VIEWED",
        [outsideFile!.path]: "UNVIEWED",
      },
    });

    const partialMarkup = renderReviewNodesWithStore(store);
    expect(partialMarkup).toMatch(
      new RegExp(`data-review-node-id="${CLASS_ID}"[^>]+data-review-view-state="todo"`),
    );

    store.getState().toggleReviewUnitTick(OUTSIDE_UNIT_ID);
    const completeMarkup = renderReviewNodesWithStore(store);
    expect(completeMarkup).toMatch(
      new RegExp(`data-review-node-id="${CLASS_ID}"[^>]+data-review-view-state="done"`),
    );
  });

  it("uses a dashed, icon-distinct stale state and hides controls outside the review surface", () => {
    const stale = renderReviewNodes({ fingerprint: "old-fingerprint" });
    const disabled = renderReviewNodes({ fingerprint: "file-fingerprint", enabled: false });

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
    const markup = renderReviewNodes({ fingerprint: "file-fingerprint", folderMembers: [] });

    expect(markup).not.toContain('data-review-viewed-scope="folder"');
    expect(markup).toContain('data-review-viewed-scope="file"');
  });

  it("bulk-toggles only the files represented by the folder rollup", () => {
    const store = reviewStore({ folderMembers: [FILE_ID] });

    store.getState().toggleReviewFileViewed("other/b.ts");
    const outsideTick = store.getState().reviewFileTicks["other/b.ts"];
    store.getState().toggleReviewFilesViewed(["src/ServiceContainerFactory.ts"]);

    expect(store.getState().reviewFileTicks["src/ServiceContainerFactory.ts"]).toBeDefined();
    expect(store.getState().reviewFileTicks["other/b.ts"]).toBe(outsideTick);

    store.getState().toggleReviewFilesViewed(["src/ServiceContainerFactory.ts"]);
    expect(store.getState().reviewFileTicks["src/ServiceContainerFactory.ts"]).toBeUndefined();
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
    expect(button.props["aria-label"]).toBe("Viewed run — click to unmark");
    expect(button.props.title).toBe("Viewed run — click to unmark");
    expect(button.props["data-review-view-state"]).toBe("done");
  });

  it.each([
    ["todo", "Mark run as viewed", false],
    ["stale", "run changed since viewed — click to mark again", false],
    ["done", "Viewed run — click to unmark", true],
  ] as const)("exposes the %s state through its semantic label and pressed state", (state, label, pressed) => {
    const markup = renderToStaticMarkup(
      <ReviewViewedButton
        nodeId={UNIT_ID}
        scope="unit"
        state={state}
        label={label}
        onToggle={() => undefined}
      />,
    );

    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`title="${label}"`);
    expect(markup).toContain(`aria-pressed="${pressed}"`);
    expect(markup).toContain(`data-review-view-state="${state}"`);
  });
});

describe("ReviewPreviewViewedControl", () => {
  it("resolves file and declaration previews to the same semantic state and top-right control as their nodes", () => {
    const store = reviewStore({ fingerprint: "file-fingerprint", folderMembers: [FILE_ID] });

    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewPreviewViewedControl nodeId={FILE_ID} />
        <ReviewPreviewViewedControl nodeId={CLASS_ID} />
        <ReviewPreviewViewedControl nodeId={UNIT_ID} />
      </StoreProvider>,
    );

    expect(markup.match(/data-review-view-state="done"/g)?.length).toBe(6);
    expect(markup).toContain('data-review-viewed-scope="file"');
    expect(markup.match(/data-review-viewed-scope="unit"/g)?.length).toBe(2);
    expect(markup).toContain("Viewed src/ServiceContainerFactory.ts — click to unmark");
    expect(markup).toContain("Viewed OsService — click to unmark");
    expect(markup).toContain("Viewed run — click to unmark");
    expect(markup).toContain("top:-10px;right:-10px");
    expect(markup.match(/class="review-node-viewed-outline"/g)?.length).toBe(3);
    expect(markup).toContain("background-color:#A78BFA1A");
  });

  it("exposes an unviewed preview as a quiet but keyboard-discoverable control", () => {
    const store = reviewStore({ fingerprint: undefined, folderMembers: [FILE_ID] });
    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewPreviewViewedControl nodeId={UNIT_ID} />
      </StoreProvider>,
    );

    expect(markup).toContain('data-review-view-state="todo"');
    expect(markup).toContain('aria-label="Mark run as viewed"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('class="review-node-viewed-outline"');
    expect(REVIEW_NODE_VIEWED_CSS).toContain(".review-node-diff-preview:hover");
    expect(REVIEW_NODE_VIEWED_CSS).toContain(".review-node-diff-preview:focus-within");
  });
});

describe("ReviewFileViewedControl", () => {
  it("resolves the dock action by path to the atomic file state", () => {
    const store = reviewStore({ fingerprint: "file-fingerprint", folderMembers: [FILE_ID] });
    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewFileViewedControl path="src/ServiceContainerFactory.ts" />
      </StoreProvider>,
    );

    expect(markup).toContain('data-review-source-viewed="true"');
    expect(markup).toContain('data-review-viewed-scope="file"');
    expect(markup).toContain('data-review-view-state="done"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Viewed src/ServiceContainerFactory.ts — click to unmark"');
    expect(markup).toContain("Viewed</span>");
  });

  it("keeps file semantics when only one declaration in the file is viewed", () => {
    const store = reviewStore({ fingerprint: undefined, folderMembers: [FILE_ID] });
    store.getState().toggleReviewUnitTick(UNIT_ID);
    const snapshot = store.getState();
    Object.assign(store, { getInitialState: () => snapshot });
    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewFileViewedControl path="src/ServiceContainerFactory.ts" />
      </StoreProvider>,
    );

    expect(markup).toContain('data-review-view-state="todo"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="Mark src/ServiceContainerFactory.ts as viewed"');
    expect(markup).toContain("Mark viewed</span>");
  });

  it("self-hides when the source path is not part of the active review", () => {
    const store = reviewStore({ fingerprint: undefined, folderMembers: [FILE_ID] });
    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewFileViewedControl path="src/not-in-review.ts" />
      </StoreProvider>,
    );

    expect(markup).toBe("");
  });

  it("uses the shared GitHub viewed-state blocker", () => {
    const store = reviewStore({ fingerprint: undefined, folderMembers: [FILE_ID] });
    store.setState({
      prReviewed: 7,
      reviewViewedFilesSyncEnabled: true,
      reviewViewedFilesLoading: true,
    });
    const snapshot = store.getState();
    Object.assign(store, { getInitialState: () => snapshot });
    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReviewFileViewedControl path="src/ServiceContainerFactory.ts" />
      </StoreProvider>,
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain("Wait for GitHub viewed-file status to finish loading");
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
  return renderReviewNodesWithStore(store, enabled);
}

function renderReviewNodesWithStore(store: ReturnType<typeof reviewStore>, enabled = true): string {
  const snapshot = store.getState();
  Object.assign(store, { getInitialState: () => snapshot });
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
        <ReviewNodeViewedChrome nodeId={CLASS_ID} scope="unit" borderRadius={8}>
          <div>class</div>
        </ReviewNodeViewedChrome>
        <ReviewNodeViewedChrome nodeId={UNIT_ID} scope="unit" borderRadius={6}>
          <div>unit</div>
        </ReviewNodeViewedChrome>
        <ReviewNodeViewedChrome nodeId={SECOND_UNIT_ID} scope="unit" borderRadius={6}>
          <div>second unit</div>
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
      path: "src/ServiceContainerFactory.ts",
      status: "modified",
      moduleId: FILE_ID,
      isTest: false,
      units: [
        {
          nodeId: UNIT_ID,
          displayName: "run",
          kind: "function",
          startLine: 4,
          endLine: 12,
          depth: 0,
          isTest: false,
          fingerprint: "unit-fingerprint",
        },
        {
          nodeId: SECOND_UNIT_ID,
          displayName: "getTempPath",
          kind: "function",
          startLine: 14,
          endLine: 18,
          depth: 0,
          isTest: false,
          fingerprint: "second-unit-fingerprint",
        },
      ],
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
    reviewUnitTicks: fingerprint === undefined
      ? {}
      : {
          [UNIT_ID]: {
            at: "now",
            fingerprint: fingerprint === "file-fingerprint" ? "unit-fingerprint" : fingerprint,
          },
          [SECOND_UNIT_ID]: {
            at: "now",
            fingerprint: fingerprint === "file-fingerprint" ? "second-unit-fingerprint" : fingerprint,
          },
        },
    reviewFileTicks: {},
    minimalRollups: folderMembers.length === 0 ? {} : { [FOLDER_ID]: folderMembers },
  });
  const snapshot = store.getState();
  Object.assign(store, { getInitialState: () => snapshot });
  return store;
}
