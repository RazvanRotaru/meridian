import { describe, expect, it } from "vitest";
import {
  MAP_LOD_CSS,
  semanticLayerVisibilityCss,
  syncMapLodDataset,
} from "./MapLod";

describe("MapLod", () => {
  it("removes the name-only orientation tier and preserves full card content", () => {
    expect(MAP_LOD_CSS).toContain(".lod-place");
    expect(MAP_LOD_CSS).toContain("display: none !important;");
    expect(MAP_LOD_CSS).not.toContain("data-map-tier");
    expect(MAP_LOD_CSS).not.toContain('data-map-label-mode="places"');
    expect(MAP_LOD_CSS).not.toContain(".lod-card-body");
    expect(MAP_LOD_CSS).not.toContain(".lod-rail");
  });

  it("uses every preview window to reveal a parent frame while hiding only layer text", () => {
    expect(MAP_LOD_CSS).toContain(
      '.react-flow.semantic-composite[data-map-semantic-stage="preview"] .map-parent-node',
    );
    expect(MAP_LOD_CSS).toContain(
      '.react-flow.semantic-composite[data-map-semantic-stage="preview"] .semantic-layer span',
    );
    expect(MAP_LOD_CSS).toContain(
      '.react-flow.semantic-composite[data-map-semantic-stage="preview"] .semantic-layer button',
    );
  });

  it("atomically switches one shared node-and-edge population for every mounted depth", () => {
    const css = semanticLayerVisibilityCss([3, 1, 1, -1, 0]);

    expect(css).toContain('[data-map-semantic-depth="0"] .semantic-layer-0');
    expect(css).toContain('[data-map-semantic-depth="1"] .semantic-layer-1');
    expect(css).toContain('[data-map-semantic-depth="3"] .semantic-layer-3');
    expect(css.match(/semantic-layer-1/g)).toHaveLength(1);
    expect(css).not.toContain("semantic-layer--1");
    expect(MAP_LOD_CSS).toContain("visibility: hidden !important;");
    expect(MAP_LOD_CSS).toContain("pointer-events: none !important;");
    expect(css).toContain("visibility: visible !important;");
    expect(css).toContain("pointer-events: auto !important;");
    expect(MAP_LOD_CSS).not.toContain("filter: opacity");
    expect(MAP_LOD_CSS).not.toContain("will-change: filter");
    expect(css).not.toContain("filter: opacity");
    expect(css).not.toContain("transition:");
    expect(MAP_LOD_CSS).not.toContain("semantic-detail");
    expect(MAP_LOD_CSS).not.toContain("semantic-context");
  });

  it("writes semantic dataset values only when their scalar state changes", () => {
    const writes: string[] = [];
    const deletes: string[] = [];
    const dataset = new Proxy<Record<string, string>>(
      {
        mapLabelMode: "places",
        mapSemanticDepth: "0",
        mapSemanticStage: "reading",
        mapTier: "nodes",
      },
      {
        deleteProperty(target, key) {
          deletes.push(String(key));
          return Reflect.deleteProperty(target, key);
        },
        set(target, key, value) {
          writes.push(`${String(key)}=${String(value)}`);
          return Reflect.set(target, key, value);
        },
      },
    ) as DOMStringMap;

    syncMapLodDataset(dataset, 0, "reading", undefined);
    expect(writes).toEqual([]);
    expect(deletes).toEqual(["mapTier", "mapLabelMode"]);

    syncMapLodDataset(dataset, 0, "reading", undefined);
    expect(writes).toEqual([]);
    expect(deletes).toEqual(["mapTier", "mapLabelMode"]);

    syncMapLodDataset(dataset, 0, "preview", 1);
    expect(writes).toEqual(["mapSemanticStage=preview", "mapPreviewDepth=1"]);

    syncMapLodDataset(dataset, 0, "preview", 1);
    expect(writes).toEqual(["mapSemanticStage=preview", "mapPreviewDepth=1"]);

    syncMapLodDataset(dataset, undefined, undefined, undefined);
    expect(deletes).toEqual([
      "mapTier",
      "mapLabelMode",
      "mapSemanticDepth",
      "mapSemanticStage",
      "mapPreviewDepth",
    ]);

    syncMapLodDataset(dataset, undefined, undefined, undefined);
    expect(deletes).toHaveLength(5);
  });
});
