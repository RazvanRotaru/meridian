import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { moduleSurfaceSpec } from "./surfaceSpec";
import {
  artifactOwnerOfStep,
  ghostGroupInteractionOf,
  navigationForNode,
  selectionGestureFor,
  toggleExpandedGhostGroupIds,
} from "./useModuleNodeInteractions";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
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
});

describe("double-click navigation", () => {
  const map = moduleSurfaceSpec("modules")!;
  const service = moduleSurfaceSpec("call")!;
  const ui = moduleSurfaceSpec("ui")!;

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
