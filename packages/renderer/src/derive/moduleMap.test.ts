/**
 * The Module-map spec: the reachable file set, frame grouping by directory, a frame's ring as its
 * shallowest member, the cross-frame import flag, and the entry stamping. Fixtures are hand-built
 * package/module graphs so each rule is pinned independent of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { deriveModuleMap, type ModuleMapSpec } from "./moduleMap";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

/** A `package` node carrying the extractor's `npm-package` tag — an owning npm-package root. */
function npmPkg(id: string, displayName: string, parentId?: string): GraphNode {
  return { ...node(id, "package", parentId, displayName), tags: ["npm-package"] } as GraphNode;
}

// pkgA{src/main.ts} imports pkgB{src/util.ts} — two npm packages, each with a nested `src/` dir.
function multiPackageFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    npmPkg("ts:pkgA", "pkgA"),
    node("ts:pkgA/src", "package", "ts:pkgA", "src"),
    node("ts:pkgA/src/main.ts", "module", "ts:pkgA/src", "main.ts"),
    npmPkg("ts:pkgB", "pkgB"),
    node("ts:pkgB/src", "package", "ts:pkgB", "src"),
    node("ts:pkgB/src/util.ts", "module", "ts:pkgB/src", "util.ts"),
  ];
  return { nodes, edges: [importEdge("ts:pkgA/src/main.ts", "ts:pkgB/src/util.ts")] };
}

function indexOf(nodes: GraphNode[], edges: GraphEdge[]) {
  return buildGraphIndex({ nodes, edges } as GraphArtifact);
}

// pkg:app{ main, handler } and pkg:util{ format }; main→handler→format so format sits two hops out.
const ROOT = "ts:app/main.ts";
function packagedFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    node("pkg:app", "package", undefined, "app"),
    node("ts:app/main.ts", "module", "pkg:app", "main.ts"),
    node("ts:app/handler.ts", "module", "pkg:app", "handler.ts"),
    node("pkg:util", "package", undefined, "util"),
    node("ts:util/format.ts", "module", "pkg:util", "format.ts"),
  ];
  const edges = [importEdge("ts:app/main.ts", "ts:app/handler.ts"), importEdge("ts:app/handler.ts", "ts:util/format.ts")];
  return { nodes, edges };
}

function cardFor(spec: ModuleMapSpec, id: string) {
  return spec.files.find((file) => file.id === id)?.data;
}

function edgeFor(spec: ModuleMapSpec, source: string, target: string) {
  return spec.edges.find((edge) => edge.source === source && edge.target === target);
}

describe("deriveModuleMap", () => {
  it("includes exactly the files reachable from the root", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: ROOT, maxDepth: null });
    expect(spec.files.map((file) => file.id)).toEqual(["ts:app/handler.ts", "ts:app/main.ts", "ts:util/format.ts"]);
    expect(spec.maxObservedDepth).toBe(2);
  });

  it("stamps the root as the entry card and categorises the rest by path", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: ROOT, maxDepth: null });
    expect(cardFor(spec, ROOT)).toMatchObject({ isEntry: true, category: "entry", depth: 0 });
    expect(cardFor(spec, "ts:util/format.ts")).toMatchObject({ isEntry: false, category: "util", depth: 2 });
    expect(cardFor(spec, "ts:app/handler.ts")?.inCount).toBe(1);
    expect(cardFor(spec, ROOT)?.outCount).toBe(1);
  });

  it("groups files into directory frames whose ring is the shallowest member", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: ROOT, maxDepth: null });
    const rings = new Map(spec.frames.map((frame) => [frame.id, frame.ring]));
    expect(rings.get("pkg:app")).toBe(0);
    expect(rings.get("pkg:util")).toBe(2);
    expect(spec.frames.find((frame) => frame.id === "pkg:app")?.data.fileCount).toBe(2);
  });

  it("flags an import that crosses a frame boundary", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: ROOT, maxDepth: null });
    expect(edgeFor(spec, ROOT, "ts:app/handler.ts")?.crossFrame).toBe(false);
    expect(edgeFor(spec, "ts:app/handler.ts", "ts:util/format.ts")?.crossFrame).toBe(true);
  });

  it("honours the maxDepth cap, dropping files beyond the radius", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: ROOT, maxDepth: 1 });
    expect(spec.files.map((file) => file.id)).toEqual(["ts:app/handler.ts", "ts:app/main.ts"]);
    expect(spec.frames.some((frame) => frame.id === "pkg:util")).toBe(false);
  });

  it("self-heals a stale root via the entry-name fallback", () => {
    const { nodes, edges } = packagedFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: "ts:gone", maxDepth: null });
    expect(spec.rootId).toBe(ROOT);
  });

  it("returns an empty spec when no root can be resolved", () => {
    const spec = deriveModuleMap(indexOf([node("ts:x", "class")], []), { rootId: "ts:x", maxDepth: null });
    expect(spec).toEqual({ files: [], frames: [], edges: [], rootId: null, maxObservedDepth: 0 });
  });

  it("folds files by owning npm package when the graph spans multiple packages", () => {
    const { nodes, edges } = multiPackageFixture();
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: "ts:pkgA/src/main.ts", maxDepth: null });
    // Frames are the npm-package roots, not the deeper `src/` sub-directories.
    expect(spec.files.find((file) => file.id === "ts:pkgA/src/main.ts")?.frameId).toBe("ts:pkgA");
    expect(spec.files.find((file) => file.id === "ts:pkgB/src/util.ts")?.frameId).toBe("ts:pkgB");
    expect(spec.frames.map((frame) => frame.id)).toEqual(["ts:pkgA", "ts:pkgB"]);
    expect(spec.frames.find((frame) => frame.id === "ts:pkgA")?.data.label).toBe("pkgA");
    expect(edgeFor(spec, "ts:pkgA/src/main.ts", "ts:pkgB/src/util.ts")?.crossFrame).toBe(true);
  });

  it("keeps directory framing within a single npm package", () => {
    // main.ts -> helper.ts, both inside pkgA/src: one npm package, so frame by directory not package.
    const nodes = [
      npmPkg("ts:pkgA", "pkgA"),
      node("ts:pkgA/src", "package", "ts:pkgA", "src"),
      node("ts:pkgA/src/main.ts", "module", "ts:pkgA/src", "main.ts"),
      node("ts:pkgA/src/helper.ts", "module", "ts:pkgA/src", "helper.ts"),
    ];
    const edges = [importEdge("ts:pkgA/src/main.ts", "ts:pkgA/src/helper.ts")];
    const spec = deriveModuleMap(indexOf(nodes, edges), { rootId: "ts:pkgA/src/main.ts", maxDepth: null });
    expect(spec.files.find((file) => file.id === "ts:pkgA/src/main.ts")?.frameId).toBe("ts:pkgA/src");
    expect(spec.frames.map((frame) => frame.id)).toEqual(["ts:pkgA/src"]);
  });
});
