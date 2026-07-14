/**
 * Ghost dependencies keep the semantic endpoint that explains each relationship. Calls identify
 * exact callables, type consumers identify the exact source callable, and structural/construction
 * targets read as class/interface/object definitions. Module fallback endpoints remain honest.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { ghostDepWires, type GhostEmission } from "./ghostDeps";

function node(id: string, kind: string, parentId?: string): GraphNode {
  const file = id.includes("#") ? id.slice(0, id.indexOf("#")) : id;
  const label = id.split("#").pop()?.split(".").pop()?.split("/").pop() ?? id;
  return { id, kind, qualifiedName: label, displayName: label, parentId, location: { file, startLine: 1 } };
}

function edge(id: string, kind: string, source: string, target: string, weight = 1): GraphEdge {
  return { id, source, target, kind, weight, resolution: "resolved" } as GraphEdge;
}

const APP_PACKAGE = "ts:app";
const APP_FILE = "ts:app/app.ts";
const APP_TYPE = `${APP_FILE}#App`;
const RUN = `${APP_TYPE}.run`;
const SELECTED_TYPE = `${APP_FILE}#Request`;
const CONTRACT_METHOD = `${SELECTED_TYPE}.validate`;
const LIB_PACKAGE = "ts:lib";
const LIB_FILE = "ts:lib/worker.ts";
const WORKER = `${LIB_FILE}#Worker`;
const WORKER_CTOR = `${WORKER}.constructor`;
const EXECUTE = `${WORKER}.execute`;
const HELPER = `${LIB_FILE}#helper`;
const BASE = `${LIB_FILE}#Base`;
const PROTOCOL = `${LIB_FILE}#Protocol`;
const CONSUMER = `${LIB_FILE}#Consumer`;
const CONSUME = `${CONSUMER}.consume`;
const FALLBACK_MODULE = "ts:lib/wire.ts";

const NODES: GraphNode[] = [
  { ...node(APP_PACKAGE, "package"), tags: ["npm-package"] },
  node(APP_FILE, "module", APP_PACKAGE),
  node(APP_TYPE, "class", APP_FILE),
  node(RUN, "method", APP_TYPE),
  node(SELECTED_TYPE, "interface", APP_FILE),
  node(CONTRACT_METHOD, "method", SELECTED_TYPE),
  { ...node(LIB_PACKAGE, "package"), tags: ["npm-package"] },
  node(LIB_FILE, "module", LIB_PACKAGE),
  node(WORKER, "class", LIB_FILE),
  node(WORKER_CTOR, "method", WORKER),
  { ...node(EXECUTE, "method", WORKER), signature: "execute(): Promise<void>", tags: ["async", "static"] },
  node(HELPER, "function", LIB_FILE),
  node(BASE, "class", LIB_FILE),
  node(PROTOCOL, "interface", LIB_FILE),
  node(CONSUMER, "class", LIB_FILE),
  node(CONSUME, "method", CONSUMER),
  node(FALLBACK_MODULE, "module", LIB_PACKAGE),
];

function derive(
  edges: GraphEdge[],
  visible: string[],
  code: string[],
  calls: Array<{ stepId: string; blockId: string; target: string }> = [],
): { index: GraphIndex; emission: GhostEmission } {
  const index = buildGraphIndex({ nodes: NODES, edges } as unknown as GraphArtifact);
  const codeIds = new Set(code);
  const emission = ghostDepWires(buildBlockDeps(index), calls, new Set(visible), index, (id) => codeIds.has(id), new Set());
  return { index, emission };
}

const APP_VISIBLE = [APP_PACKAGE, APP_FILE, APP_TYPE, RUN, SELECTED_TYPE];

describe("ghostDepWires — relation-aware semantic endpoints", () => {
  it("only ghosts an implemented method after its contract method is visible", () => {
    const implementation = edge("implemented-by:execute", "implementedBy", CONTRACT_METHOD, EXECUTE);

    // A collapsed interface must not leak its hidden method relationship through either ghost
    // direction: the implementation cannot appear as an outgoing ghost, and the contract cannot
    // appear as an incoming ghost from a separately visible implementation.
    expect(derive([implementation], APP_VISIBLE, [SELECTED_TYPE]).emission).toEqual({
      ghosts: new Map(),
      wires: [],
    });
    expect(derive(
      [implementation],
      [LIB_PACKAGE, LIB_FILE, WORKER, EXECUTE],
      [WORKER, EXECUTE],
    ).emission).toEqual({ ghosts: new Map(), wires: [] });

    // Opening the interface makes the source method exact, while the off-level concrete method
    // remains a useful semantic ghost.
    const { emission } = derive(
      [implementation],
      [...APP_VISIBLE, CONTRACT_METHOD],
      [SELECTED_TYPE, CONTRACT_METHOD],
    );
    expect([...emission.ghosts.keys()]).toEqual([EXECUTE]);
    expect(emission.wires).toEqual([expect.objectContaining({
      source: CONTRACT_METHOD,
      target: EXECUTE,
      kind: "implementedBy",
      underlyingEdgeIds: ["implemented-by:execute"],
    })]);
  });

  it("keeps exact called methods/functions and aggregates evidence without folding them to a class", () => {
    const { emission } = derive(
      [edge("call:1", "calls", RUN, EXECUTE), edge("call:2", "calls", RUN, EXECUTE, 2), edge("call:3", "calls", RUN, HELPER)],
      APP_VISIBLE,
      [RUN, APP_TYPE, SELECTED_TYPE],
    );

    expect([...emission.ghosts.keys()].sort()).toEqual([EXECUTE, HELPER].sort());
    expect(emission.ghosts.has(WORKER)).toBe(false);
    expect(emission.ghosts.get(EXECUTE)?.ghostKind).toBe("method");
    expect(emission.ghosts.get(EXECUTE)?.semantics).toEqual({
      modifiers: ["async", "static"],
      returnsPromise: true,
    });
    const executeWire = emission.wires.find((wire) => wire.target === EXECUTE);
    expect(executeWire).toMatchObject({ source: RUN, target: EXECUTE, kind: "calls", weight: 3 });
    expect(executeWire?.underlyingEdgeIds.sort()).toEqual(["call:1", "call:2"]);
  });

  it("keeps an incoming caller method exact instead of raising it to its owning class", () => {
    const { emission } = derive([edge("call:incoming", "calls", EXECUTE, RUN)], APP_VISIBLE, [RUN, APP_TYPE, SELECTED_TYPE]);

    expect([...emission.ghosts.keys()]).toEqual([EXECUTE]);
    expect(emission.ghosts.has(WORKER)).toBe(false);
    expect(emission.wires[0]).toMatchObject({ source: EXECUTE, target: RUN, kind: "calls" });
  });

  it("raises construction targets to their class while preserving extends/implements type identities", () => {
    const { emission } = derive(
      [
        edge("new:worker", "instantiates", RUN, WORKER),
        edge("extends:base", "extends", APP_TYPE, BASE),
        edge("implements:protocol", "implements", APP_TYPE, PROTOCOL),
      ],
      APP_VISIBLE,
      [RUN, APP_TYPE, SELECTED_TYPE],
    );

    // buildBlockDeps resolves `new Worker()` to the constructor block; the ghost projection raises
    // that structural target back to the class definition rather than showing a constructor card.
    expect([...emission.ghosts.keys()].sort()).toEqual([BASE, PROTOCOL, WORKER].sort());
    expect(emission.ghosts.has(WORKER_CTOR)).toBe(false);
    expect(emission.ghosts.get(WORKER)?.ghostKind).toBe("class");
    expect(emission.ghosts.get(PROTOCOL)?.ghostKind).toBe("interface");
    expect(emission.wires.find((wire) => wire.kind === "instantiates")).toMatchObject({ source: RUN, target: WORKER });
  });

  it("keeps the exact off-screen function/method that references a selected type", () => {
    const { emission } = derive([edge("ref:consumer", "references", CONSUME, SELECTED_TYPE)], APP_VISIBLE, [RUN, APP_TYPE, SELECTED_TYPE]);

    expect([...emission.ghosts.keys()]).toEqual([CONSUME]);
    expect(emission.ghosts.has(CONSUMER)).toBe(false);
    expect(emission.ghosts.get(CONSUME)?.ghostKind).toBe("method");
    expect(emission.wires[0]).toMatchObject({ source: CONSUME, target: SELECTED_TYPE, kind: "references" });
  });

  it("keeps an extractor module fallback as a module instead of inventing a symbol or folder", () => {
    const { emission } = derive([edge("ref:fallback", "references", RUN, FALLBACK_MODULE)], APP_VISIBLE, [RUN, APP_TYPE, SELECTED_TYPE]);

    expect([...emission.ghosts.keys()]).toEqual([FALLBACK_MODULE]);
    expect(emission.ghosts.get(FALLBACK_MODULE)?.ghostKind).toBe("module");
    expect(emission.wires[0]).toMatchObject({ source: RUN, target: FALLBACK_MODULE, kind: "references" });
  });

  it("keeps a resolved step call on its exact method endpoint", () => {
    const { emission } = derive([], APP_VISIBLE, [RUN, APP_TYPE, SELECTED_TYPE], [
      { stepId: "step:run:0", blockId: RUN, target: WORKER_CTOR },
    ]);

    expect([...emission.ghosts.keys()]).toEqual([WORKER_CTOR]);
    expect(emission.wires[0]).toEqual({
      source: "step:run:0",
      target: WORKER_CTOR,
      weight: 1,
      kind: "calls",
      crossPackage: true,
      underlyingEdgeIds: [],
    });
  });
});

describe("ghostDepWires — complete high-degree emission", () => {
  it("keeps every incoming and outgoing semantic peer beyond the former twenty-item window", () => {
    const peers = Array.from({ length: 23 }, (_, index) => {
      const incomingFile = `ts:lib/incoming-${index}.ts`;
      const incoming = `${incomingFile}#caller`;
      const outgoingFile = `ts:lib/outgoing-${index}.ts`;
      const outgoing = `${outgoingFile}#dependency`;
      return {
        nodes: [
          node(incomingFile, "module", LIB_PACKAGE),
          node(incoming, "function", incomingFile),
          node(outgoingFile, "module", LIB_PACKAGE),
          node(outgoing, "function", outgoingFile),
        ],
        edges: [
          edge(`incoming:${index}`, "calls", incoming, RUN),
          edge(`outgoing:${index}`, "calls", RUN, outgoing),
        ],
        incoming,
        outgoing,
      };
    });
    const edges = peers.flatMap((peer) => peer.edges);
    const index = buildGraphIndex({ nodes: [...NODES, ...peers.flatMap((peer) => peer.nodes)], edges } as unknown as GraphArtifact);
    const emission = ghostDepWires(
      buildBlockDeps(index),
      [],
      new Set(APP_VISIBLE),
      index,
      (id) => id === RUN,
      new Set(),
    );

    expect(emission.ghosts.size).toBe(46);
    expect(emission.wires.filter((wire) => wire.target === RUN)).toHaveLength(23);
    expect(emission.wires.filter((wire) => wire.source === RUN)).toHaveLength(23);
    expect(emission.ghosts.has(peers[22].incoming)).toBe(true);
    expect(emission.ghosts.has(peers[22].outgoing)).toBe(true);
    expect(emission.wires.every((wire) => wire.underlyingEdgeIds.length === 1)).toBe(true);
  });
});
