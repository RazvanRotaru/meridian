import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { groupDefinitions } from "./deriveLogicLayout";

/** A GraphIndex stub covering what groupDefinitions/collectModuleDefinitions touch:
 * nodesById, parentOf, and childrenOf (walked recursively to collect callables). */
function makeIndex(entries: Array<{ id: string; name: string; kind: string; parentId: string | null }>): GraphIndex {
  const nodesById = new Map<string, GraphNode>(
    entries.map((e) => [
      e.id,
      { id: e.id, kind: e.kind, displayName: e.name, qualifiedName: e.name, parentId: e.parentId, location: { file: "", startLine: 1 } } as GraphNode,
    ]),
  );
  const parentOf = new Map<string, string | null>(entries.map((e) => [e.id, e.parentId]));
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const e of entries) {
    if (e.parentId === null) continue;
    childrenByParent.set(e.parentId, [...(childrenByParent.get(e.parentId) ?? []), nodesById.get(e.id)!]);
  }
  const childrenOf = (id: string): GraphNode[] => childrenByParent.get(id) ?? [];
  return { nodesById, parentOf, childrenOf } as unknown as GraphIndex;
}

const MODULE = "ts:m.ts";

describe("groupDefinitions", () => {
  it("groups callables by owner: object/class frames (label-sorted) first, functions last", () => {
    const index = makeIndex([
      { id: MODULE, name: "m.ts", kind: "module", parentId: null },
      { id: "ts:m.ts#aObj", name: "aObj", kind: "object", parentId: MODULE },
      { id: "ts:m.ts#aObj.foo", name: "foo", kind: "method", parentId: "ts:m.ts#aObj" },
      { id: "ts:m.ts#bClass", name: "bClass", kind: "class", parentId: MODULE },
      { id: "ts:m.ts#bClass.bar", name: "bar", kind: "method", parentId: "ts:m.ts#bClass" },
      { id: "ts:m.ts#run", name: "run", kind: "function", parentId: MODULE },
      { id: "ts:m.ts#boot", name: "boot", kind: "function", parentId: MODULE },
    ]);
    const groups = groupDefinitions(index, MODULE);
    // Owner groups first (aObj < bClass by label), the top-level functions bucket last.
    expect(groups.map((g) => g.label)).toEqual(["aObj", "bClass", "functions"]);
    expect(groups.map((g) => g.kind)).toEqual(["object", "class", "module"]);
    expect(groups[2].parentId).toBe(MODULE);
    expect(groups[0].defIds).toEqual(["ts:m.ts#aObj.foo"]);
    // Within a group, collectModuleDefinitions' display-name order is preserved (boot < run).
    expect(groups[2].defIds).toEqual(["ts:m.ts#boot", "ts:m.ts#run"]);
  });

  it("returns a single functions group for a module of only top-level functions", () => {
    const index = makeIndex([
      { id: MODULE, name: "m.ts", kind: "module", parentId: null },
      { id: "ts:m.ts#run", name: "run", kind: "function", parentId: MODULE },
    ]);
    expect(groupDefinitions(index, MODULE)).toEqual([
      { parentId: MODULE, label: "functions", kind: "module", defIds: ["ts:m.ts#run"] },
    ]);
  });

  it("is empty for a module with no defined callables", () => {
    const index = makeIndex([{ id: MODULE, name: "m.ts", kind: "module", parentId: null }]);
    expect(groupDefinitions(index, MODULE)).toEqual([]);
  });
});
