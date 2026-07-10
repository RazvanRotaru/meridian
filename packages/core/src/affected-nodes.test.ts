import { describe, expect, it } from "vitest";
import { computeAffectedNodes, unmappedChangedFiles } from "./affected-nodes";
import type { ChangedFile, GraphNode } from "./index";

function node(id: string, kind: string, file: string, parentId?: string, lines?: { start: number; end: number | undefined }): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: lines?.start ?? 1, endLine: lines?.end },
  };
}

const PACKAGE = node("ts:src", "package", "src");
const MODULE = node("ts:src/a.ts", "module", "src/a.ts", PACKAGE.id, { start: 1, end: 40 });
const SVC = node("ts:src/a.ts#Svc", "class", "src/a.ts", MODULE.id, { start: 3, end: 20 });
const RUN = node("ts:src/a.ts#Svc.run", "method", "src/a.ts", SVC.id, { start: 10, end: 12 });
const STOP = node("ts:src/a.ts#Svc.stop", "method", "src/a.ts", SVC.id, { start: 14, end: 18 });
const HELPER = node("ts:src/a.ts#helper", "function", "src/a.ts", MODULE.id, { start: 25, end: 30 });
const NODES = [PACKAGE, MODULE, SVC, RUN, STOP, HELPER];

function modified(path: string, hunks?: { start: number; end: number }[]): ChangedFile {
  return hunks === undefined ? { path, status: "modified" } : { path, status: "modified", hunks };
}

function affectedIds(nodes: readonly GraphNode[], files: readonly ChangedFile[]): string[] {
  return computeAffectedNodes(nodes, files).map((entry) => entry.nodeId);
}

describe("computeAffectedNodes", () => {
  it("marks only the overlapped leaf: the sibling method and the containing class stay unmarked", () => {
    const ids = affectedIds(NODES, [modified("src/a.ts", [{ start: 10, end: 11 }])]);
    expect(ids).toEqual([RUN.id]);
  });

  it("marks a container whose own declaration line changed with no child overlap", () => {
    const ids = affectedIds(NODES, [modified("src/a.ts", [{ start: 3, end: 3 }])]);
    expect(ids).toEqual([SVC.id]);
  });

  it("marks BOTH container and leaf when one hunk spans the declaration and a method body", () => {
    const ids = affectedIds(NODES, [modified("src/a.ts", [{ start: 3, end: 11 }])]);
    expect(ids).toEqual([SVC.id, RUN.id].sort());
  });

  it("falls back to the module node ONLY for a hunk-less changed file", () => {
    const affected = computeAffectedNodes(NODES, [modified("src/a.ts")]);
    expect(affected.map((entry) => entry.nodeId)).toEqual([MODULE.id]);
    expect(affected[0].overlapsHunk).toBe(false);
  });

  it("treats a missing endLine as a single-line span", () => {
    const single = node("ts:src/b.ts#g", "function", "src/b.ts", undefined, { start: 5, end: undefined });
    expect(affectedIds([single], [modified("src/b.ts", [{ start: 5, end: 5 }])])).toEqual([single.id]);
    expect(affectedIds([single], [modified("src/b.ts", [{ start: 6, end: 9 }])])).toEqual([]);
  });

  it("preserves the file status and flags real hunk overlap on each affected node", () => {
    const added: ChangedFile = { path: "src/a.ts", status: "added", hunks: [{ start: 25, end: 26 }] };
    const affected = computeAffectedNodes(NODES, [added]);
    expect(affected).toEqual([{ nodeId: HELPER.id, status: "added", file: "src/a.ts", overlapsHunk: true }]);
  });

  it("never marks ext:/unresolved: pseudo-nodes or packages", () => {
    const pseudo = node("ext:src/a.ts#x", "function", "src/a.ts", undefined, { start: 1, end: 40 });
    const ids = affectedIds([PACKAGE, pseudo], [modified("src/a.ts", [{ start: 1, end: 40 }]), modified("src")]);
    expect(ids).toEqual([]);
  });
});

describe("unmappedChangedFiles", () => {
  it("lists changed files that produced no affected node", () => {
    const files = [modified("src/a.ts", [{ start: 10, end: 11 }]), modified("docs/readme.md", [{ start: 1, end: 1 }])];
    const affected = computeAffectedNodes(NODES, files);
    expect(unmappedChangedFiles(affected, files).map((file) => file.path)).toEqual(["docs/readme.md"]);
  });
});
