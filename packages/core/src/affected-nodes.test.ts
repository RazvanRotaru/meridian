import { describe, expect, it } from "vitest";
import { computeAffectedNodes, unmappedChangedFiles } from "./affected-nodes";
import type { ChangedFile } from "./review";
import type { GraphNode } from "./types";

function node(id: string, file: string, startLine: number, endLine: number, kind = "function"): GraphNode {
  return {
    id,
    kind: kind as GraphNode["kind"],
    qualifiedName: id,
    displayName: id.split("#").pop() ?? id,
    location: { file, startLine, endLine },
  };
}

describe("computeAffectedNodes", () => {
  it("keeps only nodes whose range overlaps a hunk", () => {
    const nodes = [
      node("ts:a.ts#top", "a.ts", 1, 10),
      node("ts:a.ts#middle", "a.ts", 20, 30),
      node("ts:a.ts#bottom", "a.ts", 40, 50),
    ];
    const changed: ChangedFile[] = [{ path: "a.ts", status: "modified", hunks: [{ start: 22, end: 24 }] }];
    const affected = computeAffectedNodes(nodes, changed);
    expect(affected.map((a) => a.nodeId)).toEqual(["ts:a.ts#middle"]);
    expect(affected[0].overlapsHunk).toBe(true);
    expect(affected[0].status).toBe("modified");
  });

  it("treats a file with no hunks as whole-file changed", () => {
    const nodes = [node("ts:a.ts#f", "a.ts", 1, 5), node("ts:a.ts#g", "a.ts", 8, 12)];
    const changed: ChangedFile[] = [{ path: "a.ts", status: "added" }];
    const affected = computeAffectedNodes(nodes, changed);
    expect(affected.map((a) => a.nodeId)).toEqual(["ts:a.ts#f", "ts:a.ts#g"]);
    expect(affected.every((a) => a.overlapsHunk === false)).toBe(true);
  });

  it("uses startLine when endLine is absent", () => {
    const nodes: GraphNode[] = [
      { ...node("ts:a.ts#f", "a.ts", 10, 10), location: { file: "a.ts", startLine: 10 } },
    ];
    const hit: ChangedFile[] = [{ path: "a.ts", status: "modified", hunks: [{ start: 10, end: 10 }] }];
    const miss: ChangedFile[] = [{ path: "a.ts", status: "modified", hunks: [{ start: 11, end: 11 }] }];
    expect(computeAffectedNodes(nodes, hit)).toHaveLength(1);
    expect(computeAffectedNodes(nodes, miss)).toHaveLength(0);
  });

  it("excludes package/module containers and boundary pseudo-nodes", () => {
    const nodes = [
      node("ts:a.ts", "a.ts", 1, 100, "module"),
      node("ts:pkg", "a.ts", 1, 1, "package"),
      node("ext:react#useState", "a.ts", 5, 5),
      node("unresolved:foo#bar", "a.ts", 5, 5),
      node("ts:a.ts#real", "a.ts", 5, 6),
    ];
    const changed: ChangedFile[] = [{ path: "a.ts", status: "modified" }];
    const affected = computeAffectedNodes(nodes, changed);
    expect(affected.map((a) => a.nodeId)).toEqual(["ts:a.ts#real"]);
  });

  it("ignores nodes in unchanged files", () => {
    const nodes = [node("ts:a.ts#f", "a.ts", 1, 5), node("ts:b.ts#g", "b.ts", 1, 5)];
    const changed: ChangedFile[] = [{ path: "a.ts", status: "modified" }];
    expect(computeAffectedNodes(nodes, changed).map((a) => a.nodeId)).toEqual(["ts:a.ts#f"]);
  });

  it("sorts by file then id", () => {
    const nodes = [node("ts:b.ts#z", "b.ts", 1, 2), node("ts:a.ts#y", "a.ts", 1, 2), node("ts:a.ts#x", "a.ts", 1, 2)];
    const changed: ChangedFile[] = [
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "modified" },
    ];
    expect(computeAffectedNodes(nodes, changed).map((a) => a.nodeId)).toEqual(["ts:a.ts#x", "ts:a.ts#y", "ts:b.ts#z"]);
  });
});

describe("unmappedChangedFiles", () => {
  it("reports changed files that produced no affected block", () => {
    const nodes = [node("ts:a.ts#f", "a.ts", 20, 30)];
    const changed: ChangedFile[] = [
      { path: "a.ts", status: "modified", hunks: [{ start: 25, end: 25 }] },
      { path: "gone.ts", status: "deleted" },
      { path: "config.json", status: "modified", hunks: [{ start: 1, end: 1 }] },
    ];
    const affected = computeAffectedNodes(nodes, changed);
    expect(unmappedChangedFiles(affected, changed).map((f) => f.path)).toEqual(["gone.ts", "config.json"]);
  });
});
