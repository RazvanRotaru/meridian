/**
 * The files-first review checklist: unit grouping (hunk ∩ node, container kinds excluded, nesting
 * depth), the whole-file fallback, the derived vs explicit per-file viewed state, and the tick
 * transitions — including the staleness contract (a moved block never stays silently green).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  applyFilesToggle,
  applyFileToggle,
  applyUnitTick,
  checkStateOf,
  deriveReviewFiles,
  filesViewState,
  fileViewState,
  isReviewTestPath,
  promoteFullyViewedUnitTicks,
  tickForUnit,
} from "./reviewFiles";

function node(id: string, kind: string, file: string, start: number, end: number, parentId: string | null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split(/[#.]/).pop() ?? id,
    parentId,
    location: { file, startLine: start, endLine: end },
  } as GraphNode;
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  resolution?: GraphEdge["resolution"],
): GraphEdge {
  return { id, source, target, kind, resolution };
}

const NODES: GraphNode[] = [
  node("ts:src/a.ts", "module", "src/a.ts", 1, 120, null),
  node("ts:src/a.ts#Repo", "class", "src/a.ts", 10, 60, "ts:src/a.ts"),
  node("ts:src/a.ts#Repo.save", "method", "src/a.ts", 20, 40, "ts:src/a.ts#Repo"),
  node("ts:src/a.ts#helper", "function", "src/a.ts", 70, 90, "ts:src/a.ts"),
];

function fingerprintExtension(nodes: readonly GraphNode[], fileDigests: Record<string, string> = {}): GraphArtifact["extensions"] {
  return {
    reviewFingerprints: {
      version: 1,
      algorithm: "sha256-source-bytes",
      complete: true,
      units: Object.fromEntries(nodes.filter((entry) => entry.kind !== "module").map((entry) => [entry.id, {
        address: `unit:v1\0${entry.location.file}\0${entry.kind}\0${entry.qualifiedName}`,
        digest: "a".repeat(64),
      }])),
      files: Object.fromEntries(Object.keys(fileDigests).map((path) => [path, {
        address: `file:v1\0${path}`,
        digest: fileDigests[path],
      }])),
    },
  } as GraphArtifact["extensions"];
}

const ARTIFACT = {
  nodes: NODES,
  edges: [],
  extensions: fingerprintExtension(NODES, { "src/a.ts": "b".repeat(64), "docs/readme.md": "c".repeat(64) }),
} as unknown as GraphArtifact;
const INDEX = buildGraphIndex(ARTIFACT);

function contextOf(changedFiles: ReviewContext["changedFiles"]): ReviewContext {
  return { changedFiles, baseRef: null, baseSha: null, headRef: null, reviewKey: "test", warnings: [] };
}

describe("deriveReviewFiles", () => {
  it("classifies matched, explicitly tagged, and unmatched test files", () => {
    const taggedModule = {
      ...node("ts:src/checks.ts", "module", "src/checks.ts", 1, 20, null),
      tags: ["test"],
    } as GraphNode;
    const artifact = {
      nodes: [...NODES, taggedModule],
      edges: [],
    } as unknown as GraphArtifact;
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/a.ts", status: "modified" },
        { path: "src/checks.ts", status: "modified" },
        { path: "src/new.spec.ts", status: "added" },
      ]),
      artifact,
      buildGraphIndex(artifact),
      { baseIndex: null },
    );

    expect(Object.fromEntries(files.map((file) => [file.path, file.isTest]))).toEqual({
      "src/a.ts": false,
      "src/checks.ts": true,
      "src/new.spec.ts": true,
    });

    const taggedIndex = buildGraphIndex(artifact);
    const emptyArtifact = { nodes: [], edges: [] } as unknown as GraphArtifact;
    expect(isReviewTestPath("src/checks.ts", buildGraphIndex(emptyArtifact), taggedIndex)).toBe(true);
    const untaggedHead = {
      nodes: [node("ts:src/checks.ts", "module", "src/checks.ts", 1, 20, null)],
      edges: [],
    } as unknown as GraphArtifact;
    expect(isReviewTestPath("src/checks.ts", buildGraphIndex(untaggedHead), taggedIndex)).toBe(false);
  });

  it("groups hunk-overlapping LEAF units per file, in-graph files FIRST, ordered by start line", () => {
    const context = contextOf([
      { path: "docs/readme.md", status: "modified", hunks: [{ start: 1, end: 3 }] },
      { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
    ]);
    const files = deriveReviewFiles(context, ARTIFACT, INDEX, { baseIndex: null });
    // src/a.ts sorts first despite "d" < "s": it is on the graph, the md file is not.
    expect(files.map((file) => [file.path, file.moduleId])).toEqual([
      ["src/a.ts", "ts:src/a.ts"],
      ["docs/readme.md", null],
    ]);
    const [a, docs] = files;
    // The md file maps to no extracted block — a unit-less row, not a dropped one.
    expect(docs.units).toEqual([]);
    // Core marks LEAF blocks: the 25..30 hunk sits inside Repo.save, so the containing class does
    // NOT mark (no own-line touch) and helper (70..90) misses it entirely.
    expect(a.units.map((unit) => [unit.nodeId, unit.depth])).toEqual([["ts:src/a.ts#Repo.save", 1]]);
  });

  it("binds slash and literal-backslash units to their exact rename identities", () => {
    const literalPath = "src/a\\b.ts";
    const slashPath = "src/a/b.ts";
    const nodes = [
      node("ts:literal", "module", literalPath, 1, 20, null),
      node("ts:literal#run", "function", literalPath, 5, 8, "ts:literal"),
      node("ts:slash", "module", slashPath, 1, 20, null),
      node("ts:slash#run", "function", slashPath, 5, 8, "ts:slash"),
    ];
    const artifact = {
      nodes,
      edges: [],
      extensions: fingerprintExtension(nodes, {
        [literalPath]: "b".repeat(64),
        [slashPath]: "c".repeat(64),
      }),
    } as unknown as GraphArtifact;

    const files = deriveReviewFiles(
      contextOf([
        {
          path: literalPath,
          previousPath: "old/a\\b.ts",
          status: "renamed",
          hunks: [{ start: 5, end: 5 }],
        },
        {
          path: slashPath,
          previousPath: "old/a/b.ts",
          status: "renamed",
          hunks: [{ start: 5, end: 5 }],
        },
      ]),
      artifact,
      buildGraphIndex(artifact),
      { baseIndex: null },
    );

    expect(Object.fromEntries(files.map((file) => [file.path, file.moduleId]))).toEqual({
      [literalPath]: "ts:literal",
      [slashPath]: "ts:slash",
    });
    expect(files.find((file) => file.path === literalPath)?.units[0]?.previousAddress).toBe(
      "unit:v1\0old/a\\b.ts\0function\0ts:literal#run",
    );
    expect(files.find((file) => file.path === slashPath)?.units[0]?.previousAddress).toBe(
      "unit:v1\0old/a/b.ts\0function\0ts:slash#run",
    );
  });

  it("does not borrow a slash sibling's file fingerprint for a literal-backslash path", () => {
    const literalPath = "src/a\\b.ts";
    const slashPath = "src/a/b.ts";
    const nodes = [
      node("ts:literal", "module", literalPath, 1, 20, null),
      node("ts:slash", "module", slashPath, 1, 20, null),
    ];
    const artifact = {
      nodes,
      edges: [],
      extensions: fingerprintExtension(nodes, {
        [slashPath]: "c".repeat(64),
      }),
    } as unknown as GraphArtifact;

    const files = deriveReviewFiles(
      contextOf([
        { path: literalPath, status: "modified" },
        { path: slashPath, status: "modified" },
      ]),
      artifact,
      buildGraphIndex(artifact),
      { baseIndex: null },
    );

    expect(files.find((file) => file.path === literalPath)).toMatchObject({
      fingerprint: "unverified",
      address: null,
    });
    expect(files.find((file) => file.path === slashPath)).toMatchObject({
      fingerprint: "c".repeat(64),
      address: `file:v1\0${slashPath}`,
    });
  });

  it("keeps a hunk-less changed file as a unit-less row (core's module-only fallback)", () => {
    const files = deriveReviewFiles(
      contextOf([{ path: "src/a.ts", status: "modified" }]),
      ARTIFACT,
      INDEX,
      { baseIndex: null },
    );
    // The module node carries the "file changed" graph signal, but a container kind must never
    // render as a checkable unit — the file row itself represents it.
    expect(files[0].moduleId).toBe("ts:src/a.ts");
    expect(files[0].units).toEqual([]);
  });

  it("counts distinct unchanged caller files into changed units using resolved execution edges", () => {
    const extraNodes = [
      node("ts:src/b.ts#one", "function", "src/b.ts", 5, 8, null),
      node("ts:src/b.ts#two", "function", "src/b.ts", 10, 14, null),
      node("ts:src/c.ts#changing", "function", "src/c.ts", 5, 8, null),
      node("ts:src/d.ts#construct", "function", "src/d.ts", 5, 8, null),
      node("ts:src/e.ts#importer", "function", "src/e.ts", 5, 8, null),
      node("ts:src/f.ts#guess", "function", "src/f.ts", 5, 8, null),
    ];
    const artifact = {
      nodes: [...NODES, ...extraNodes],
      edges: [
        edge("calls-b1", "ts:src/b.ts#one", "ts:src/a.ts#Repo.save", "calls", "resolved"),
        edge("renders-b2", "ts:src/b.ts#two", "ts:src/a.ts#Repo.save", "renders", "resolved"),
        edge("calls-c", "ts:src/c.ts#changing", "ts:src/a.ts#Repo.save", "calls", "resolved"),
        edge("instantiates-d", "ts:src/d.ts#construct", "ts:src/a.ts#Repo.save", "instantiates"),
        edge("imports-e", "ts:src/e.ts#importer", "ts:src/a.ts#Repo.save", "imports", "resolved"),
        edge("calls-f", "ts:src/f.ts#guess", "ts:src/a.ts#Repo.save", "calls", "unresolved"),
      ],
    } as unknown as GraphArtifact;
    const index = buildGraphIndex(artifact);
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
        { path: "src/c.ts", status: "modified", hunks: [{ start: 5, end: 8 }] },
      ]),
      artifact,
      index,
      { baseIndex: null },
    );

    expect(files.find((file) => file.path === "src/a.ts")).toMatchObject({
      blastRadius: 2,
      deletedImpact: null,
    });
  });

  it("derives capped surviving callers and resolution caveats for a deleted baseline file", () => {
    const deletedNodes = [
      node("ts:src/gone.ts", "module", "src/gone.ts", 1, 50, null),
      node("ts:src/gone.ts#gone", "function", "src/gone.ts", 10, 20, "ts:src/gone.ts"),
    ];
    const callerNodes = Array.from({ length: 9 }, (_, index) =>
      node(`ts:src/live-${index}.ts#caller`, "function", `src/live-${index}.ts`, index + 1, index + 2, null),
    );
    const changingCaller = node("ts:src/changing.ts#caller", "function", "src/changing.ts", 3, 4, null);
    const resolvedEdges = callerNodes.map((caller, index) =>
      edge(`caller-${index}`, caller.id, "ts:src/gone.ts#gone", "calls", "resolved"),
    );
    const baseArtifact = {
      nodes: [...deletedNodes, ...callerNodes, changingCaller],
      edges: [
        ...resolvedEdges,
        edge("duplicate-caller", callerNodes[0].id, "ts:src/gone.ts", "renders", "resolved"),
        edge("unresolved", callerNodes[0].id, "ts:src/gone.ts#gone", "calls", "unresolved"),
        edge("external", callerNodes[1].id, "ts:src/gone.ts#gone", "calls", "external"),
        edge("changed-caller", changingCaller.id, "ts:src/gone.ts#gone", "calls", "resolved"),
      ],
    } as unknown as GraphArtifact;
    const activeArtifact = { nodes: [], edges: [] } as unknown as GraphArtifact;
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/gone.ts", status: "deleted" },
        { path: "docs/gone.md", status: "deleted" },
        { path: "src/changing.ts", status: "modified" },
      ]),
      activeArtifact,
      buildGraphIndex(activeArtifact),
      { baseIndex: buildGraphIndex(baseArtifact) },
    );
    const gone = files.find((file) => file.path === "src/gone.ts");

    expect(gone?.deletedImpact).toMatchObject({
      unresolvedCount: 2,
      truncated: true,
      omittedCallerCount: 1,
    });
    expect(gone?.deletedImpact?.callers).toHaveLength(8);
    expect(gone?.deletedImpact?.callers[0]).toEqual({
      nodeId: "ts:src/live-0.ts#caller",
      displayName: "caller",
      file: "src/live-0.ts",
      line: 1,
    });
    expect(files.find((file) => file.path === "docs/gone.md")?.deletedImpact).toBeNull();
    expect(files.find((file) => file.path === "src/changing.ts")?.deletedImpact).toBeNull();
  });
});

describe("view state + tick transitions", () => {
  // Two hunks so src/a.ts carries TWO leaf units. GitHub still exposes one atomic checkbox for it.
  const context = contextOf([
    { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }, { start: 75, end: 80 }] },
    { path: "docs/readme.md", status: "deleted" },
  ]);
  const [a, docs] = deriveReviewFiles(context, ARTIFACT, INDEX, { baseIndex: null });

  it("ignores legacy partial unit progress and uses one whole-file tick", () => {
    let unitTicks: Record<string, { at: string; fingerprint: string }> = {};
    expect(fileViewState(a, unitTicks, {})).toBe("todo");
    for (const unit of a.units) {
      unitTicks = applyUnitTick(unitTicks, unit, "2026-07-10T00:00:00Z");
    }
    expect(fileViewState(a, unitTicks, {})).toBe("todo");
    const wholeFile = applyFileToggle(a, unitTicks, {}, "2026-07-10T00:00:01Z");
    expect(wholeFile.unitTicks).toEqual({});
    expect(fileViewState(a, wholeFile.unitTicks, wholeFile.fileTicks)).toBe("done");
  });

  it("keeps unit staleness available for migration without deriving the file from it", () => {
    const tick = { at: "t", fingerprint: "old-fingerprint" };
    expect(checkStateOf(a.units[0].fingerprint, tick)).toBe("stale");
    expect(fileViewState(a, { [a.units[0].nodeId]: tick }, {})).toBe("todo");
    expect(fileViewState(a, {}, { [a.path]: tick })).toBe("stale");
  });

  it("treats a durable unview intent as todo and does not overwrite it during legacy migration", () => {
    const unview = {
      at: "t",
      fingerprint: a.fingerprint,
      viewerId: "U_Astrid",
      viewerLogin: "Astrid",
      viewed: false,
    };
    const unitTicks = Object.fromEntries(a.units.map((unit) => [
      unit.nodeId,
      {
        at: "older",
        fingerprint: unit.fingerprint,
        address: unit.address!,
      },
    ]));

    expect(fileViewState(a, {}, { [a.path]: unview })).toBe("todo");
    expect(promoteFullyViewedUnitTicks([a], unitTicks, { [a.path]: unview })).toEqual({
      unitTicks: {},
      fileTicks: { [a.path]: unview },
    });
  });

  it("promotes only fully reviewed legacy units to one whole-file tick", () => {
    const ticks = {
      [a.units[0].nodeId]: {
        at: "2026-07-10T00:00:00Z",
        fingerprint: a.units[0].fingerprint,
        address: a.units[0].address!,
      },
      [a.units[1].nodeId]: {
        at: "2026-07-10T00:00:01Z",
        fingerprint: a.units[1].fingerprint,
        address: a.units[1].address!,
      },
      hidden: { at: "2026-07-09T00:00:00Z", fingerprint: "hidden" },
    };

    const migrated = promoteFullyViewedUnitTicks([a], ticks, {});

    expect(migrated.unitTicks).toEqual({ hidden: ticks.hidden });
    expect(migrated.fileTicks[a.path]).toEqual({
      at: "2026-07-10T00:00:01Z",
      fingerprint: a.fingerprint,
      address: a.address,
    });
  });

  it("persists a valid __proto__ Git filename as an own whole-file tick", () => {
    const special = { ...a, path: "__proto__", address: null };
    const unitTicks = Object.fromEntries(special.units.map((unit, index) => [
      unit.nodeId,
      {
        at: `2026-07-10T00:00:0${index}Z`,
        fingerprint: unit.fingerprint,
        ...(unit.address ? { address: unit.address } : {}),
      },
    ]));

    const migrated = promoteFullyViewedUnitTicks([special], unitTicks, {});

    expect(Object.getPrototypeOf(migrated.fileTicks)).toBe(Object.prototype);
    expect(Object.hasOwn(migrated.fileTicks, "__proto__")).toBe(true);
    expect(fileViewState(special, {}, migrated.fileTicks)).toBe("done");
    expect(JSON.parse(JSON.stringify(migrated.fileTicks))["__proto__"]).toMatchObject({
      fingerprint: special.fingerprint,
    });
  });

  it("drops represented partial or stale unit progress without fabricating a viewed file", () => {
    const partial = {
      [a.units[0].nodeId]: {
        at: "t",
        fingerprint: a.units[0].fingerprint,
        address: a.units[0].address!,
      },
    };
    const stale = {
      ...partial,
      [a.units[1].nodeId]: {
        at: "t",
        fingerprint: "old",
        address: a.units[1].address!,
      },
    };

    expect(promoteFullyViewedUnitTicks([a], partial, {})).toEqual({ unitTicks: {}, fileTicks: {} });
    expect(promoteFullyViewedUnitTicks([a], stale, {})).toEqual({ unitTicks: {}, fileTicks: {} });
  });

  it("promotes a unique previous-path unit tick over a resolved stale file tick", () => {
    const unit = {
      ...a.units[0],
      address: "unit:v1\0src/new.ts\0method\0Repo.save",
      previousAddress: "unit:v1\0src/old.ts\0method\0Repo.save",
    };
    const renamed = {
      ...a,
      path: "src/new.ts",
      units: [unit],
      address: "file:v1\0src/new.ts",
      previousAddress: "file:v1\0src/old.ts",
    };
    const oldUnitTick = {
      at: "t",
      fingerprint: unit.fingerprint,
      address: unit.previousAddress,
    };
    const existingFileTick = {
      at: "older",
      fingerprint: "existing",
      address: renamed.previousAddress,
    };

    const migrated = promoteFullyViewedUnitTicks(
      [renamed],
      { oldUnit: oldUnitTick },
      { oldFile: existingFileTick },
    );

    expect(migrated.unitTicks).toEqual({});
    expect(migrated.fileTicks).toEqual({
      [renamed.path]: {
        at: oldUnitTick.at,
        fingerprint: renamed.fingerprint,
        address: renamed.address,
      },
    });
  });

  it("keeps a viewed declaration done when only absolute line geometry moves", () => {
    const original = a.units[0];
    const tick = applyUnitTick({}, original, "t");
    const shifted = { ...original, startLine: original.startLine + 20, endLine: original.endLine + 20 };
    expect(checkStateOf(shifted.fingerprint, tickForUnit(shifted, tick), shifted.address)).toBe("done");
  });

  it("marks identical hunk geometry stale when the worker source digest changes", () => {
    const original = a.units[0];
    const tick = applyUnitTick({}, original, "t");
    const changed = { ...original, fingerprint: "d".repeat(64) };
    expect(checkStateOf(changed.fingerprint, tickForUnit(changed, tick), changed.address)).toBe("stale");
  });

  it("reconciles H1 to H2 as unchanged A done, changed B stale, and new C todo", () => {
    const [unitA, unitB] = a.units;
    let ticks = applyUnitTick({}, unitA, "t1");
    ticks = applyUnitTick(ticks, unitB, "t1");
    const h2A = { ...unitA, startLine: unitA.startLine + 10, endLine: unitA.endLine + 10 };
    const h2B = { ...unitB, fingerprint: "e".repeat(64) };
    const h2C = {
      ...unitB,
      nodeId: "ts:src/a.ts#new",
      displayName: "new",
      address: "unit:v1\0src/a.ts\0function\0new",
      fingerprint: "f".repeat(64),
    };
    expect([
      checkStateOf(h2A.fingerprint, tickForUnit(h2A, ticks), h2A.address),
      checkStateOf(h2B.fingerprint, tickForUnit(h2B, ticks), h2B.address),
      checkStateOf(h2C.fingerprint, tickForUnit(h2C, ticks), h2C.address),
    ]).toEqual(["done", "stale", "todo"]);
    expect(filesViewState([{ ...a, units: [h2A, h2B, h2C] }, docs], ticks, {})).toBe("todo");
  });

  it("accepts only one exact previous-path rename address and fails closed on ambiguity", () => {
    const current = {
      ...a.units[0],
      nodeId: "ts:src/new.ts#Repo.save",
      address: "unit:v1\0src/new.ts\0method\0Repo.save",
      previousAddress: "unit:v1\0src/old.ts\0method\0Repo.save",
    };
    const oldTick = { at: "t", fingerprint: current.fingerprint, address: current.previousAddress };
    expect(checkStateOf(current.fingerprint, tickForUnit(current, { old: oldTick }), current.address)).toBe("done");
    expect(tickForUnit(current, { old: oldTick, duplicate: { ...oldTick } })).toBeUndefined();
    expect(applyUnitTick({ old: oldTick }, current, "t2")).toEqual({});
  });

  it("stores file gestures as one whole-file tick and clears legacy units", () => {
    const on = applyFileToggle(a, {}, {}, "t");
    expect(on.unitTicks).toEqual({});
    expect(on.fileTicks[a.path]).toEqual({ at: "t", fingerprint: a.fingerprint, address: a.address });
    const off = applyFileToggle(a, on.unitTicks, on.fileTicks, "t");
    expect(Object.keys(off.unitTicks)).toEqual([]);
    expect(off.fileTicks).toEqual({});
  });

  it("turns a legacy partly viewed file into one whole-file tick", () => {
    const partial = applyUnitTick({}, a.units[0], "t");
    const next = applyFileToggle(a, partial, {}, "t");
    expect(next.unitTicks).toEqual({});
    expect(fileViewState(a, next.unitTicks, next.fileTicks)).toBe("done");
  });

  it("uses GitHub VIEWED even without a semantic address and renders DISMISSED as stale", () => {
    const withoutAddress = { ...a, address: null };
    expect(fileViewState(withoutAddress, {}, {}, { [a.path]: "VIEWED" })).toBe("done");
    expect(fileViewState(withoutAddress, {}, {}, { [a.path]: "DISMISSED" })).toBe("stale");
    expect(fileViewState(withoutAddress, {}, {}, { [a.path]: "UNVIEWED" })).toBe("todo");
  });

  it("uses the explicit file tick for a unit-less file, with hunk-digest staleness", () => {
    expect(fileViewState(docs, {}, {})).toBe("todo");
    const on = applyFileToggle(docs, {}, {}, "t");
    expect(on.fileTicks[docs.path]).toEqual({ at: "t", fingerprint: docs.fingerprint, address: docs.address });
    expect(fileViewState(docs, {}, on.fileTicks)).toBe("done");
    expect(fileViewState(docs, {}, { [docs.path]: { at: "t", fingerprint: "other" } })).toBe("stale");
    const off = applyFileToggle(docs, {}, on.fileTicks, "t");
    expect(off.fileTicks).toEqual({});
  });

  it("keeps a local exact-path tick done when an unmatched file has no semantic address", () => {
    const unmatched = { ...docs, address: null };
    const on = applyFileToggle(unmatched, {}, {}, "t");
    expect(fileViewState(unmatched, {}, on.fileTicks)).toBe("done");
    expect(fileViewState(
      { ...unmatched, fingerprint: "changed" },
      {},
      on.fileTicks,
    )).toBe("stale");
  });

  it("completes a partly viewed folder without clearing files that were already done", () => {
    const aDone = applyFileToggle(a, {}, {}, "t1");
    const unrelatedTick = { at: "earlier", fingerprint: "unrelated" };
    const partialTicks = { ...aDone.unitTicks, unrelated: unrelatedTick };
    const partialFileTicks = { ...aDone.fileTicks, "outside.md": unrelatedTick };
    expect(filesViewState([a, docs], partialTicks, partialFileTicks)).toBe("todo");

    const completed = applyFilesToggle([a, docs], partialTicks, partialFileTicks, "t2");
    expect(fileViewState(a, completed.unitTicks, completed.fileTicks)).toBe("done");
    expect(fileViewState(docs, completed.unitTicks, completed.fileTicks)).toBe("done");
    expect(filesViewState([a, docs], completed.unitTicks, completed.fileTicks)).toBe("done");
    expect(completed.unitTicks.unrelated).toBe(unrelatedTick);
    expect(completed.fileTicks["outside.md"]).toBe(unrelatedTick);

    const cleared = applyFilesToggle([a, docs], completed.unitTicks, completed.fileTicks, "t3");
    expect(filesViewState([a, docs], cleared.unitTicks, cleared.fileTicks)).toBe("todo");
    expect(cleared.unitTicks).toEqual({ unrelated: unrelatedTick });
    expect(cleared.fileTicks).toEqual({ "outside.md": unrelatedTick });
  });

  it("marks a folder stale when any represented file changed, then refreshes every unfinished file", () => {
    const staleFileTicks = { [docs.path]: { at: "t1", fingerprint: "old" } };
    expect(filesViewState([a, docs], {}, staleFileTicks)).toBe("stale");

    const refreshed = applyFilesToggle([a, docs], {}, staleFileTicks, "t2");
    expect(filesViewState([a, docs], refreshed.unitTicks, refreshed.fileTicks)).toBe("done");
  });
});
