import { renderToStaticMarkup } from "react-dom/server";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NearbyGraphLoadingIndicators } from "./NearbyGraphLoadingIndicators";

const flowState = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  width: 320,
  height: 180,
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ViewportPortal: ({ children }: { children: React.ReactNode }) => (
      <div data-viewport-portal="true">{children}</div>
    ),
    useViewport: () => flowState.viewport,
    useStore: (selector: (state: { width: number; height: number }) => unknown) => selector(flowState),
  };
});

describe("NearbyGraphLoadingIndicators", () => {
  beforeEach(() => {
    flowState.viewport = { x: 0, y: 0, zoom: 1 };
    flowState.width = 320;
    flowState.height = 180;
  });

  it("renders an accessible, non-blocking spinner on the visible pending node corner", () => {
    const visibleNodes = [
      node("pending", "file", { label: "PaymentService", semanticDepth: 2 }, { x: 20, y: 30 }),
      node("ready", "file", { label: "ReadyService" }),
    ];
    const markup = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={visibleNodes}
        pendingNodeIds={new Set(["pending", "not-visible"])}
      />,
    );

    expect(markup).toContain('class="nearby-graph-loading-node-marker semantic-layer semantic-layer-2"');
    // A 20px flow-space marker is centred on (x + width, y) = (120, 30).
    expect(markup).toContain("transform:translate(110px, 20px)");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("Loading nearby graph for PaymentService.");
    expect(markup).toContain('data-nearby-graph-loading-node-id="pending"');
    expect(markup).toContain('class="nearby-graph-loading-spinner"');
    expect(markup).toContain("border-top-color:#C9A24B");
    expect(markup).toContain("border-right-color:#C9A24B");
    expect(markup).toContain("width:20px;height:20px");
    expect(markup).toContain("border-radius:50%");
    expect(markup).toContain("pointer-events:none");
    expect(markup).toContain("pointer-events: none !important");
    expect(markup).toContain("nearby-graph-loading-spin 1200ms linear infinite");
    expect(markup).toContain("prefers-reduced-motion: reduce");
    expect(markup).not.toContain("Loading nearby graph…");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("not-visible");
    expect(markup).not.toContain("ReadyService");
  });

  it("uses the canonical ID as a label fallback and renders nothing without an intersection", () => {
    const visibleNodes = [node("canonical:id", "file", {})];
    const pending = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={visibleNodes}
        pendingNodeIds={new Set(["canonical:id"])}
      />,
    );
    expect(pending).toContain("Loading nearby graph for canonical:id.");

    const empty = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={visibleNodes}
        pendingNodeIds={new Set(["another:id"])}
      />,
    );
    expect(empty).toBe("");
  });

  it("moves the spinner from the initiating ghost to its admitted real representative", () => {
    const ghost = node("py:src/acme#bootstrap", "ghost", { label: "bootstrap" });
    const admitted = node("py:src/acme", "file", { label: "acme/__init__.py" });
    const resolve = (pendingId: string, visibleIds: ReadonlySet<string>) =>
      pendingId.includes("#") && visibleIds.has(admitted.id) ? admitted.id : null;

    const admissionPending = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={[ghost]}
        pendingNodeIds={new Set([ghost.id])}
        resolvePendingNodeId={resolve}
      />,
    );
    expect(admissionPending).toContain(`data-nearby-graph-loading-node-id="${ghost.id}"`);

    const hydrationPending = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={[ghost, admitted]}
        pendingNodeIds={new Set([ghost.id, "py:src/acme#secondary"])}
        resolvePendingNodeId={resolve}
      />,
    );
    expect(hydrationPending).toContain(`data-nearby-graph-loading-node-id="${admitted.id}"`);
    expect(hydrationPending).not.toContain(`data-nearby-graph-loading-node-id="${ghost.id}"`);
    expect(hydrationPending.match(/data-nearby-graph-loading-node-id=/g)).toHaveLength(1);
    expect(hydrationPending).toContain("Loading nearby graph for acme/__init__.py.");

    const complete = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={[admitted]}
        pendingNodeIds={new Set()}
        resolvePendingNodeId={resolve}
      />,
    );
    expect(complete).toBe("");
  });

  it("uses absolute nested geometry and measured width for the node-attached marker", () => {
    flowState.viewport = { x: -400, y: -230, zoom: 1 };
    const parent = node("file", "file", {}, { x: 500, y: 300 }, { width: 300, height: 200 });
    const child: Node = {
      id: "callable",
      type: "block",
      parentId: parent.id,
      position: { x: 20, y: 30 },
      measured: { width: 100, height: 50 },
      data: { label: "callable" },
    };

    const markup = renderToStaticMarkup(
      <NearbyGraphLoadingIndicators
        visibleNodes={[parent, child]}
        pendingNodeIds={new Set([child.id])}
      />,
    );

    // Absolute child corner is (620, 330); the 20px marker starts at (610, 320).
    expect(markup).toContain("transform:translate(610px, 320px)");
  });
});

function node(
  id: string,
  type: string,
  data: Record<string, unknown>,
  position = { x: 0, y: 0 },
  style: React.CSSProperties = { width: 100, height: 50 },
): Node {
  return { id, type, position, style, data };
}
