import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./types";
import { deriveGraphStructure, parseGraphModuleOverview } from "./graph-structure";

describe("deriveGraphStructure", () => {
  it("derives exact child-kind and recursive source-file counts", () => {
    const facts = deriveGraphStructure([
      node("src", "package", null),
      node("src/services", "package", "src"),
      node("src/app.ts", "module", "src"),
      node("src/services/orders.ts", "module", "src/services"),
      node("src/services/orders.ts#Orders", "class", "src/services/orders.ts"),
    ], []);

    expect(facts.hierarchyById.get("src")).toEqual({
      isTest: false,
      childKindCounts: { package: 1, module: 1 },
      descendantSourceFileCount: 2,
      ownedSourceFileCount: 2,
    });
    expect(facts.hierarchyById.get("src/services")).toEqual({
      isTest: false,
      childKindCounts: { module: 1 },
      descendantSourceFileCount: 1,
      ownedSourceFileCount: 0,
    });
    expect(facts.hierarchyById.get("src/services/orders.ts")).toEqual({
      isTest: false,
      childKindCounts: { class: 1 },
      descendantSourceFileCount: 0,
      ownedSourceFileCount: 0,
    });
    expect(facts.moduleOverviewRootIds).toEqual(["src"]);
    expect(facts.repositorySummary).toEqual({ overviewPackageCount: 1, sourceFileCount: 2, testSourceFileCount: 0 });
  });

  it("uses nearest npm boundaries without double-counting their structural ancestors", () => {
    const facts = deriveGraphStructure([
      node("workspace", "package", null),
      node("workspace/packages", "package", "workspace"),
      node("workspace/packages/a", "package", "workspace/packages", ["npm-package"]),
      node("workspace/packages/a/src", "package", "workspace/packages/a"),
      node("workspace/packages/a/src/a.ts", "module", "workspace/packages/a/src"),
      node("workspace/packages/b", "package", "workspace/packages", ["npm-package"]),
      node("workspace/packages/b/b.ts", "module", "workspace/packages/b"),
      node("tools", "package", null),
      node("tools/script.ts", "module", "tools"),
    ], []);

    expect(facts.moduleOverviewRootIds).toEqual([
      "tools",
      "workspace/packages/a",
      "workspace/packages/b",
    ]);
    expect(facts.repositorySummary).toEqual({ overviewPackageCount: 3, sourceFileCount: 3, testSourceFileCount: 0 });
  });

  it("makes nested npm roots self-contained and keeps test ownership exact", () => {
    const facts = deriveGraphStructure([
      node("workspace", "package", null),
      node("workspace/app", "package", "workspace", ["npm-package"]),
      node("workspace/app/src", "package", "workspace/app"),
      node("workspace/app/src/app.ts", "module", "workspace/app/src"),
      node("workspace/app/plugins/test-kit", "package", "workspace/app", ["npm-package"]),
      node("workspace/app/plugins/test-kit/src", "package", "workspace/app/plugins/test-kit"),
      node("workspace/app/plugins/test-kit/src/plugin.test.ts", "module", "workspace/app/plugins/test-kit/src"),
    ], []);

    expect(facts.moduleOverview.roots).toEqual([
      {
        id: "workspace/app",
        kind: "package",
        displayName: "workspace/app",
        qualifiedName: "workspace/app",
        sourceFileCount: 1,
        testSourceFileCount: 0,
        ca: 0,
        ce: 0,
        isTest: false,
      },
      {
        id: "workspace/app/plugins/test-kit",
        kind: "package",
        displayName: "workspace/app/plugins/test-kit",
        qualifiedName: "workspace/app/plugins/test-kit",
        sourceFileCount: 1,
        testSourceFileCount: 1,
        ca: 0,
        ce: 0,
        isTest: true,
      },
    ]);
    expect(facts.repositorySummary.testSourceFileCount).toBe(1);
    expect(facts.hierarchyById.get("workspace/app/plugins/test-kit/src")?.isTest).toBe(true);
    expect(facts.hierarchyById.get("workspace/app")?.isTest).toBe(false);
  });

  it("aggregates typed cross-root relationships with exact deterministic evidence", () => {
    const nodes = [
      node("pkg/a", "package", null, ["npm-package"]),
      node("pkg/a/a.ts", "module", "pkg/a"),
      node("pkg/a/a.ts#run", "function", "pkg/a/a.ts"),
      node("pkg/a/a.ts#local", "function", "pkg/a/a.ts"),
      node("pkg/b", "package", null, ["npm-package"]),
      node("pkg/b/b.ts", "module", "pkg/b"),
      node("pkg/b/b.ts#work", "function", "pkg/b/b.ts"),
    ];
    const edges: GraphEdge[] = [
      edge("z-call", "pkg/a/a.ts#run", "pkg/b/b.ts#work", "calls", 2),
      edge("a-call", "pkg/a/a.ts#run", "pkg/b/b.ts#work", "calls"),
      edge("import", "pkg/a/a.ts", "pkg/b/b.ts", "imports", 4),
      edge("reverse", "pkg/b/b.ts#work", "pkg/a/a.ts#run", "references"),
      edge("internal", "pkg/a/a.ts#run", "pkg/a/a.ts#local", "calls", 9),
      edge("external", "pkg/a/a.ts#run", "ext:library", "calls", 9),
    ];

    const overview = deriveGraphStructure(nodes, edges).moduleOverview;

    expect(overview.roots.map((root) => ({ id: root.id, ca: root.ca, ce: root.ce }))).toEqual([
      { id: "pkg/a", ca: 1, ce: 1 },
      { id: "pkg/b", ca: 1, ce: 1 },
    ]);
    expect(overview.edges).toEqual([
      {
        id: "overview:calls:pkg%2Fa->pkg%2Fb",
        source: "pkg/a",
        target: "pkg/b",
        kind: "calls",
        weight: 3,
        evidenceIds: ["a-call", "z-call"],
      },
      {
        id: "overview:imports:pkg%2Fa->pkg%2Fb",
        source: "pkg/a",
        target: "pkg/b",
        kind: "imports",
        weight: 4,
        evidenceIds: ["import"],
      },
      {
        id: "overview:references:pkg%2Fb->pkg%2Fa",
        source: "pkg/b",
        target: "pkg/a",
        kind: "references",
        weight: 1,
        evidenceIds: ["reverse"],
      },
    ]);
    expect(parseGraphModuleOverview(JSON.parse(JSON.stringify(overview)))).toEqual(overview);

    const nonCanonical = JSON.parse(JSON.stringify(overview));
    nonCanonical.edges[0].evidenceIds.reverse();
    expect(() => parseGraphModuleOverview(nonCanonical)).toThrow("graph module overview edge references must be canonical");

    const inconsistent = JSON.parse(JSON.stringify(overview));
    inconsistent.roots[0].ce = 2;
    expect(() => parseGraphModuleOverview(inconsistent)).toThrow("graph module overview root facts are inconsistent");
  });

  it("sums repeated edge records without duplicating their evidence identity", () => {
    const nodes = [
      node("pkg/a", "package", null, ["npm-package"]),
      node("pkg/a/a.ts", "module", "pkg/a"),
      node("pkg/b", "package", null, ["npm-package"]),
      node("pkg/b/b.ts", "module", "pkg/b"),
    ];
    const repeated = edge("imports@pkg/a/a.ts|pkg/b/b.ts", "pkg/a/a.ts", "pkg/b/b.ts", "imports");

    expect(deriveGraphStructure(nodes, [repeated, repeated]).moduleOverview.edges).toEqual([{
      id: "overview:imports:pkg%2Fa->pkg%2Fb",
      source: "pkg/a",
      target: "pkg/b",
      kind: "imports",
      weight: 2,
      evidenceIds: [repeated.id],
    }]);
  });

  it("uses a package-less file as its own overview root and terminates parent cycles", () => {
    const facts = deriveGraphStructure([
      node("loose.ts", "module", null),
      node("cycle-a", "package", "cycle-b"),
      node("cycle-b", "package", "cycle-a"),
      node("cycle-a/file.ts", "module", "cycle-a"),
    ], []);

    expect(facts.moduleOverviewRootIds).toEqual(["cycle-b", "loose.ts"]);
    expect(facts.hierarchyById.get("cycle-a")?.descendantSourceFileCount).toBe(1);
  });
});

function node(id: string, kind: string, parentId: string | null, tags?: string[]): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: id, startLine: 1 },
    ...(tags ? { tags } : {}),
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  weight?: number,
): GraphEdge {
  return { id, source, target, kind, resolution: "resolved", ...(weight === undefined ? {} : { weight }) };
}
