import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactElement } from "react";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { StoreProvider } from "../../state/StoreContext";
import { A_FILE, ALPHA, ALPHA_RUN, freshStore } from "../../parity/surfaceFixture";
import { ModuleMapView } from "../ModuleMapView";
import { MinimalGraphView } from "../MinimalGraphView";

const graphSurfaceMounts = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// Observe each mount's public GraphSurface declaration, not GraphSurface's permissive defaults.
// This stays resilient to its React Flow implementation details and avoids parsing TSX source.
vi.mock("./GraphSurface", () => ({
  SURFACE_STYLE: {},
  GraphSurfaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  GraphSurface: (props: Record<string, unknown>) => {
    graphSurfaceMounts.push(props);
    return null;
  },
}));

describe("GraphSurface mount semantic-navigation parity", () => {
  beforeEach(() => {
    graphSurfaceMounts.length = 0;
  });

  it.each([
    ["ModuleMapView", <ModuleMapView />],
    ["MinimalGraphView", <MinimalGraphView onShowCodebase={() => undefined} />],
  ])("%s declares whether and how it participates in semantic navigation", (_name, mount) => {
    renderToStaticMarkup(
      <StoreProvider store={freshStore()}>
        <ReactFlowProvider>{mount}</ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(1);
    expectSemanticNavigationDeclaration(graphSurfaceMounts[0]);
  });

  it("keeps both the covered source and an ordinary Minimal Graph on the same explicit semantic contract", () => {
    const store = freshStore();
    store.setState({
      minimalSeedIds: ["ts:packages/app/src/a.ts"],
      minimalMemberIds: ["ts:packages/app/src/a.ts"],
      minimalLayoutStatus: "ready",
    });
    // Zustand's SSR snapshot is the store's creation state unless explicitly advanced. Make this
    // pre-render mutation the server snapshot so ModuleMapView sees the overlay as open.
    const openState = store.getState();
    Object.assign(store, { getInitialState: () => openState });

    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReactFlowProvider><ModuleMapView /></ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(2);
    // The retained source keeps the same graph contract but yields wire ownership while the
    // Minimal Graph is the active interaction surface, preventing a hidden evidence dock.
    expectSemanticNavigationDeclaration(graphSurfaceMounts[0], false, false);
    expectSemanticNavigationDeclaration(graphSurfaceMounts[1], true);
    const sourceTag = markup.match(/<div[^>]*data-graph-surface="source"[^>]*>/)?.[0];
    const minimalTag = markup.match(/<div[^>]*data-graph-surface="minimal"[^>]*>/)?.[0];
    expect(sourceTag).toContain("inert=\"\"");
    expect(sourceTag).toContain("aria-hidden=\"true\"");
    expect(minimalTag).not.toContain("inert");
    expect(minimalTag).not.toContain("aria-hidden");
  });

  it("keeps a restored Minimal Graph's ghost paint owned by live selection, not origin seeds", () => {
    const origin = "ts:packages/app/src/a.ts";
    const store = freshStore();
    store.setState({
      minimalSeedIds: [origin],
      minimalMemberIds: [origin],
      minimalLayoutStatus: "ready",
      moduleSelected: new Set(),
    });
    const restoredState = store.getState();
    Object.assign(store, { getInitialState: () => restoredState });

    renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReactFlowProvider><MinimalGraphView onShowCodebase={() => undefined} /></ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(1);
    const mount = graphSurfaceMounts[0];
    const interactions = mount.interactions as { paintSelectionOverride: unknown };
    expect(mount.paintSelectionOverride).toBeUndefined();
    expect(interactions.paintSelectionOverride).toBeNull();
  });

  it("wires progressive node loading to the Minimal Graph's painted-node extras", () => {
    const pendingIds = new Set([ALPHA_RUN]);
    const promotedMember = rfNode(A_FILE, "file");
    const store = freshStore();
    store.setState({
      minimalSeedIds: [A_FILE],
      minimalMemberIds: [A_FILE],
      minimalRfNodes: [promotedMember],
      minimalLayoutStatus: "ready",
      progressivePendingNodeIds: pendingIds,
    });
    const pendingState = store.getState();
    Object.assign(store, { getInitialState: () => pendingState });

    renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReactFlowProvider><MinimalGraphView onShowCodebase={() => undefined} /></ReactFlowProvider>
      </StoreProvider>,
    );

    const flowExtras = graphSurfaceMounts[0].flowExtras as (view: {
      nodes: Node[];
      beacons: ReadonlySet<string>;
    }) => React.ReactNode;
    const extras = flowExtras({ nodes: [promotedMember], beacons: new Set() });
    const children = Children.toArray(
      (extras as ReactElement<{ children: React.ReactNode }>).props.children,
    ).filter(isValidElement) as Array<ReactElement<Record<string, unknown>>>;

    expect(children).toHaveLength(2);
    expect(children[0].props.pendingIds).toBe(pendingIds);
    expect(children[1].props.pendingNodeIds).toBe(pendingIds);
    expect(children[1].props.visibleNodes).toEqual([promotedMember]);
    const resolvePendingNodeId = children[1].props.resolvePendingNodeId as (
      pendingId: string,
      visibleIds: ReadonlySet<string>,
    ) => string | null;
    expect(resolvePendingNodeId(ALPHA_RUN, new Set([A_FILE]))).toBe(A_FILE);
  });

  it("filters only non-diff, non-member ghosts before the PR graph reaches GraphSurface", () => {
    const unchangedReal = rfNode("ts:src/unchanged.ts", "file");
    const affectedGhost = rfNode(ALPHA_RUN, "ghost");
    // ALPHA is an ancestor of the affected method in the graph index, but is not itself affected.
    // The selective ghost filter must not inherit the broad reviewDiffOnly ancestor closure.
    const unchangedAncestorGhost = rfNode(ALPHA, "ghost");
    const memberGhost = rfNode("ts:src/member.ts#member", "ghost");
    const staleGhost = rfNode("ts:src/context.ts#stale", "ghost");
    const affectedWire = rfEdge(unchangedReal.id, affectedGhost.id);
    const ancestorWire = rfEdge(unchangedReal.id, unchangedAncestorGhost.id);
    const memberWire = rfEdge(unchangedReal.id, memberGhost.id);
    const staleWire = rfEdge(unchangedReal.id, staleGhost.id);
    const store = freshStore();
    store.setState({
      minimalSeedIds: [unchangedReal.id],
      minimalMemberIds: [unchangedReal.id, memberGhost.id],
      minimalRfNodes: [
        unchangedReal,
        affectedGhost,
        unchangedAncestorGhost,
        memberGhost,
        staleGhost,
      ],
      minimalRfEdges: [affectedWire, ancestorWire, memberWire, staleWire],
      minimalLayoutStatus: "ready",
      minimalShowNonDiffGhostNodes: false,
      reviewAffectedIds: new Set([affectedGhost.id]),
      review: {
        context: {
          changedFiles: [{ path: "src/changed.ts", status: "modified" }],
          baseRef: "main",
          baseSha: "base",
          headRef: "feature",
          reviewKey: "selective-review-ghosts",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    const filteredState = store.getState();
    Object.assign(store, { getInitialState: () => filteredState });

    renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReactFlowProvider><MinimalGraphView onShowCodebase={() => undefined} /></ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(1);
    const mount = graphSurfaceMounts[0];
    expect((mount.nodes as Node[]).map((node) => node.id)).toEqual([
      unchangedReal.id,
      affectedGhost.id,
      memberGhost.id,
    ]);
    expect((mount.edges as Edge[]).map((edge) => edge.id)).toEqual([
      affectedWire.id,
      memberWire.id,
    ]);
  });

  it("unmounts the covered source while a PR review owns the navigation boundary", () => {
    const store = freshStore();
    store.setState({
      minimalSeedIds: ["ts:packages/app/src/a.ts"],
      minimalMemberIds: ["ts:packages/app/src/a.ts"],
      minimalLayoutStatus: "ready",
      review: {
        context: {
          changedFiles: [{ path: "packages/app/src/a.ts", status: "modified" }],
          baseRef: "main",
          baseSha: "base",
          headRef: "feature",
          reviewKey: "large-pr-review",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    const reviewState = store.getState();
    Object.assign(store, { getInitialState: () => reviewState });

    const markup = renderToStaticMarkup(
      <StoreProvider store={store}>
        <ReactFlowProvider><ModuleMapView /></ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(1);
    expectSemanticNavigationDeclaration(graphSurfaceMounts[0], true);
    expect(markup).not.toContain('data-graph-surface="source"');
    expect(markup).toContain('data-graph-surface="minimal"');
  });
});

function rfNode(id: string, type: string): Node {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id },
  };
}

function rfEdge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { ghost: true },
  };
}

/** Every shared-canvas mount owes the complete declaration even while fitting temporarily disables
 * LOD/commit. Otherwise lifecycle state could make this test skip the very contract it protects. */
function expectSemanticNavigationDeclaration(
  props: Record<string, unknown>,
  wireHover = true,
  paletteFocusEnabled = true,
): void {
  // Every ACTIVE GraphSurface exposes click-to-source evidence (including the minimal/PR overlay).
  expect(props.wireHover, "wire source evidence ownership was incorrect").toBe(wireHover);
  expect(props.paletteFocusEnabled, "palette focus ownership was incorrect").toBe(paletteFocusEnabled);
  expect(Object.hasOwn(props, "semanticCommitEnabled"), "semanticCommitEnabled was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticLayers"), "semanticLayers was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticDepths"), "semanticDepths was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticLodEnabled"), "semanticLodEnabled was omitted").toBe(true);
  expect(typeof props.semanticCommitEnabled).toBe("boolean");
  expect(typeof props.semanticLodEnabled).toBe("boolean");
  expect(typeof props.onSemanticCommit, "onSemanticCommit was omitted").toBe("function");
}
