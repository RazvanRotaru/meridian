import { describe, expect, it } from "vitest";
import type { FlowTreeEntry } from "../../derive/flowTree";
import { blockOpenKeysForSelection, entryOpenKeysForSelection, withOpenKeys } from "./flowTreeOpenState";

const TREE: FlowTreeEntry[] = [
  {
    id: "pkg/src",
    kind: "container",
    label: "pkg/src",
    flowRootId: null,
    children: [
      {
        id: "module",
        kind: "module",
        label: "service.ts",
        flowRootId: null,
        children: [
          { id: "run", kind: "callable", label: "run", flowRootId: "run", children: [] },
        ],
      },
    ],
  },
];

describe("flow tree open state", () => {
  it("opens the stable tree entry for a selected flow root", () => {
    expect(entryOpenKeysForSelection(TREE, { rootId: "run", blockPath: [] })).toEqual(["run"]);
  });

  it("opens every selected block ancestor key", () => {
    expect(blockOpenKeysForSelection({ rootId: "run", blockPath: [{ step: 2 }, { step: 4, path: 1 }] })).toEqual([
      "run@2",
      "run@2.4-1",
    ]);
  });

  it("preserves the same set when all open keys are already present", () => {
    const current = new Set(["run"]);
    expect(withOpenKeys(current, ["run"])).toBe(current);
    expect(withOpenKeys(current, ["run", "run@2"])).toEqual(new Set(["run", "run@2"]));
  });
});
