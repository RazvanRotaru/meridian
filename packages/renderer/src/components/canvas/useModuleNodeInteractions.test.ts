import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { moduleSurfaceSpec } from "./surfaceSpec";
import {
  artifactOwnerOfStep,
  ghostInspectionRequestFor,
  ghostInspectionSelectionsToDrop,
  ghostPaintSeedOverride,
  ghostGroupInteractionOf,
  isNodeHeaderSelectionTarget,
  navigationNodeForBaseNode,
  navigationForNode,
  retainsGhostPaintContext,
  selectionGestureFor,
  toggleExpandedGhostGroupIds,
} from "./useModuleNodeInteractions";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
});

const edge = (id: string, source: string, target: string, data: Record<string, unknown> = {}): Edge => ({
  id,
  source,
  target,
  data,
});

describe("ghost inspection request", () => {
  it("resolves an exact ghost's real anchor through the canonical ghost edge", () => {
    const anchor = node("ts:app.ts#placeOrder", "block");
    const ghost = node("ts:email.ts#EmailService.send", "ghost");

    expect(ghostInspectionRequestFor(
      ghost,
      [anchor, ghost],
      [edge("gdep:calls:placeOrder->send", anchor.id, ghost.id, { ghost: true })],
    )).toEqual({
      visitedIds: [ghost.id],
      anchorIds: [anchor.id],
    });
  });

  it("leaves grouped and folder ghosts to explicit child disclosure instead of materializing an unbounded family", () => {
    const anchorB = node("ts:app.ts#b", "block");
    const anchorA = node("ts:app.ts#a", "block");
    const exactA = node("ts:dep.ts#Worker.a", "ghost");
    const exactB = node("ts:dep.ts#Worker.b", "ghost");
    const unrelatedGhost = node("ts:dep.ts#Other.run", "ghost");
    const group = node("ts:dep.ts#Worker", "ghost", {
      groupedGhostIds: [exactA.id, exactB.id, exactA.id],
      // Presentation/highway-like aggregates can retain further real member ids. They are visited,
      // while raw-edge adjacency still resolves through the exact represented ghost endpoints.
      members: ["ts:dep.ts#Worker.helper"],
    });

    expect(ghostInspectionRequestFor(
      group,
      [anchorB, anchorA, exactA, exactB, unrelatedGhost],
      [
        edge("gdep:calls:a->worker-a", anchorA.id, exactA.id, { ghost: true }),
        edge("gdep:calls:worker-b->b", exactB.id, anchorB.id, { ghost: true }),
        edge("gdep:calls:worker-a->worker-b", exactA.id, exactB.id, { ghost: true }),
        edge("gdep:calls:worker-a->other", exactA.id, unrelatedGhost.id, { ghost: true }),
        edge("ordinary", exactA.id, "ts:app.ts#ignored", { ghost: false }),
      ],
    )).toBeNull();
    expect(ghostInspectionRequestFor(
      node("ts:dep", "ghost", { members: ["ts:dep/a.ts", "ts:dep/b.ts"] }),
      [anchorA],
      [],
    )).toBeNull();
  });

  it("falls back to captured paint provenance when no canonical ghost edge survives", () => {
    const anchorB = node("ts:app.ts#b", "block");
    const anchorA = node("ts:app.ts#a", "block");
    const filteredAnchorId = "ts:app.ts#filteredAnchor";
    const ghostSeed = node("ts:dep.ts#Other.run", "ghost");
    const ghost = node("ts:dep.ts#Worker.run", "ghost", {
      // A restored paint context may retain a real provenance id whose card is no longer present
      // in this filtered raw presentation; it remains a valid anchor for the next derive.
      ghostPaintSeedIds: [anchorB.id, filteredAnchorId, ghostSeed.id, anchorA.id, anchorB.id],
    });

    expect(ghostInspectionRequestFor(ghost, [anchorB, anchorA, ghostSeed], [])).toEqual({
      visitedIds: [ghost.id],
      anchorIds: [anchorA.id, anchorB.id, filteredAnchorId],
    });
  });

  it("does not start ghost inspection from a non-ghost card", () => {
    const preview = node("ts:dep.ts#Worker.run", "block", { ghostInspectionPreview: true });
    expect(ghostInspectionRequestFor(preview, [preview], [])).toBeNull();
  });

  it("drops only selected temporary previews when an outside modifier-click ends inspection", () => {
    const preview = node("preview", "block", { ghostInspectionPreview: true });
    const pinned = node("pinned", "block", { ghostInspectionPath: true });
    const ordinary = node("ordinary", "block");
    expect(ghostInspectionSelectionsToDrop(
      new Set([preview.id, pinned.id, ordinary.id]),
      [preview, pinned, ordinary],
    )).toEqual([preview.id]);
  });
});

describe("universal module-node selection", () => {
  const visibleKinds = [
    node("pkg", "package"),
    node("domain", "serviceDomain"),
    node("file", "file"),
    node("unit", "unit"),
    node("block", "block"),
    node("step:owner:0", "step"),
    node("ghost", "ghost"),
    node("ghost-parent", "ghost", { ghostGroupId: "ghost-parent", ghostExpanded: false }),
  ];

  it("plain-click replaces selection for real, synthetic, exact-ghost and grouped-ghost cards", () => {
    for (const candidate of visibleKinds) {
      expect(selectionGestureFor(candidate, { ctrlKey: false, metaKey: false }), candidate.type).toBe("replace");
    }
  });

  it("ctrl/cmd-click toggles selection for every card kind", () => {
    for (const candidate of visibleKinds) {
      expect(selectionGestureFor(candidate, { ctrlKey: true, metaKey: false }), candidate.type).toBe("toggle");
      expect(selectionGestureFor(candidate, { ctrlKey: false, metaKey: true }), candidate.type).toBe("toggle");
    }
  });

  it("accepts selection only from the node header, not the expanded container body", () => {
    const target = (header: boolean): EventTarget => ({
      closest: (selector: string) => header && selector === '[data-base-node-header="true"]'
        ? ({} as Element)
        : null,
    }) as unknown as EventTarget;

    expect(isNodeHeaderSelectionTarget(target(true))).toBe(true);
    expect(isNodeHeaderSelectionTarget(target(false))).toBe(false);
    expect(isNodeHeaderSelectionTarget({} as EventTarget)).toBe(false);
    expect(isNodeHeaderSelectionTarget(null)).toBe(false);
  });

  it("keeps each ghost's paint provenance through its debounce and multi-selection membership", () => {
    expect(retainsGhostPaintContext("ghost", new Set(["real"]), "ghost")).toBe(true);
    expect(retainsGhostPaintContext("ghost", new Set(["ghost"]), null)).toBe(true);
    expect(retainsGhostPaintContext("ghost", new Set(["ghost"]), "real")).toBe(true);
    expect(retainsGhostPaintContext("ghost", new Set(["real"]), null)).toBe(false);
    expect(retainsGhostPaintContext("ghost", new Set(["ghost", "real"]), null)).toBe(true);
    expect(retainsGhostPaintContext("ghost", new Set(), null)).toBe(false);
  });

  it("unions provenance per Ctrl-selected ghost without dropping ordinary selected seeds", () => {
    const contexts = new Map([
      ["ghost-a", { targetId: "ghost-a", seedIds: new Set(["owner-a"]), viewMode: "modules", effectiveFocus: null }],
      ["ghost-b", { targetId: "ghost-b", seedIds: new Set(["owner-b"]), viewMode: "modules", effectiveFocus: null }],
    ]);

    expect(ghostPaintSeedOverride(contexts, new Set(["ghost-a", "ghost-b"]), null))
      .toEqual(new Set(["owner-a", "owner-b"]));
    expect(ghostPaintSeedOverride(contexts, new Set(["ghost-a", "real"]), null))
      .toEqual(new Set(["owner-a", "real"]));
    // A pending plain click replaces the old selection, so only its own provenance paints.
    expect(ghostPaintSeedOverride(contexts, new Set(["ghost-a"]), "ghost-b"))
      .toEqual(new Set(["owner-b"]));
    // A pending real-node click has no provenance of its own. Keep the current ghost's paint owner
    // until the delayed real selection commits so an intervening repaint cannot move the target.
    expect(ghostPaintSeedOverride(contexts, new Set(["ghost-a"]), "real"))
      .toEqual(new Set(["owner-a"]));
    expect(ghostPaintSeedOverride(contexts, new Set(["real"]), null)).toBeNull();
  });
});

describe("double-click navigation", () => {
  const map = moduleSurfaceSpec("modules")!;
  const service = moduleSurfaceSpec("call")!;
  const ui = moduleSurfaceSpec("ui")!;

  it("uses the artifact target for decorated occurrences and the occurrence for view-only steps", () => {
    const base = {
      nodeType: "block",
      kind: "function",
      label: "run",
      childCount: 1,
      canExpand: true,
      expanded: false,
      canNavigate: true,
      data: { callable: true },
    };

    expect(navigationNodeForBaseNode({
      ...base,
      instanceId: "flow::call/2",
      targetId: "ts:app.ts#run",
    })).toMatchObject({ id: "ts:app.ts#run", type: "block" });
    expect(navigationNodeForBaseNode({
      ...base,
      instanceId: "step:ts:app.ts#run:2",
      targetId: null,
      nodeType: "step",
    })).toMatchObject({ id: "step:ts:app.ts#run:2", type: "step" });
  });

  it("dives only through each surface's declared navigable containers", () => {
    expect(navigationForNode(node("ts:src", "package"), map)).toEqual({ kind: "navigate-into", id: "ts:src" });
    expect(navigationForNode(node("ts:src/app.ts", "file"), map)).toEqual({ kind: "navigate-into", id: "ts:src/app.ts" });
    expect(navigationForNode(node("svc:ts:src/app.ts#AppService", "package"), service)).toEqual({
      kind: "navigate-into",
      id: "svc:ts:src/app.ts#AppService",
    });
    expect(navigationForNode(node("service-domain:backend", "serviceDomain"), service)).toEqual({
      kind: "navigate-into",
      id: "service-domain:backend",
    });
    expect(navigationForNode(node("ts:ui", "package"), ui)).toEqual({ kind: "navigate-into", id: "ts:ui" });
    expect(navigationForNode(node("ts:ui/App.tsx", "file"), ui)).toEqual({ kind: "navigate-into", id: "ts:ui/App.tsx" });
  });

  it("reveals both exact ghosts and grouped ghost parents through the active surface", () => {
    const exact = node("ts:auth.ts#signIn", "ghost");
    const parent = node("ts:auth.ts#AuthService", "ghost", {
      ghostGroupId: "ts:auth.ts#AuthService",
      ghostExpanded: false,
    });
    expect(navigationForNode(exact, map)).toEqual({ kind: "ghost-reveal", id: exact.id });
    expect(navigationForNode(parent, service)).toEqual({ kind: "ghost-reveal", id: parent.id });
  });

  it("opens callable blocks and in-place flow steps in Logic", () => {
    expect(navigationForNode(node("ts:app.ts#run", "block", { callable: true }), map)).toEqual({
      kind: "logic",
      id: "ts:app.ts#run",
    });
    expect(navigationForNode(node("step:ts:app.ts#run:2", "step"), map)).toEqual({
      kind: "logic",
      id: "ts:app.ts#run",
    });
    expect(navigationForNode(node("step:step:ts:app.ts#run:2:1", "step"), service)).toEqual({
      kind: "logic",
      id: "ts:app.ts#run",
    });
    expect(navigationForNode(node("step:ts:app.ts#run:3", "step", {
      stepKind: "call",
      targetId: "ts:orders.ts#OrderStore.visitOrder",
      resolution: "resolved",
    }), map)).toEqual({
      kind: "logic",
      id: "ts:orders.ts#OrderStore.visitOrder",
    });
  });

  it("routes every other real card to the current lens's reveal path, never select or expand", () => {
    const cases = [
      navigationForNode(node("ts:app.ts#AppService", "unit"), map),
      navigationForNode(node("ts:app.ts#Config", "block", { callable: false }), ui),
      navigationForNode(node("ts:app.ts", "file"), service),
      navigationForNode(node("ts:shared", "package"), service),
    ];
    expect(cases).toEqual([
      { kind: "reveal", id: "ts:app.ts#AppService" },
      { kind: "reveal", id: "ts:app.ts#Config" },
      { kind: "reveal", id: "ts:app.ts" },
      { kind: "reveal", id: "ts:shared" },
    ]);
    expect(cases.some(({ kind }) => (kind as string) === "select" || (kind as string) === "expand")).toBe(false);
  });
});

describe("explicit grouped-ghost disclosure", () => {
  it("recognizes a real parent anchor and its disclosure state", () => {
    const parent = node("ts:AuthSession", "ghost", {
      ghostGroupId: "ts:AuthSession",
      ghostExpanded: true,
    });

    expect(ghostGroupInteractionOf(parent)).toEqual({ id: "ts:AuthSession", expanded: true });
    expect(ghostGroupInteractionOf(node("ts:AuthSession.signIn", "ghost"))).toBeNull();
    expect(ghostGroupInteractionOf(node("ts:AuthSession", "unit", { ghostGroupId: "ts:AuthSession" }))).toBeNull();
  });

  it("opens and closes the same stable parent id", () => {
    const opened = toggleExpandedGhostGroupIds(new Set(), "ts:AuthSession");
    expect([...opened]).toEqual(["ts:AuthSession"]);
    expect([...toggleExpandedGhostGroupIds(opened, "ts:AuthSession")]).toEqual([]);
  });

  it("peels nested view-only step ids to their real callable owner", () => {
    expect(artifactOwnerOfStep("step:ts:app.ts#run:0")).toBe("ts:app.ts#run");
    expect(artifactOwnerOfStep("step:step:ts:app.ts#run:0:2")).toBe("ts:app.ts#run");
    expect(artifactOwnerOfStep("step:malformed")).toBeNull();
    expect(artifactOwnerOfStep("ts:app.ts#run")).toBeNull();
  });
});
