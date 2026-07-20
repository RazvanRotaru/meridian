import { describe, expect, it } from "vitest";
import type { ChangedDiffLine, GraphArtifact, GraphEdge, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrChangedFile } from "../state/prTypes";
import { deriveDeletedNodeProjection } from "./deletedNodeProjection";

const PACKAGE_ID = "ts:src";

function node(
  id: string,
  kind: string,
  file: string,
  qualifiedName: string,
  start: number,
  end: number,
  parentId: string | null,
  signature?: string,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName,
    displayName: qualifiedName.split(".").at(-1) ?? qualifiedName,
    parentId,
    location: { file, startLine: start, endLine: end },
    ...(signature ? { signature } : {}),
  };
}

function artifact(
  nodes: GraphNode[],
  options: { edges?: GraphEdge[]; extensions?: GraphArtifact["extensions"] } = {},
): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges: options.edges ?? [],
    ...(options.extensions ? { extensions: options.extensions } : {}),
  };
}

function context(changedFiles: ReviewContext["changedFiles"]): ReviewContext {
  return {
    changedFiles,
    baseRef: "main",
    baseSha: "base",
    headRef: "feature",
    reviewKey: "repo|pr-1",
    warnings: [],
  };
}

function deleted(oldLine: number, text = "removed"): ChangedDiffLine {
  return { kind: "deleted", oldLine, newLine: null, beforeNewLine: oldLine, text };
}

function added(newLine: number, text = "added"): ChangedDiffLine {
  return { kind: "added", oldLine: null, newLine, beforeNewLine: newLine, text };
}

function project(
  head: GraphArtifact,
  base: GraphArtifact,
  changedFiles: ReviewContext["changedFiles"],
  prFiles: PrChangedFile[],
) {
  return deriveDeletedNodeProjection({
    headArtifact: head,
    headIndex: buildGraphIndex(head),
    baseArtifact: base,
    baseIndex: buildGraphIndex(base),
    context: context(changedFiles),
    prFiles,
  });
}

describe("deriveDeletedNodeProjection", () => {
  it("keeps exact comparison spans for adjacent surviving declarations", () => {
    const moduleId = "ts:src/boundary.ts";
    const firstId = `${moduleId}#first`;
    const secondId = `${moduleId}#second`;
    const base = artifact([
      node(moduleId, "module", "src/boundary.ts", "src/boundary.ts", 1, 30, null),
      node(firstId, "function", "src/boundary.ts", "first", 10, 12, moduleId),
      node(secondId, "function", "src/boundary.ts", "second", 13, 16, moduleId),
    ]);
    const head = artifact([
      node(moduleId, "module", "src/boundary.ts", "src/boundary.ts", 1, 29, null),
      node(firstId, "function", "src/boundary.ts", "first", 10, 12, moduleId),
      node(secondId, "function", "src/boundary.ts", "second", 13, 15, moduleId),
    ]);

    const result = project(
      head,
      base,
      [{ path: "src/boundary.ts", status: "modified", hunks: [{ start: 13, end: 13 }] }],
      [{
        path: "src/boundary.ts",
        status: "modified",
        additions: 0,
        deletions: 1,
        diffComplete: true,
        diffLines: [deleted(13, "second declaration line")],
      }],
    );

    // The deleted row's HEAD cursor is first.endLine + 1. Exact old-side spans let the renderer
    // attribute it to `second` without guessing from that ambiguous cursor boundary.
    expect(result.baseSpanByHeadId.get(firstId)).toEqual({ start: 10, end: 12 });
    expect(result.baseSpanByHeadId.get(secondId)).toEqual({ start: 13, end: 16 });
  });

  it("projects a deleted method and maps a deletion-only surviving method from authoritative local rows", () => {
    const moduleId = "ts:src/service.ts";
    const classId = `${moduleId}#Service`;
    const deletedId = `${moduleId}#Service.removed`;
    const survivingId = `${moduleId}#Service.keep`;
    const base = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(moduleId, "module", "src/service.ts", "src/service.ts", 1, 50, PACKAGE_ID),
      node(classId, "class", "src/service.ts", "Service", 5, 45, moduleId),
      node(deletedId, "method", "src/service.ts", "Service.removed", 20, 22, classId),
      node(survivingId, "method", "src/service.ts", "Service.keep", 30, 35, classId),
    ]);
    const canonicalRows = [deleted(20), deleted(21), deleted(22), deleted(31), added(31, "replacement")];
    const head = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(moduleId, "module", "src/service.ts", "src/service.ts", 1, 46, PACKAGE_ID),
      node(classId, "class", "src/service.ts", "Service", 5, 41, moduleId),
      node(survivingId, "method", "src/service.ts", "Service.keep", 26, 31, classId),
    ], {
      extensions: {
        changedSince: {
          // Prepared metadata is keyed to the extraction root; the PR path includes its monorepo prefix.
          stats: { "src/service.ts": { added: 1, deleted: 4 } },
          diffLines: { "src/service.ts": canonicalRows },
        },
      } as unknown as GraphArtifact["extensions"],
    });
    const result = project(
      head,
      base,
      [{ path: "packages/app/src/service.ts", status: "modified", hunks: [{ start: 26, end: 31 }] }],
      [{
        path: "packages/app/src/service.ts",
        status: "modified",
        additions: 1,
        deletions: 4,
        // GitHub's patch is partial; the prepared artifact must still win.
        diffComplete: false,
        diffLines: [deleted(20)],
      }],
    );

    expect(result.deletedNodeIds).toEqual(new Set([deletedId]));
    expect(result.baseSourceNodeIds).toEqual(new Set([deletedId]));
    expect(result.survivingAffectedHeadIds).toEqual(new Set([survivingId]));
    expect(result.index.nodesById.get(deletedId)?.parentId).toBe(classId);
    expect(result.affected).toEqual([{
      nodeId: deletedId,
      status: "deleted",
      file: "packages/app/src/service.ts",
      overlapsHunk: true,
    }]);
    expect(result.files[0]).toMatchObject({
      path: "packages/app/src/service.ts",
      basePath: "src/service.ts",
      moduleId,
      diffLines: canonicalRows,
      wholeFileDeleted: false,
    });
    expect(result.files[0].units).toEqual([expect.objectContaining({
      nodeId: deletedId,
      sourceSide: "base",
      basePath: "src/service.ts",
      reviewPath: "packages/app/src/service.ts",
      startLine: 20,
      endLine: 22,
      depth: 1,
    })]);
  });

  it("projects every extracted unit and containment node for a fully removed file without its patch", () => {
    const removedModule = "ts:src/removed.ts";
    const removedClass = `${removedModule}#Removed`;
    const removedMethod = `${removedModule}#Removed.run`;
    const liveModule = "ts:src/live.ts";
    const liveFunction = `${liveModule}#live`;
    const headEdge: GraphEdge = { id: "head-edge", source: liveFunction, target: liveFunction, kind: "calls" };
    const baseEdge: GraphEdge = { id: "base-edge", source: removedMethod, target: liveFunction, kind: "calls" };
    const base = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(removedModule, "module", "src/removed.ts", "src/removed.ts", 1, 30, PACKAGE_ID),
      node(removedClass, "class", "src/removed.ts", "Removed", 2, 28, removedModule),
      node(removedMethod, "method", "src/removed.ts", "Removed.run", 5, 10, removedClass),
      node(liveModule, "module", "src/live.ts", "src/live.ts", 1, 5, PACKAGE_ID),
      node(liveFunction, "function", "src/live.ts", "live", 2, 4, liveModule),
    ], { edges: [baseEdge], extensions: { logicFlow: { [removedMethod]: [] }, baseOnly: true } });
    const head = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(liveModule, "module", "src/live.ts", "src/live.ts", 1, 5, PACKAGE_ID),
      node(liveFunction, "function", "src/live.ts", "live", 2, 4, liveModule),
    ], { edges: [headEdge], extensions: { logicFlow: { [liveFunction]: [] }, headOnly: true } });
    const result = project(
      head,
      base,
      [{ path: "src/removed.ts", status: "deleted" }],
      [{ path: "src/removed.ts", status: "removed", additions: 0, deletions: 30 }],
    );

    expect(result.deletedNodeIds).toEqual(new Set([removedModule, removedClass, removedMethod]));
    expect(result.baseSourceNodeIds).toEqual(new Set([removedModule, removedClass, removedMethod]));
    expect(result.artifact.edges).toBe(head.edges);
    expect(result.artifact.edges).toEqual([headEdge]);
    expect(result.artifact.extensions).toBe(head.extensions);
    expect(result.artifact.extensions).not.toHaveProperty("baseOnly");
    expect(result.files[0]).toMatchObject({
      path: "src/removed.ts",
      basePath: "src/removed.ts",
      moduleId: removedModule,
      diffLines: [],
      wholeFileDeleted: true,
    });
    expect(result.files[0].units.map((unit) => [unit.nodeId, unit.sourceSide])).toEqual([
      [removedClass, "base"],
      [removedMethod, "base"],
    ]);
  });

  it("does not invent tombstones for a pure rename", () => {
    const oldModule = "ts:src/old.ts";
    const oldClass = `${oldModule}#Service`;
    const oldMethod = `${oldModule}#Service.run`;
    const newModule = "ts:src/new.ts";
    const newClass = `${newModule}#Service`;
    const newMethod = `${newModule}#Service.run`;
    const base = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(oldModule, "module", "src/old.ts", "src/old.ts", 1, 20, PACKAGE_ID),
      node(oldClass, "class", "src/old.ts", "Service", 2, 18, oldModule),
      node(oldMethod, "method", "src/old.ts", "Service.run", 5, 10, oldClass),
    ]);
    const head = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(newModule, "module", "src/new.ts", "src/new.ts", 1, 20, PACKAGE_ID),
      node(newClass, "class", "src/new.ts", "Service", 2, 18, newModule),
      node(newMethod, "method", "src/new.ts", "Service.run", 5, 10, newClass),
    ]);
    const headIndex = buildGraphIndex(head);
    const result = deriveDeletedNodeProjection({
      headArtifact: head,
      headIndex,
      baseArtifact: base,
      baseIndex: buildGraphIndex(base),
      context: context([{ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" }]),
      prFiles: [{
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        diffComplete: true,
        diffLines: [],
      }],
    });

    expect(result.artifact).toBe(head);
    expect(result.index).toBe(headIndex);
    expect(result.deletedNodeIds.size).toBe(0);
    expect(result.baseSourceNodeIds.size).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("attaches a deleted declaration from a renamed file to its surviving HEAD container", () => {
    const oldModule = "ts:src/old.ts";
    const oldClass = `${oldModule}#Service`;
    const oldKeep = `${oldModule}#Service.keep`;
    const oldDeleted = `${oldModule}#Service.removed`;
    const newModule = "ts:src/new.ts";
    const newClass = `${newModule}#Service`;
    const newKeep = `${newModule}#Service.keep`;
    const base = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(oldModule, "module", "src/old.ts", "src/old.ts", 1, 40, PACKAGE_ID),
      node(oldClass, "class", "src/old.ts", "Service", 2, 38, oldModule),
      node(oldKeep, "method", "src/old.ts", "Service.keep", 8, 12, oldClass),
      node(oldDeleted, "method", "src/old.ts", "Service.removed", 20, 24, oldClass),
    ]);
    const rows = [deleted(20), deleted(21), deleted(22), deleted(23), deleted(24)];
    const head = artifact([
      node(PACKAGE_ID, "package", "src", "src", 1, 1, null),
      node(newModule, "module", "src/new.ts", "src/new.ts", 1, 35, PACKAGE_ID),
      node(newClass, "class", "src/new.ts", "Service", 2, 33, newModule),
      node(newKeep, "method", "src/new.ts", "Service.keep", 8, 12, newClass),
    ]);
    const result = project(
      head,
      base,
      [{ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", hunks: [{ start: 20, end: 20 }] }],
      [{
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 5,
        diffComplete: true,
        diffLines: rows,
      }],
    );

    expect(result.deletedNodeIds).toEqual(new Set([oldDeleted]));
    expect(result.baseSourceNodeIds).toEqual(new Set([oldDeleted]));
    expect(result.index.nodesById.get(oldDeleted)?.parentId).toBe(newClass);
    expect(result.index.nodesById.has(oldClass)).toBe(false);
    expect(result.index.nodesById.has(oldModule)).toBe(false);
    expect(result.files[0].moduleId).toBe(newModule);
    expect(result.files[0].basePath).toBe("src/old.ts");
  });

  it("fails closed for an incomplete modified patch without authoritative local metadata", () => {
    const moduleId = "ts:src/service.ts";
    const deletedId = `${moduleId}#removed`;
    const base = artifact([
      node(moduleId, "module", "src/service.ts", "src/service.ts", 1, 20, null),
      node(deletedId, "function", "src/service.ts", "removed", 5, 9, moduleId),
    ]);
    const head = artifact([node(moduleId, "module", "src/service.ts", "src/service.ts", 1, 15, null)]);
    const headIndex = buildGraphIndex(head);
    const result = deriveDeletedNodeProjection({
      headArtifact: head,
      headIndex,
      baseArtifact: base,
      baseIndex: buildGraphIndex(base),
      context: context([{ path: "src/service.ts", status: "modified" }]),
      prFiles: [{
        path: "src/service.ts",
        status: "modified",
        additions: 0,
        deletions: 5,
        diffComplete: false,
        oldHunks: [{ start: 5, end: 9 }],
        diffLines: [deleted(5), deleted(6), deleted(7), deleted(8), deleted(9)],
      }],
    });

    expect(result.artifact).toBe(head);
    expect(result.index).toBe(headIndex);
    expect(result.deletedNodeIds.size).toBe(0);
    expect(result.survivingAffectedHeadIds.size).toBe(0);
    expect(result.files).toEqual([]);
  });
});
