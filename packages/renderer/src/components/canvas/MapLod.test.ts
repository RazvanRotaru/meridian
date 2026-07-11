import { describe, expect, it } from "vitest";
import { MAP_LOD_CSS, semanticLayerVisibilityCss } from "./MapLod";

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

  it("generates one shared node-and-edge visibility rule for every mounted depth", () => {
    const css = semanticLayerVisibilityCss([3, 1, 1, -1, 0]);

    expect(css).toContain('[data-map-semantic-depth="0"] .semantic-layer-0');
    expect(css).toContain('[data-map-semantic-depth="1"] .semantic-layer-1');
    expect(css).toContain('[data-map-semantic-depth="3"] .semantic-layer-3');
    expect(css.match(/semantic-layer-1/g)).toHaveLength(1);
    expect(css).not.toContain("semantic-layer--1");
    expect(MAP_LOD_CSS).not.toContain("semantic-detail");
    expect(MAP_LOD_CSS).not.toContain("semantic-context");
  });
});
