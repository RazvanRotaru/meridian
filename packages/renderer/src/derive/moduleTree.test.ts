/**
 * deriveModuleTree: the Module map's inline-expandable containment tree. focus=null is the npm-package
 * overview; expanding a group nests its children (parentId) in DFS preorder; a collapsed sibling stays
 * folded; imports lift to the visible frontier (internal imports self-loop away). Fixtures are
 * hand-built so each rule is pinned exactly (mirrors moduleLevel.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildBlockDeps } from "./blockDeps";
import type { BlockData, ModuleCardData, UnitCardData } from "./moduleLevel";
import { deriveModuleTree, type ModuleGroupData } from "./moduleTree";

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

function npmPkg(id: string, displayName: string, parentId?: string): GraphNode {
  return { ...node(id, "package", parentId, displayName), tags: ["npm-package"] } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// pkgA{src{index, util, cli{run}}} + pkgB{src{b}} + pkgC{src{c}}, cross-imported.
function fixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    npmPkg("ts:pkgA", "pkgA"),
    node("ts:pkgA/src", "package", "ts:pkgA", "src"),
    node("ts:pkgA/src/index.ts", "module", "ts:pkgA/src", "index.ts"),
    node("ts:pkgA/src/util.ts", "module", "ts:pkgA/src", "util.ts"),
    node("ts:pkgA/src/cli", "package", "ts:pkgA/src", "cli"),
    node("ts:pkgA/src/cli/run.ts", "module", "ts:pkgA/src/cli", "run.ts"),
    npmPkg("ts:pkgB", "pkgB"),
    node("ts:pkgB/src", "package", "ts:pkgB", "src"),
    node("ts:pkgB/src/b.ts", "module", "ts:pkgB/src", "b.ts"),
    npmPkg("ts:pkgC", "pkgC"),
    node("ts:pkgC/src", "package", "ts:pkgC", "src"),
    node("ts:pkgC/src/c.ts", "module", "ts:pkgC/src", "c.ts"),
  ];
  const edges = [
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/cli/run.ts"), // into the cli subdir (internal to pkgA)
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"), // sibling file (internal to pkgA)
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"), // cross-package
    importEdge("ts:pkgB/src/b.ts", "ts:pkgC/src/c.ts"),
  ];
  return { nodes, edges };
}

function treeOf(nodes: GraphNode[], edges: GraphEdge[], focus: string | null, expanded: string[], flows: LogicFlows = {}) {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveModuleTree(index, focus, new Set(expanded), buildModuleGraph(index), buildBlockDeps(index), flows);
}

describe("deriveModuleTree — overview (focus null)", () => {
  it("roots are the npm packages, top-level (no parent), collapsed", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, []);
    expect(tree.effectiveFocus).toBeNull();
    expect(tree.nodes.map((n) => n.id)).toEqual(["ts:pkgA", "ts:pkgB", "ts:pkgC"]);
    expect(tree.nodes.every((n) => n.parentId === null && n.kind === "package")).toBe(true);
    expect(tree.nodes.every((n) => n.isContainer && !n.isExpanded)).toBe(true);
  });

  it("group fileCount counts the whole subtree's source files", () => {
    const { nodes, edges } = fixture();
    const pkgA = treeOf(nodes, edges, null, []).nodes.find((n) => n.id === "ts:pkgA");
    expect((pkgA?.data as ModuleGroupData).fileCount).toBe(3); // index, util, run
  });

  it("collapsed packages couple as package→package wires; internal imports self-loop away", () => {
    const { nodes, edges } = fixture();
    const wires = treeOf(nodes, edges, null, []).edges.map((e) => `${e.source}->${e.target}:${e.crossFrame}`);
    expect(wires).toContain("ts:pkgA->ts:pkgB:true");
    expect(wires).toContain("ts:pkgB->ts:pkgC:true");
    // index→util and index→run are internal to pkgA, so they collapse to a dropped self-loop.
    expect(wires.some((w) => w.startsWith("ts:pkgA->ts:pkgA"))).toBe(false);
  });
});

describe("deriveModuleTree — inline expansion", () => {
  it("expanding a package nests its child under it, in preorder; siblings stay folded", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA"]);
    const ids = tree.nodes.map((n) => n.id);
    // pkgA appears before its child; pkgB/pkgC descendants are absent (collapsed).
    expect(ids).toEqual(["ts:pkgA", "ts:pkgA/src", "ts:pkgB", "ts:pkgC"]);
    const src = tree.nodes.find((n) => n.id === "ts:pkgA/src");
    expect(src?.parentId).toBe("ts:pkgA");
    expect(src?.isContainer).toBe(true);
    expect(src?.isExpanded).toBe(false);
    expect(tree.nodes.find((n) => n.id === "ts:pkgA")?.isExpanded).toBe(true);
  });

  it("expanding down to files nests file cards and lifts imports to the frontier", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA", "ts:pkgA/src"]);
    const files = tree.nodes.filter((n) => n.kind === "file").map((n) => n.id);
    expect(files).toEqual(["ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"]);
    const cli = tree.nodes.find((n) => n.id === "ts:pkgA/src/cli");
    expect(cli?.parentId).toBe("ts:pkgA/src");
    const wires = tree.edges.map((e) => `${e.source}->${e.target}:${e.crossFrame}`);
    // index→util is file↔file cohesion (not crossFrame); index→run lifts to the collapsed cli group.
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/util.ts:false");
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/cli:true");
    // the cross-package import lifts to the still-collapsed pkgB package node.
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgB:true");
  });
});

describe("deriveModuleTree — package focus", () => {
  it("chain-collapses a single-directory focus (pkgA → pkgA/src) as the frontier", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, "ts:pkgA", []);
    expect(tree.effectiveFocus).toBe("ts:pkgA/src");
    // Frontier children in source order (index, util, cli); all top-level (no drawn parent).
    expect(tree.nodes.map((n) => n.id)).toEqual(["ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts", "ts:pkgA/src/cli"]);
    expect(tree.nodes.every((n) => n.parentId === null)).toBe(true);
  });
});

function callEdge(source: string, target: string): GraphEdge {
  return { id: `calls:${source}->${target}`, source, target, kind: "calls", resolution: "resolved" } as GraphEdge;
}

// pkg{src{svc.ts{OrderService{place}}, pay.ts{PaymentGateway{charge}}}} — place() calls charge().
function unitFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    npmPkg("ts:pkg", "pkg"),
    node("ts:pkg/src", "package", "ts:pkg", "src"),
    node("ts:pkg/src/svc.ts", "module", "ts:pkg/src", "svc.ts"),
    node("ts:pkg/src/svc.ts#OrderService", "class", "ts:pkg/src/svc.ts", "OrderService"),
    node("ts:pkg/src/svc.ts#OrderService.place", "method", "ts:pkg/src/svc.ts#OrderService", "place"),
    node("ts:pkg/src/pay.ts", "module", "ts:pkg/src", "pay.ts"),
    node("ts:pkg/src/pay.ts#PaymentGateway", "class", "ts:pkg/src/pay.ts", "PaymentGateway"),
    node("ts:pkg/src/pay.ts#PaymentGateway.charge", "method", "ts:pkg/src/pay.ts#PaymentGateway", "charge"),
  ];
  const edges = [
    importEdge("ts:pkg/src/svc.ts", "ts:pkg/src/pay.ts"),
    callEdge("ts:pkg/src/svc.ts#OrderService.place", "ts:pkg/src/pay.ts#PaymentGateway.charge"),
  ];
  return { nodes, edges };
}

describe("deriveModuleTree — overview fallback (no npm-package tags)", () => {
  it("falls back to the topmost directory roots so a single-project artifact is never blank", () => {
    const nodes = [
      node("ts:src", "package", undefined, "src"),
      node("ts:src/a.ts", "module", "ts:src", "a.ts"),
      node("ts:src/b.ts", "module", "ts:src", "b.ts"),
    ];
    const edges = [importEdge("ts:src/a.ts", "ts:src/b.ts")];
    const tree = treeOf(nodes, edges, null, []);
    expect(tree.nodes.map((n) => n.id)).toEqual(["ts:src"]);
    expect(tree.nodes[0].kind).toBe("package");
  });
});

describe("deriveModuleTree — code level (the merged composition level)", () => {
  it("a file declaring code is a container; collapsed it draws no code nodes", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", []);
    const svc = tree.nodes.find((n) => n.id === "ts:pkg/src/svc.ts");
    expect(svc?.kind).toBe("file");
    expect(svc?.isContainer).toBe(true);
    expect((svc?.data as ModuleCardData).unitCount).toBe(1);
    expect(tree.nodes.some((n) => n.kind === "unit" || n.kind === "block")).toBe(false);
  });

  it("expanding a file opens each unit as a FRAME whose methods are nested block nodes", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    const unit = tree.nodes.find((n) => n.kind === "unit");
    expect(unit?.id).toBe("ts:pkg/src/svc.ts#OrderService");
    expect(unit?.parentId).toBe("ts:pkg/src/svc.ts");
    expect(unit?.isExpanded).toBe(true); // a unit with members is always an open frame
    expect((unit?.data as UnitCardData).isFrame).toBe(true);
    const method = tree.nodes.find((n) => n.kind === "block");
    expect(method?.id).toBe("ts:pkg/src/svc.ts#OrderService.place");
    expect(method?.parentId).toBe("ts:pkg/src/svc.ts#OrderService");
    const data = method?.data as BlockData;
    expect(data.label).toBe("place");
    expect(data.callable).toBe(true);
  });

  it("attaches the dep wire to the METHOD block that makes the call, lifted to the definition", () => {
    const { nodes, edges } = unitFixture();
    // pay.ts stays collapsed, so the definition wire lands on the pay.ts FILE card — but its
    // source is the place() block itself, not the class.
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    const deps = tree.edges.filter((e) => e.category === "dep");
    expect(deps).toHaveLength(1);
    expect(deps[0].source).toBe("ts:pkg/src/svc.ts#OrderService.place");
    expect(deps[0].target).toBe("ts:pkg/src/pay.ts");
  });

  it("with both files expanded the wire runs block to block (call site to definition's method)", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/pay.ts"]);
    const deps = tree.edges.filter((e) => e.category === "dep");
    expect(deps.map((e) => `${e.source}->${e.target}`)).toEqual([
      "ts:pkg/src/svc.ts#OrderService.place->ts:pkg/src/pay.ts#PaymentGateway.charge",
    ]);
  });

  it("renders a file-level function as a sibling block and anchors its deps to it", () => {
    const { nodes, edges } = unitFixture();
    const extra = [
      ...nodes,
      node("ts:pkg/src/svc.ts#helper", "function", "ts:pkg/src/svc.ts", "helper"),
    ];
    const extraEdges = [...edges, callEdge("ts:pkg/src/svc.ts#helper", "ts:pkg/src/pay.ts#PaymentGateway.charge")];
    const tree = treeOf(extra, extraEdges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    const helper = tree.nodes.find((n) => n.id === "ts:pkg/src/svc.ts#helper");
    expect(helper?.kind).toBe("block");
    expect(helper?.parentId).toBe("ts:pkg/src/svc.ts");
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toContain("ts:pkg/src/svc.ts#helper->ts:pkg/src/pay.ts");
  });

  it("renders a memberless unit as a leaf identity card, not a frame", () => {
    const { nodes, edges } = unitFixture();
    const extra = [...nodes, node("ts:pkg/src/svc.ts#ApiResponse", "interface", "ts:pkg/src/svc.ts", "ApiResponse")];
    const tree = treeOf(extra, edges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    const iface = tree.nodes.find((n) => n.id === "ts:pkg/src/svc.ts#ApiResponse");
    expect(iface?.kind).toBe("unit");
    expect(iface?.isExpanded).toBe(false);
    expect((iface?.data as UnitCardData).isFrame).toBe(false);
  });

  it("draws no dep wires while no code node is on screen (file↔file is the import graph's story)", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", []);
    expect(tree.edges.filter((e) => e.category === "dep")).toHaveLength(0);
    expect(tree.edges.filter((e) => e.category === "import")).toHaveLength(1);
  });
});

describe("deriveModuleTree — private members always derive (the Private toggle is paint-only)", () => {
  it("draws private members and gives them layout space regardless of any toggle", () => {
    const base = unitFixture();
    const nextId = { ...node("ts:pkg/src/svc.ts#OrderService.nextId", "method", "ts:pkg/src/svc.ts#OrderService", "nextId"), tags: ["private"] } as GraphNode;
    const tree = treeOf([...base.nodes, nextId], base.edges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    expect(tree.nodes.some((n) => n.id === "ts:pkg/src/svc.ts#OrderService.nextId")).toBe(true);
    expect(tree.nodes.find((n) => n.kind === "unit")?.childCount).toBe(2);
  });
});

describe("deriveModuleTree — constructions anchor at the constructor block", () => {
  function ctorFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const base = unitFixture();
    return {
      nodes: [...base.nodes, node("ts:pkg/src/pay.ts#PaymentGateway.constructor", "method", "ts:pkg/src/pay.ts#PaymentGateway", "constructor")],
      edges: [
        ...base.edges,
        { id: "inst:place->gw", source: "ts:pkg/src/svc.ts#OrderService.place", target: "ts:pkg/src/pay.ts#PaymentGateway", kind: "instantiates", resolution: "resolved" } as GraphEdge,
      ],
    };
  }

  it("an instantiates edge retargets to the class's drawn constructor block", () => {
    const { nodes, edges } = ctorFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/pay.ts"]);
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toContain("ts:pkg/src/svc.ts#OrderService.place->ts:pkg/src/pay.ts#PaymentGateway.constructor");
    // No parallel wire onto the class frame itself.
    expect(deps).not.toContain("ts:pkg/src/svc.ts#OrderService.place->ts:pkg/src/pay.ts#PaymentGateway");
  });

  it("a `new X()` flow step wires to the constructor block, not the class frame", () => {
    const { nodes, edges } = ctorFixture();
    const flows: LogicFlows = {
      "ts:pkg/src/svc.ts#OrderService.place": [
        { kind: "call", label: "PaymentGateway", target: "ts:pkg/src/pay.ts#PaymentGateway", resolution: "resolved" },
      ],
    };
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/pay.ts", "ts:pkg/src/svc.ts#OrderService.place"], flows);
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toContain("step:ts:pkg/src/svc.ts#OrderService.place:0->ts:pkg/src/pay.ts#PaymentGateway.constructor");
  });

  it("a `new X()` step expands into the CONSTRUCTOR's charted flow (targets resolve through the ctor)", () => {
    const { nodes, edges } = ctorFixture();
    const placeId = "ts:pkg/src/svc.ts#OrderService.place";
    const newStep = `step:${placeId}:0`;
    const flows: LogicFlows = {
      [placeId]: [{ kind: "call", label: "PaymentGateway", target: "ts:pkg/src/pay.ts#PaymentGateway", resolution: "resolved" }],
      "ts:pkg/src/pay.ts#PaymentGateway.constructor": [{ kind: "call", label: "init", target: null, resolution: "unresolved" }],
    };
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", placeId, newStep], flows);
    expect(tree.nodes.find((n) => n.id === newStep)?.isContainer).toBe(true);
    expect(tree.nodes.filter((n) => n.parentId === newStep).map((n) => n.id)).toEqual([`step:${newStep}:0`]);
  });

  it("with the target file collapsed the construction wire still folds to the file card", () => {
    const { nodes, edges } = ctorFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts"]);
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toEqual(["ts:pkg/src/svc.ts#OrderService.place->ts:pkg/src/pay.ts"]);
  });
});

describe("deriveModuleTree — ghost relationships (off-screen endpoints)", () => {
  // pkg{src{orders{svc.ts#OrderService.place}, billing{pay.ts#PaymentGateway.charge}}} — the call
  // CROSSES directories, so focusing one side leaves the other end off-screen.
  function ghostFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [
      npmPkg("ts:pkg", "pkg"),
      node("ts:pkg/src", "package", "ts:pkg", "src"),
      node("ts:pkg/src/orders", "package", "ts:pkg/src", "orders"),
      node("ts:pkg/src/orders/svc.ts", "module", "ts:pkg/src/orders", "svc.ts"),
      node("ts:pkg/src/orders/svc.ts#OrderService", "class", "ts:pkg/src/orders/svc.ts", "OrderService"),
      node("ts:pkg/src/orders/svc.ts#OrderService.place", "method", "ts:pkg/src/orders/svc.ts#OrderService", "place"),
      node("ts:pkg/src/billing", "package", "ts:pkg/src", "billing"),
      node("ts:pkg/src/billing/pay.ts", "module", "ts:pkg/src/billing", "pay.ts"),
      node("ts:pkg/src/billing/pay.ts#PaymentGateway", "class", "ts:pkg/src/billing/pay.ts", "PaymentGateway"),
      node("ts:pkg/src/billing/pay.ts#PaymentGateway.charge", "method", "ts:pkg/src/billing/pay.ts#PaymentGateway", "charge"),
    ];
    const edges = [
      importEdge("ts:pkg/src/orders/svc.ts", "ts:pkg/src/billing/pay.ts"),
      callEdge("ts:pkg/src/orders/svc.ts#OrderService.place", "ts:pkg/src/billing/pay.ts#PaymentGateway.charge"),
    ];
    return { nodes, edges };
  }

  it("an off-screen DEPENDENCY charts as a ghost card wired from the drawn call site", () => {
    const { nodes, edges } = ghostFixture();
    const tree = treeOf(nodes, edges, "ts:pkg/src/orders", ["ts:pkg/src/orders/svc.ts"]);
    const ghost = tree.nodes.find((n) => n.kind === "ghost");
    expect(ghost?.id).toBe("ts:pkg/src/billing/pay.ts#PaymentGateway.charge");
    expect(ghost?.parentId).toBeNull();
    const wires = tree.edges.filter((e) => e.ghost).map((e) => `${e.source}->${e.target}`);
    expect(wires).toEqual(["ts:pkg/src/orders/svc.ts#OrderService.place->ts:pkg/src/billing/pay.ts#PaymentGateway.charge"]);
    // The lifted dep projection itself drew nothing (the endpoint left the canvas) — only the ghost.
    expect(tree.edges.filter((e) => e.category === "dep" && !e.ghost)).toHaveLength(0);
  });

  it("an off-screen CALLER charts as a ghost wired INTO the drawn definition", () => {
    const { nodes, edges } = ghostFixture();
    const tree = treeOf(nodes, edges, "ts:pkg/src/billing", ["ts:pkg/src/billing/pay.ts"]);
    const ghost = tree.nodes.find((n) => n.kind === "ghost");
    expect(ghost?.id).toBe("ts:pkg/src/orders/svc.ts#OrderService.place");
    const wires = tree.edges.filter((e) => e.ghost).map((e) => `${e.source}->${e.target}`);
    expect(wires).toEqual(["ts:pkg/src/orders/svc.ts#OrderService.place->ts:pkg/src/billing/pay.ts#PaymentGateway.charge"]);
  });

  it("draws no ghost when both endpoints are on screen", () => {
    const { nodes, edges } = ghostFixture();
    const tree = treeOf(nodes, edges, "ts:pkg/src", ["ts:pkg/src/orders", "ts:pkg/src/billing", "ts:pkg/src/orders/svc.ts", "ts:pkg/src/billing/pay.ts"]);
    expect(tree.nodes.some((n) => n.kind === "ghost")).toBe(false);
  });

  it("an expanded block's off-screen call ghosts from its STEP, not doubled from the frame", () => {
    const { nodes, edges } = ghostFixture();
    const flows: LogicFlows = {
      "ts:pkg/src/orders/svc.ts#OrderService.place": [
        { kind: "call", label: "charge", target: "ts:pkg/src/billing/pay.ts#PaymentGateway.charge", resolution: "resolved" },
      ],
    };
    const tree = treeOf(nodes, edges, "ts:pkg/src/orders", ["ts:pkg/src/orders/svc.ts", "ts:pkg/src/orders/svc.ts#OrderService.place"], flows);
    const wires = tree.edges.filter((e) => e.ghost).map((e) => `${e.source}->${e.target}`);
    expect(wires).toEqual(["step:ts:pkg/src/orders/svc.ts#OrderService.place:0->ts:pkg/src/billing/pay.ts#PaymentGateway.charge"]);
  });

  it("never ghosts an endpoint the artifact does not know (ext:/unresolved: pseudo-ids)", () => {
    const { nodes, edges } = ghostFixture();
    const withExt = [...edges, callEdge("ts:pkg/src/orders/svc.ts#OrderService.place", "ext:stripe#charge")];
    const tree = treeOf(nodes, withExt, "ts:pkg/src/orders", ["ts:pkg/src/orders/svc.ts"]);
    expect(tree.nodes.filter((n) => n.kind === "ghost").map((n) => n.id)).toEqual(["ts:pkg/src/billing/pay.ts#PaymentGateway.charge"]);
  });
});

describe("deriveModuleTree — flow steps charted in place (POC)", () => {
  const FLOWS: LogicFlows = {
    "ts:pkg/src/svc.ts#OrderService.place": [
      { kind: "call", label: "validate", target: null, resolution: "unresolved" },
      { kind: "call", label: "charge", target: "ts:pkg/src/pay.ts#PaymentGateway.charge", resolution: "resolved" },
      { kind: "loop", label: "for (line of lines)", body: [] },
    ],
  };

  it("a callable block with a flow is expandable; expanding charts its steps inside the block frame", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/svc.ts#OrderService.place"], FLOWS);
    const block = tree.nodes.find((n) => n.id === "ts:pkg/src/svc.ts#OrderService.place");
    expect(block?.isContainer).toBe(true);
    expect(block?.isExpanded).toBe(true);
    const steps = tree.nodes.filter((n) => n.kind === "step");
    expect(steps.map((n) => n.parentId)).toEqual(Array(3).fill("ts:pkg/src/svc.ts#OrderService.place"));
    // Execution-order chain: step 0 → 1 → 2.
    const chain = tree.edges.filter((e) => e.category === "flow").map((e) => `${e.source}->${e.target}`);
    expect(chain).toEqual([
      "step:ts:pkg/src/svc.ts#OrderService.place:0->step:ts:pkg/src/svc.ts#OrderService.place:1",
      "step:ts:pkg/src/svc.ts#OrderService.place:1->step:ts:pkg/src/svc.ts#OrderService.place:2",
    ]);
  });

  it("a resolved call step wires OUT to its target's drawn definition, replacing the block-level wire", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/svc.ts#OrderService.place"], FLOWS);
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    // The step (not the expanded block) is the wire's anchor; the target folds to its file card.
    expect(deps).toEqual(["step:ts:pkg/src/svc.ts#OrderService.place:1->ts:pkg/src/pay.ts"]);
  });

  it("a resolved call step with a charted callee flow expands RECURSIVELY — the callee's steps chart inside it", () => {
    const { nodes, edges } = unitFixture();
    const placeId = "ts:pkg/src/svc.ts#OrderService.place";
    const chargeId = "ts:pkg/src/pay.ts#PaymentGateway.charge";
    const callStep = `step:${placeId}:0`;
    const flows: LogicFlows = {
      [placeId]: [{ kind: "call", label: "charge", target: chargeId, resolution: "resolved" }],
      [chargeId]: [
        { kind: "call", label: "audit", target: null, resolution: "unresolved" },
        { kind: "loop", label: "for (attempt of retries)", body: [{ kind: "call", label: "post", target: null, resolution: "unresolved" }] },
      ],
    };
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", placeId, callStep], flows);
    const step = tree.nodes.find((n) => n.id === callStep);
    expect(step?.isContainer).toBe(true);
    expect(step?.isExpanded).toBe(true);
    // The callee's steps nest INSIDE the call step, chained in execution order.
    expect(tree.nodes.filter((n) => n.parentId === callStep).map((n) => n.id)).toEqual([`step:${callStep}:0`, `step:${callStep}:1`]);
    const chain = tree.edges.filter((e) => e.category === "flow").map((e) => `${e.source}->${e.target}`);
    expect(chain).toContain(`step:${callStep}:0->step:${callStep}:1`);
    // The callee's own loop (a non-empty body) is a container the reader can open one level deeper.
    expect(tree.nodes.find((n) => n.id === `step:${callStep}:1`)?.isContainer).toBe(true);
    // The expanded call keeps its wire to the definition — the frame still says where the code lives.
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toContain(`${callStep}->ts:pkg/src/pay.ts`);
  });

  it("a construct step's body unrolls in place when its id joins the expansion set", () => {
    const { nodes, edges } = unitFixture();
    const placeId = "ts:pkg/src/svc.ts#OrderService.place";
    const loopStep = `step:${placeId}:0`;
    const flows: LogicFlows = {
      [placeId]: [{ kind: "loop", label: "for (line of lines)", body: [{ kind: "call", label: "priceLine", target: null, resolution: "unresolved" }] }],
    };
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", placeId, loopStep], flows);
    expect(tree.nodes.filter((n) => n.parentId === loopStep).map((n) => n.id)).toEqual([`step:${loopStep}:0`]);
  });

  it("a collapsed block keeps its own frame-level dep wire (no steps drawn)", () => {
    const { nodes, edges } = unitFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts"], FLOWS);
    expect(tree.nodes.some((n) => n.kind === "step")).toBe(false);
    const deps = tree.edges.filter((e) => e.category === "dep").map((e) => `${e.source}->${e.target}`);
    expect(deps).toEqual(["ts:pkg/src/svc.ts#OrderService.place->ts:pkg/src/pay.ts"]);
  });
});
