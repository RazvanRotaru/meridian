import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import { buildGraphIndex } from "../../graph/graphIndex";
import { ALPHA_RUN, WIDGET_FN, freshStore } from "../../parity/surfaceFixture";
import { StoreProvider } from "../../state/StoreContext";
import {
  IncomingCallLensScope,
  IncomingCallTargetPort,
  incomingCallSocketTransform,
  incomingCallSummary,
  shouldFocusIncomingCallDialog,
  type IncomingCallLensController,
} from "./IncomingCallLens";

const TARGET = node("target", "loadTools", "src/tools.ts");
const ALPHA = node("alpha", "alphaCaller", "src/alpha.ts");
const BETA = node("beta", "betaCaller", "src/beta.ts");
const OTHER = node("other", "other", "src/other.ts");

const CALL_WITH_SITES: GraphEdge = {
  id: "calls:alpha->target",
  source: ALPHA.id,
  target: TARGET.id,
  kind: "calls",
  weight: 2,
  callSites: [
    { file: "src/alpha.ts", line: 12 },
    { file: "src/alpha.ts", line: 24, col: 3, endLine: 24, endCol: 16 },
  ],
};

const WEIGHT_ONLY_CALL: GraphEdge = {
  id: "calls:beta->target",
  source: BETA.id,
  target: TARGET.id,
  kind: "calls",
  weight: 2,
};

function node(id: string, displayName: string, file: string): GraphNode {
  return {
    id,
    kind: "function",
    qualifiedName: displayName,
    displayName,
    location: { file, startLine: 1 },
  };
}

function indexFor(edges: GraphEdge[]) {
  const artifact: GraphArtifact = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-08-06T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [TARGET, ALPHA, BETA, OTHER],
    edges,
  };
  return buildGraphIndex(artifact);
}

describe("incomingCallSummary", () => {
  it("distinguishes callers, call occurrences, and attributed sites", () => {
    const summary = incomingCallSummary(indexFor([
      CALL_WITH_SITES,
      WEIGHT_ONLY_CALL,
      { id: "calls:target->other", source: TARGET.id, target: OTHER.id, kind: "calls" },
      { id: "references:other->target", source: OTHER.id, target: TARGET.id, kind: "references" },
    ]), TARGET.id);

    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({ callerCount: 2, callCount: 4, siteCount: 2 });
    expect(summary!.rows.map((row) => ({
      caller: row.callerId,
      calls: row.callCount,
      sites: row.siteCount,
      first: row.firstLocation,
    }))).toEqual([
      { caller: ALPHA.id, calls: 2, sites: 2, first: "alpha.ts:12" },
      { caller: BETA.id, calls: 2, sites: 0, first: "beta.ts:1" },
    ]);
    expect([...summary!.edgeIds]).toEqual([CALL_WITH_SITES.id, WEIGHT_ONLY_CALL.id]);
  });

  it("returns null when the target has no incoming call relationships", () => {
    expect(incomingCallSummary(indexFor([
      { id: "references:other->target", source: OTHER.id, target: TARGET.id, kind: "references" },
    ]), TARGET.id)).toBeNull();
  });

  it("keeps the line visible when a call-site basename is long", () => {
    const summary = incomingCallSummary(indexFor([{
      ...CALL_WITH_SITES,
      weight: 1,
      callSites: [{ file: "src/showcase/executionGraphGallery.ts", line: 71 }],
    }]), TARGET.id);

    expect(summary?.rows[0]?.firstLocation).toBe("…cutionGraphGallery.ts:71");
    expect(summary?.rows[0]?.firstLocationTitle).toBe("src/showcase/executionGraphGallery.ts:71");
  });
});

describe("IncomingCallTargetPort", () => {
  it("keeps the visual handle and adds a named 24px button when callers exist", () => {
    const markup = renderPort(ALPHA_RUN, "run", ALPHA_RUN);

    expect(markup).toContain("react-flow__handle-left");
    expect(markup).toContain('data-incoming-call-socket="true"');
    expect(markup).toContain('class="nodrag nopan incoming-call-socket"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Show 1 incoming call from 1 caller to run");
    expect(markup).toContain("width:24px");
    expect(markup).toContain("height:24px");
    expect(markup).toContain("scale(1)");
  });

  it("does not create a dead focus target for a callable with no incoming calls", () => {
    const markup = renderPort(WIDGET_FN, "Widget", null);

    expect(markup).toContain("react-flow__handle-left");
    expect(markup).not.toContain("data-incoming-call-socket");
  });

  it("inverse-scales the socket so its screen-space target does not shrink with the graph", () => {
    expect(incomingCallSocketTransform(0.01)).toBe("translateY(-50%) scale(100)");
    expect(incomingCallSocketTransform(0.5)).toBe("translateY(-50%) scale(2)");
    expect(incomingCallSocketTransform(2)).toBe("translateY(-50%) scale(0.5)");
    expect(incomingCallSocketTransform(4)).toBe("translateY(-50%) scale(0.25)");
    expect(incomingCallSocketTransform(0)).toBe("translateY(-50%) scale(1)");
  });

  it("moves focus into the dialog only for a new keyboard or assistive-tech activation", () => {
    expect(shouldFocusIncomingCallDialog(0, false)).toBe(true);
    expect(shouldFocusIncomingCallDialog(0, true)).toBe(false);
    expect(shouldFocusIncomingCallDialog(1, false)).toBe(false);
  });
});

function renderPort(nodeId: string, label: string, pinnedTargetId: string | null): string {
  const store = freshStore();
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  const controller: IncomingCallLensController = {
    enabled: true,
    activeTargetId: pinnedTargetId,
    pinnedTargetId,
    preview: vi.fn(),
    toggle: vi.fn(),
    close: vi.fn(),
    focusOrigin: vi.fn(),
  };
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <ReactFlowProvider>
        <IncomingCallLensScope value={controller}>
          <IncomingCallTargetPort
            nodeId={nodeId}
            nodeLabel={label}
            callable
            pinStyle={{ width: 6, height: 6 }}
          />
        </IncomingCallLensScope>
      </ReactFlowProvider>
    </StoreProvider>,
  );
}
