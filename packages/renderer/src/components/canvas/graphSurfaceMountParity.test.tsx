import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { StoreProvider } from "../../state/StoreContext";
import { freshStore } from "../../parity/surfaceFixture";
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
    ["MinimalGraphView", <MinimalGraphView />],
  ])("%s declares whether and how it participates in semantic navigation", (_name, mount) => {
    renderToStaticMarkup(
      <StoreProvider store={freshStore()}>
        <ReactFlowProvider>{mount}</ReactFlowProvider>
      </StoreProvider>,
    );

    expect(graphSurfaceMounts).toHaveLength(1);
    expectSemanticNavigationDeclaration(graphSurfaceMounts[0]);
  });

  it("keeps both the covered source and Minimal Graph on the same explicit semantic contract", () => {
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
    graphSurfaceMounts.forEach(expectSemanticNavigationDeclaration);
    const sourceTag = markup.match(/<div[^>]*data-graph-surface="source"[^>]*>/)?.[0];
    const minimalTag = markup.match(/<div[^>]*data-graph-surface="minimal"[^>]*>/)?.[0];
    expect(sourceTag).toContain("inert=\"\"");
    expect(sourceTag).toContain("aria-hidden=\"true\"");
    expect(minimalTag).not.toContain("inert");
    expect(minimalTag).not.toContain("aria-hidden");
  });
});

/** Every shared-canvas mount owes the complete declaration even while fitting temporarily disables
 * LOD/commit. Otherwise lifecycle state could make this test skip the very contract it protects. */
function expectSemanticNavigationDeclaration(props: Record<string, unknown>): void {
  // Every GraphSurface renders semantic artifact edges, so every mount must expose the same
  // click-to-source evidence contract (including the minimal/PR overlay).
  expect(props.wireHover, "wire source evidence was not enabled").toBe(true);
  expect(Object.hasOwn(props, "semanticCommitEnabled"), "semanticCommitEnabled was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticLayers"), "semanticLayers was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticDepths"), "semanticDepths was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticFirstPreviewMax"), "semanticFirstPreviewMax was omitted").toBe(true);
  expect(Object.hasOwn(props, "semanticLodEnabled"), "semanticLodEnabled was omitted").toBe(true);
  expect(typeof props.semanticCommitEnabled).toBe("boolean");
  expect(typeof props.semanticLodEnabled).toBe("boolean");
  expect(typeof props.semanticFirstPreviewMax).toBe("number");
  expect(typeof props.onSemanticCommit, "onSemanticCommit was omitted").toBe("function");
}
