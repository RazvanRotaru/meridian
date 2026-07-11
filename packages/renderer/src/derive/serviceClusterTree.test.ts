import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildBlockDeps } from "./blockDeps";
import { deriveServiceTree } from "./serviceClusterTree";
import { frameIdOf } from "./serviceClusterEdges";
import { isServiceDomainId, UNASSIGNED_SERVICE_DOMAIN_ID } from "./serviceDomains";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";

function node(id: string, kind: string, parentId?: string, displayName?: string, file = "f.ts"): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file, startLine: 1 },
  } as GraphNode;
}

// Three service-named classes — each seeds its OWN cluster (seeds are terminal in the ownership
// BFS) — coupled in a chain: Alpha → Beta → Gamma. Alpha never touches Gamma directly, which is
// exactly the shape the scoped sub-view must respect: scope {Alpha, Beta} keeps the A→B wire and
// GHOSTS the dropped B→Gamma coupling as a card for Gamma's lead (honest resolution — the wire
// must not silently vanish), while nothing of Gamma is drawn for real.
const ALPHA = "ts:app/a.ts#AlphaService";
const BETA = "ts:app/b.ts#BetaService";
const GAMMA = "ts:app/c.ts#GammaService";

const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/a.ts", "module", "ts:app", "a.ts"),
  node(ALPHA, "class", "ts:app/a.ts", "AlphaService"),
  node(`${ALPHA}.run`, "method", ALPHA, "run"),
  node("ts:app/b.ts", "module", "ts:app", "b.ts"),
  node(BETA, "class", "ts:app/b.ts", "BetaService"),
  node(`${BETA}.run`, "method", BETA, "run"),
  node("ts:app/c.ts", "module", "ts:app", "c.ts"),
  node(GAMMA, "class", "ts:app/c.ts", "GammaService"),
  node(`${GAMMA}.run`, "method", GAMMA, "run"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: `${ALPHA}.run`, target: `${BETA}.run`, kind: "calls", resolution: "resolved" },
  { id: "e2", source: `${BETA}.run`, target: `${GAMMA}.run`, kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
const graph = buildModuleGraph(index);
const deps = buildBlockDeps(index);
const flows = {} as LogicFlows;
const NONE = new Set<string>();

function frameIds(tree: { nodes: { id: string }[] }): string[] {
  return tree.nodes.map((n) => n.id).filter((id) => id.startsWith("svc:")).sort();
}

function ghostIds(tree: { nodes: { id: string; kind: string }[] }): string[] {
  return tree.nodes.filter((n) => n.kind === "ghost").map((n) => n.id).sort();
}

function ghostWire(tree: { edges: { source: string; target: string; ghost?: boolean }[] }, source: string, target: string) {
  return tree.edges.find((e) => e.ghost === true && e.source === source && e.target === target);
}

describe("deriveServiceTree scoping", () => {
  it("unscoped, all three clusters and both coupling wires draw, with NO ghosts (nothing is dropped)", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows);
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA), frameIdOf(GAMMA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    expect(tree.edges.some((e) => e.source === frameIdOf(BETA) && e.target === frameIdOf(GAMMA))).toBe(true);
    expect(ghostIds(tree)).toEqual([]);
    expect(tree.effectiveFocus).toBeNull();
    expect(tree.nodes.some((item) => isServiceDomainId(item.id))).toBe(false);
  });

  it("scoped to {Alpha, Beta}: only their frames draw, the A→B wire stays, and the dropped B→Gamma coupling GHOSTS Gamma's lead", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    // The out-of-scope endpoint is a GHOST card for its lead, wired from the in-scope frame.
    expect(ghostIds(tree)).toEqual([GAMMA]);
    expect(ghostWire(tree, frameIdOf(BETA), GAMMA)).toBeDefined();
    // Nothing REAL of Gamma is drawn: no frame, and every non-ghost edge stays clear of it.
    const mentionsGamma = (id: string) => id.includes("GammaService");
    expect(tree.nodes.some((n) => n.kind !== "ghost" && mentionsGamma(n.id))).toBe(false);
    expect(tree.edges.some((e) => e.ghost !== true && (mentionsGamma(e.source) || mentionsGamma(e.target)))).toBe(false);
  });

  it("scoped to a single cluster ghosts its outbound coupling (Alpha → ghost Beta), nothing else", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA)]);
    expect(ghostIds(tree)).toEqual([BETA]);
    expect(ghostWire(tree, frameIdOf(ALPHA), BETA)).toBeDefined();
    // B→Gamma has neither end in scope — no ghost, no wire.
    expect(tree.nodes.some((n) => n.id.includes("GammaService"))).toBe(false);
  });

  it("an INBOUND dropped coupling ghosts the caller's lead, wired INTO the scoped frame", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([GAMMA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(GAMMA)]);
    expect(ghostIds(tree)).toEqual([BETA]);
    expect(ghostWire(tree, BETA, frameIdOf(GAMMA))).toBeDefined();
  });

  it("scope ghosts respect the Tests toggle (a hidden lead never ghosts)", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, {
      scopeLeadIds: new Set([ALPHA, BETA]),
      hiddenIds: new Set([GAMMA]),
    });
    expect(ghostIds(tree)).toEqual([]);
    expect(tree.edges.some((e) => e.ghost === true)).toBe(false);
  });
});

describe("deriveServiceTree extra-file expansion", () => {
  it("opens a TypeScript file one level without automatically opening its class definitions", () => {
    const fileId = "ts:app/a.ts";
    const fileOpen = deriveServiceTree(
      index,
      null,
      new Set([fileId]),
      graph,
      deps,
      flows,
      { extraIds: new Set([fileId]) },
    );

    expect(fileOpen.nodes.find((item) => item.id === fileId)).toMatchObject({
      kind: "file",
      isExpanded: true,
    });
    expect(fileOpen.nodes.find((item) => item.id === ALPHA)).toMatchObject({
      kind: "unit",
      parentId: fileId,
      isExpanded: false,
    });
    expect(fileOpen.nodes.some((item) => item.id === `${ALPHA}.run`)).toBe(false);

    const classOpen = deriveServiceTree(
      index,
      null,
      new Set([fileId, ALPHA]),
      graph,
      deps,
      flows,
      { extraIds: new Set([fileId]) },
    );

    expect(classOpen.nodes.find((item) => item.id === ALPHA)?.isExpanded).toBe(true);
    expect(classOpen.nodes.find((item) => item.id === `${ALPHA}.run`)).toMatchObject({
      kind: "block",
      parentId: ALPHA,
    });
  });
});

describe("deriveServiceTree domain placement parents", () => {
  const fixture = domainFixture();

  it("starts large overviews as selectable, collapsed filesystem-domain cards", () => {
    const tree = deriveServiceTree(fixture.index, null, NONE, fixture.graph, fixture.deps, flows);
    const domains = tree.nodes.filter((item) => isServiceDomainId(item.id));

    expect(domains.map((item) => (item.data as { label: string }).label)).toEqual(["analytics", "backend"]);
    expect(domains.every((item) => item.kind === "serviceDomain" && item.parentId === null && item.isContainer && !item.isExpanded)).toBe(true);
    expect(domains.map((item) => (item.data as { countLabel?: string }).countLabel)).toEqual(["6 services", "6 services"]);
    expect(domains.map((item) => ({
      label: (item.data as { label: string }).label,
      ca: (item.data as { ca: number }).ca,
      ce: (item.data as { ce: number }).ce,
    }))).toEqual([
      { label: "analytics", ca: 0, ce: 1 },
      { label: "backend", ca: 1, ce: 0 },
    ]);
    expect(tree.nodes.some((item) => item.id.startsWith("svc:"))).toBe(false);
    // Internal service couplings fold away; the one cross-domain dependency lifts to the cards.
    expect(tree.edges).toHaveLength(1);
    expect(tree.edges.every((edge) => isServiceDomainId(edge.source) && isServiceDomainId(edge.target))).toBe(true);
  });

  it("expands one domain inline and keeps the other collapsed", () => {
    const collapsed = deriveServiceTree(fixture.index, null, NONE, fixture.graph, fixture.deps, flows);
    const analytics = collapsed.nodes.find((item) => (item.data as { label?: string }).label === "analytics")!;
    const backend = collapsed.nodes.find((item) => (item.data as { label?: string }).label === "backend")!;
    const tree = deriveServiceTree(fixture.index, null, new Set([analytics.id]), fixture.graph, fixture.deps, flows);
    const frames = tree.nodes.filter((item) => item.id.startsWith("svc:"));

    expect(tree.nodes.find((item) => item.id === analytics.id)?.isExpanded).toBe(true);
    expect(tree.nodes.find((item) => item.id === backend.id)?.isExpanded).toBe(false);
    expect(frames).toHaveLength(6);
    expect(frames.every((frame) => frame.parentId === analytics.id)).toBe(true);
    expect(tree.edges.some((edge) => edge.source.startsWith("svc:") && edge.target === backend.id)).toBe(true);
  });

  it("navigates into a domain as a flat service level without drawing its wrapper", () => {
    const overview = deriveServiceTree(fixture.index, null, NONE, fixture.graph, fixture.deps, flows);
    const analytics = overview.nodes.find((item) => (item.data as { label?: string }).label === "analytics")!;
    const tree = deriveServiceTree(fixture.index, analytics.id, NONE, fixture.graph, fixture.deps, flows);

    expect(tree.effectiveFocus).toBe(analytics.id);
    expect(tree.nodes.some((item) => isServiceDomainId(item.id))).toBe(false);
    expect(tree.nodes.filter((item) => item.id.startsWith("svc:"))).toHaveLength(6);
    expect(tree.nodes.filter((item) => item.id.startsWith("svc:")).every((item) => item.parentId === null)).toBe(true);
  });

  it("keeps scoped Service views flat even when the scope itself is large", () => {
    const tree = deriveServiceTree(fixture.index, null, NONE, fixture.graph, fixture.deps, flows, {
      scopeLeadIds: new Set(fixture.leads),
    });

    expect(tree.nodes.some((item) => isServiceDomainId(item.id))).toBe(false);
    expect(tree.nodes.filter((item) => item.id.startsWith("svc:"))).toHaveLength(12);
  });

  it("keeps a focused service flat and free of placement-only parents", () => {
    const focus = frameIdOf(fixture.leads[0]);
    const tree = deriveServiceTree(fixture.index, focus, NONE, fixture.graph, fixture.deps, flows);

    expect(tree.nodes.some((item) => isServiceDomainId(item.id))).toBe(false);
    expect(tree.nodes.find((item) => item.id === focus)?.parentId).toBeNull();
  });

  it("lets ELK place the domain frames as separated parents while preserving every service frame", async () => {
    const overview = deriveServiceTree(fixture.index, null, NONE, fixture.graph, fixture.deps, flows);
    const expandedDomains = new Set(overview.nodes.filter((item) => isServiceDomainId(item.id)).map((item) => item.id));
    const tree = deriveServiceTree(fixture.index, null, expandedDomains, fixture.graph, fixture.deps, flows);
    const laid = await layoutModuleTree(tree.nodes, tree.edges);
    const domains = laid.nodes.filter((item) => isServiceDomainId(item.id));

    expect(domains).toHaveLength(2);
    expect(domains.every((item) => item.selectable !== false && item.focusable !== false)).toBe(true);
    expect(laid.nodes.filter((item) => item.id.startsWith("svc:"))).toHaveLength(12);
    expect(domains.every((item) => item.parentId === undefined)).toBe(true);
    expect(separation(rectOf(domains[0]), rectOf(domains[1]))).toBeGreaterThanOrEqual(40);
    expect(laid.edges.map((edge) => edge.id).sort()).toEqual(tree.edges.map((edge) => edge.id).sort());
  });

  it("keeps a single large catch-all as one collapsible parent instead of falling back to 12 flat frames", () => {
    const isolatedIndex = buildGraphIndex({ nodes: [...fixture.index.nodesById.values()], edges: [] } as unknown as GraphArtifact);
    const isolatedGraph = buildModuleGraph(isolatedIndex);
    const isolatedDeps = buildBlockDeps(isolatedIndex);
    const overview = deriveServiceTree(isolatedIndex, null, NONE, isolatedGraph, isolatedDeps, flows, {
      groupingMode: "dependency",
    });
    const domains = overview.nodes.filter((item) => isServiceDomainId(item.id));

    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({ kind: "serviceDomain", isContainer: true, isExpanded: false });
    expect(overview.nodes.some((item) => item.id.startsWith("svc:"))).toBe(false);

    const expanded = deriveServiceTree(
      isolatedIndex,
      null,
      new Set([domains[0].id]),
      isolatedGraph,
      isolatedDeps,
      flows,
      { groupingMode: "dependency" },
    );
    expect(expanded.nodes.filter((item) => item.id.startsWith("svc:"))).toHaveLength(12);
    expect(expanded.nodes.filter((item) => item.id.startsWith("svc:")).every((item) => item.parentId === domains[0].id)).toBe(true);

    const focused = deriveServiceTree(
      isolatedIndex,
      domains[0].id,
      NONE,
      isolatedGraph,
      isolatedDeps,
      flows,
      { groupingMode: "dependency" },
    );
    expect(focused.effectiveFocus).toBe(domains[0].id);
    expect(focused.nodes.some((item) => isServiceDomainId(item.id))).toBe(false);
    expect(focused.nodes.filter((item) => item.id.startsWith("svc:"))).toHaveLength(12);
  });
});

describe("deriveServiceTree unassigned discoverability", () => {
  const nodes = [
    node("ts:src", "package", undefined, "src", "src"),
    node("ts:src/services/chat.ts", "module", "ts:src", "chat.ts", "src/services/chat.ts"),
    node("ts:src/services/chat.ts#ChatService", "class", "ts:src/services/chat.ts", "ChatService", "src/services/chat.ts"),
    node("ts:src/services/chat.ts#ChatService.run", "method", "ts:src/services/chat.ts#ChatService", "run", "src/services/chat.ts"),
    node("ts:src/components/ActionChipView.tsx", "module", "ts:src", "ActionChipView.tsx", "src/components/ActionChipView.tsx"),
    node("ts:src/components/ActionChipView.tsx#ActionChipView", "class", "ts:src/components/ActionChipView.tsx", "ActionChipView", "src/components/ActionChipView.tsx"),
    node("ts:src/components/ActionChipView.tsx#ActionChipView.render", "method", "ts:src/components/ActionChipView.tsx#ActionChipView", "render", "src/components/ActionChipView.tsx"),
  ];
  const unassignedIndex = buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
  const unassignedGraph = buildModuleGraph(unassignedIndex);
  const unassignedDeps = buildBlockDeps(unassignedIndex);

  it("shows one collapsed Unassigned code parent without counting its units as services", () => {
    const tree = deriveServiceTree(unassignedIndex, null, NONE, unassignedGraph, unassignedDeps, flows);
    const unassigned = tree.nodes.find((item) => item.id === UNASSIGNED_SERVICE_DOMAIN_ID);

    expect(unassigned).toMatchObject({ kind: "serviceDomain", isContainer: true, isExpanded: false });
    expect(unassigned?.data).toMatchObject({
      label: "Unassigned code",
      countLabel: "1 unassigned group",
      serviceDomainKind: "unassigned",
    });
    expect(tree.nodes.some((item) => item.id === frameIdOf("ts:src/components/ActionChipView.tsx#ActionChipView"))).toBe(false);
  });

  it("navigates into Unassigned code and reveals its ordinary expandable frames", () => {
    const tree = deriveServiceTree(
      unassignedIndex,
      UNASSIGNED_SERVICE_DOMAIN_ID,
      NONE,
      unassignedGraph,
      unassignedDeps,
      flows,
    );
    expect(tree.effectiveFocus).toBe(UNASSIGNED_SERVICE_DOMAIN_ID);
    expect(tree.nodes.some((item) => item.id === UNASSIGNED_SERVICE_DOMAIN_ID)).toBe(false);
    expect(tree.nodes.find((item) => item.id === frameIdOf("ts:src/components/ActionChipView.tsx#ActionChipView"))?.data)
      .toMatchObject({ countLabel: "1 unit" });
  });

  it("keeps one real service's domain navigation and breadcrumb when Unassigned forces grouping", () => {
    const overview = deriveServiceTree(unassignedIndex, null, NONE, unassignedGraph, unassignedDeps, flows);
    const serviceDomain = overview.nodes.find((item) =>
      item.kind === "serviceDomain" && item.id !== UNASSIGNED_SERVICE_DOMAIN_ID);
    expect(serviceDomain).toBeDefined();

    const serviceSurface = moduleSurfaceSpec("call")!;
    expect(serviceSurface.navigation.canNavigateInto(serviceDomain!.kind, serviceDomain!.id)).toBe(true);
    const domainTree = deriveServiceTree(
      unassignedIndex,
      serviceDomain!.id,
      NONE,
      unassignedGraph,
      unassignedDeps,
      flows,
    );
    expect(domainTree.effectiveFocus).toBe(serviceDomain!.id);
    expect(serviceSurface.navigation.crumbs(domainTree.effectiveFocus, unassignedIndex)).toEqual([{
      id: serviceDomain!.id,
      label: (serviceDomain!.data as { label: string }).label,
    }]);

    const chatLead = "ts:src/services/chat.ts#ChatService";
    const serviceFrame = frameIdOf(chatLead);
    const serviceTree = deriveServiceTree(
      unassignedIndex,
      serviceFrame,
      NONE,
      unassignedGraph,
      unassignedDeps,
      flows,
    );
    expect(serviceSurface.navigation.crumbs(serviceTree.effectiveFocus, unassignedIndex)).toEqual([
      { id: serviceDomain!.id, label: (serviceDomain!.data as { label: string }).label },
      { id: serviceFrame, label: "ChatService" },
    ]);
  });
});

describe("deriveServiceTree focus (cluster zoom)", () => {
  it("focus on a cluster opens the frame one level and requires an explicit unit expansion for methods", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows);
    expect(frameIds(tree)).toEqual([frameIdOf(BETA)]);
    expect(tree.effectiveFocus).toBe(frameIdOf(BETA));
    const frame = tree.nodes.find((n) => n.id === frameIdOf(BETA))!;
    expect(frame.isExpanded).toBe(true);
    expect(tree.nodes.find((n) => n.id === BETA)).toMatchObject({ kind: "unit", isExpanded: false });
    expect(tree.nodes.some((n) => n.id === `${BETA}.run`)).toBe(false);

    const unitOpen = deriveServiceTree(index, frameIdOf(BETA), new Set([BETA]), graph, deps, flows);
    expect(unitOpen.nodes.find((n) => n.id === BETA)?.isExpanded).toBe(true);
    expect(unitOpen.nodes.find((n) => n.id === `${BETA}.run`)).toMatchObject({
      kind: "block",
      parentId: BETA,
    });
  });

  it("focus ghosts BOTH coupling directions as exact caller/callee methods without same-folder folding", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows);
    // The off-screen caller wires INTO Beta's drawn method and the off-screen callee wires OUT;
    // sharing ts:app no longer erases either callable identity.
    expect(ghostIds(tree)).toEqual([`${ALPHA}.run`, `${GAMMA}.run`]);
    expect(ghostWire(tree, `${ALPHA}.run`, BETA)).toBeDefined();
    expect(ghostWire(tree, BETA, `${GAMMA}.run`)).toBeDefined();
  });

  it("a non-svc or unknown focus is ignored: full lens, effectiveFocus null", () => {
    const folderFocus = deriveServiceTree(index, "ts:app", NONE, graph, deps, flows);
    expect(frameIds(folderFocus)).toHaveLength(3);
    expect(folderFocus.effectiveFocus).toBeNull();
    const staleFocus = deriveServiceTree(index, "svc:ts:app/z.ts#NopeService", NONE, graph, deps, flows);
    expect(staleFocus.effectiveFocus).toBeNull();
    expect(frameIds(staleFocus)).toHaveLength(3);
  });

  it("focus composes with scope: the zoom draws inside the kept set; couplings leaving the zoom ghost", () => {
    const tree = deriveServiceTree(index, frameIdOf(ALPHA), NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA)]);
    expect(tree.effectiveFocus).toBe(frameIdOf(ALPHA));
    // Alpha's unit is drawn but collapsed, so its side lifts while Beta stays an exact ghost method.
    expect(ghostIds(tree)).toEqual([`${BETA}.run`]);
    expect(ghostWire(tree, ALPHA, `${BETA}.run`)).toBeDefined();
  });

  it("a focus OUTSIDE the scope is ignored (the zoom can only dive what the scope kept)", () => {
    const tree = deriveServiceTree(index, frameIdOf(GAMMA), NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(tree.effectiveFocus).toBeNull();
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA)].sort());
  });

  it("walk-tier ghosts respect the Tests toggle (hiddenIds)", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows, { hiddenIds: new Set([GAMMA]) });
    expect(ghostIds(tree)).toEqual([`${ALPHA}.run`]);
  });
});

function domainFixture(): {
  index: ReturnType<typeof buildGraphIndex>;
  graph: ReturnType<typeof buildModuleGraph>;
  deps: ReturnType<typeof buildBlockDeps>;
  leads: string[];
} {
  const nodes: GraphNode[] = [node("ts:src", "package", undefined, "src", "src")];
  const edges: GraphEdge[] = [];
  const leads: string[] = [];
  const domains = ["analytics", "backend"];
  for (const domain of domains) {
    for (let index = 0; index < 6; index += 1) {
      const file = `src/aria/app/${domain}/service${index}.ts`;
      const moduleId = `ts:${file}`;
      const lead = `${moduleId}#${domain}${index}Service`;
      const method = `${lead}.run`;
      nodes.push(node(moduleId, "module", "ts:src", `service${index}.ts`, file));
      nodes.push(node(lead, "class", moduleId, `${domain}${index}Service`, file));
      nodes.push(node(method, "method", lead, "run", file));
      leads.push(lead);
    }
  }
  for (let index = 0; index < leads.length - 1; index += 1) {
    edges.push({
      id: `domain-edge-${index}`,
      source: `${leads[index]}.run`,
      target: `${leads[index + 1]}.run`,
      kind: "calls",
      resolution: "resolved",
    } as GraphEdge);
  }
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return { index, graph: buildModuleGraph(index), deps: buildBlockDeps(index), leads };
}

function rectOf(node: { position: { x: number; y: number }; style?: unknown }) {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x: node.position.x, y: node.position.y, width: style.width ?? 0, height: style.height ?? 0 };
}

function separation(a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>): number {
  const horizontal = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const vertical = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.max(horizontal, vertical);
}
