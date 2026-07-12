import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  GhostPromoteRing,
  ghostPromotionTarget,
  promotableGhostNodes,
  visiblePromotableGhostNodes,
} from "./GhostPromoteRing";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
});

describe("ghost promotion", () => {
  it("does not subscribe to React Flow when the scene has no promotion affordances", () => {
    const markup = renderToStaticMarkup(createElement(GhostPromoteRing, {
      nodes: [
        node("ts:app.ts", "file"),
        node("ghost-group:outgoing:ts:dep.ts#Worker", "ghost", {
          ghostGroupId: "ghost-group:outgoing:ts:dep.ts#Worker",
        }),
      ],
      title: "Pin to canvas",
      onPromote: () => undefined,
    }));

    expect(markup).toBe("");
  });

  it("keeps exact ghosts, real persistent parents and temporary inspection previews, but excludes ordinary nodes and synthetic groups", () => {
    const exact = node("ts:dep.ts#Worker.run", "ghost", { label: "Worker.run" });
    const parent = node("ts:dep.ts#Worker", "ghost", {
      label: "Worker",
      ghostGroupId: "ts:dep.ts#Worker",
      ghostRole: "parent-anchor",
      ghostPromotable: true,
    });
    const synthetic = node("ghost-group:outgoing:ts:dep.ts#Worker", "ghost", {
      label: "Worker",
      ghostGroupId: "ghost-group:outgoing:ts:dep.ts#Worker",
    });
    const core = node("ts:app.ts", "file");
    const preview = node("ts:dep.ts#Worker.prepare", "block", { ghostInspectionPreview: true });
    const truthyButNotPreview = node("ts:dep.ts#Worker.finish", "block", { ghostInspectionPreview: "true" });

    expect(promotableGhostNodes([core, synthetic, preview, truthyButNotPreview, parent, exact]))
      .toEqual([preview, parent, exact]);
    expect(ghostPromotionTarget(preview)).toBe(preview.id);
    expect(ghostPromotionTarget(core)).toBeNull();
    expect(ghostPromotionTarget(truthyButNotPreview)).toBeNull();
    expect(ghostPromotionTarget(parent)).toBe("ts:dep.ts#Worker");
    expect(ghostPromotionTarget(exact)).toBe(exact.id);
    expect(ghostPromotionTarget(synthetic)).toBeNull();
  });
});

describe("visiblePromotableGhostNodes", () => {
  it("keeps only exact ghosts intersecting the current viewport", () => {
    const nodes: Node[] = [
      { id: "visible", type: "ghost", position: { x: 20, y: 30 }, style: { width: 100, height: 50 }, data: {} },
      { id: "edge", type: "ghost", position: { x: 315, y: 170 }, style: { width: 100, height: 50 }, data: {} },
      { id: "far", type: "ghost", position: { x: 600, y: 400 }, style: { width: 100, height: 50 }, data: {} },
      { id: "group", type: "ghost", position: { x: 40, y: 40 }, style: { width: 100, height: 50 }, data: { ghostGroupId: "ghost-group:incoming:file" } },
      { id: "preview", type: "block", position: { x: 60, y: 60 }, style: { width: 100, height: 50 }, data: { ghostInspectionPreview: true } },
      { id: "ordinary", type: "block", position: { x: 80, y: 80 }, style: { width: 100, height: 50 }, data: {} },
    ];

    expect(visiblePromotableGhostNodes(nodes, { x: 0, y: 0, zoom: 1 }, 320, 180).map((node) => node.id))
      .toEqual(["visible", "edge", "preview"]);
  });

  it("tests nested inspection previews at their absolute canvas position", () => {
    const parent: Node = {
      id: "file",
      type: "file",
      position: { x: 500, y: 300 },
      style: { width: 300, height: 200 },
      data: {},
    };
    const preview: Node = {
      id: "preview",
      type: "block",
      parentId: parent.id,
      position: { x: 20, y: 30 },
      style: { width: 100, height: 50 },
      data: { ghostInspectionPreview: true },
    };

    expect(visiblePromotableGhostNodes([parent, preview], { x: 0, y: 0, zoom: 1 }, 320, 180))
      .toEqual([]);
    expect(visiblePromotableGhostNodes([parent, preview], { x: -400, y: -230, zoom: 1 }, 320, 180))
      .toEqual([preview]);
  });

  it("accounts for pan and zoom and emits nothing before the canvas is measured", () => {
    const node: Node = { id: "ghost", type: "ghost", position: { x: 200, y: 100 }, style: { width: 80, height: 40 }, data: {} };

    expect(visiblePromotableGhostNodes([node], { x: -350, y: -150, zoom: 2 }, 300, 200)).toEqual([node]);
    expect(visiblePromotableGhostNodes([node], { x: 0, y: 0, zoom: 1 }, 0, 200)).toEqual([]);
  });
});
