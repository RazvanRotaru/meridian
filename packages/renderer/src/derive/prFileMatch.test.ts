import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import { matchPrFilesToModules } from "./prFileMatch";
import type { PrChangedFile } from "../state/prTypes";

function node(id: string, kind: string, file: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, location: { file, startLine: 1 } };
}

const NODES: GraphNode[] = [
  node("pkg", "package", "packages/app"),
  node("short", "module", "src/button.tsx"),
  node("long", "module", "packages/app/src/button.tsx"),
  node("other", "module", "src/other.ts"),
  node("callable", "function", "packages/app/src/button.tsx"),
];

function file(path: string, status: PrChangedFile["status"] = "modified"): PrChangedFile {
  return { path, status, additions: 0, deletions: 0 };
}

describe("matchPrFilesToModules", () => {
  it("prefers an exact module location match", () => {
    expect(matchPrFilesToModules([file("src/button.tsx")], NODES)).toEqual([
      { path: "src/button.tsx", status: "modified", moduleId: "short", moduleFile: "src/button.tsx" },
    ]);
  });

  it("falls back to slash-boundary suffix matches", () => {
    expect(matchPrFilesToModules([file("repo/packages/app/src/other.ts")], NODES)).toEqual([
      { path: "repo/packages/app/src/other.ts", status: "modified", moduleId: "other", moduleFile: "src/other.ts" },
    ]);
  });

  it("chooses the longest module location for suffix matches", () => {
    expect(matchPrFilesToModules([file("repo/packages/app/src/button.tsx")], NODES)).toEqual([
      {
        path: "repo/packages/app/src/button.tsx",
        status: "modified",
        moduleId: "long",
        moduleFile: "packages/app/src/button.tsx",
      },
    ]);
  });

  it("does not match a non-boundary suffix", () => {
    expect(matchPrFilesToModules([file("repo/packages/app/src/mybutton.tsx")], NODES)).toEqual([]);
  });

  it("returns no match for removed files absent from the graph", () => {
    expect(matchPrFilesToModules([file("src/deleted.ts", "removed")], NODES)).toEqual([]);
  });
});
