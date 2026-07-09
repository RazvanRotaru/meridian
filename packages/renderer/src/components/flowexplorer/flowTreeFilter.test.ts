import { describe, expect, it } from "vitest";
import type { FlowTreeEntry } from "../../derive/flowTree";
import { filterFlowTree } from "./flowTreeFilter";

const TREE: FlowTreeEntry[] = [
  {
    id: "pkg",
    kind: "container",
    label: "pkg",
    flowRootId: null,
    children: [
      {
        id: "module",
        kind: "module",
        label: "service.ts",
        flowRootId: null,
        children: [
          { id: "run", kind: "callable", label: "runCheckout", flowRootId: "run", children: [] },
          { id: "save", kind: "callable", label: "saveDraft", flowRootId: "save", children: [] },
        ],
      },
    ],
  },
];

describe("filterFlowTree", () => {
  it("returns the original tree for a blank query", () => {
    expect(filterFlowTree(TREE, " ")).toBe(TREE);
  });

  it("keeps matching entries and their ancestors visible", () => {
    const filtered = filterFlowTree(TREE, "checkout");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].children[0].children.map((entry) => entry.label)).toEqual(["runCheckout"]);
  });
});
