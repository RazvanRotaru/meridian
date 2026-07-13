import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import { reviewNodeChangeStatus, reviewSourceChangeStatus } from "./reviewNodeStatus";

function node(id: string, start: number, end: number, parentId?: string): GraphNode {
  return {
    id,
    kind: parentId ? "function" : "class",
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: "src/settings.ts", startLine: start, endLine: end },
  };
}

describe("reviewNodeChangeStatus", () => {
  it("marks an additions-only function green even when its file is modified", () => {
    const addedFunction = node("ts:src/settings.ts#logPatchFailure", 303, 310, "ts:src/settings.ts");

    expect(reviewNodeChangeStatus(addedFunction, [], "modified", {
      kinds: [{ start: 303, end: 310, kind: "added" }],
    })).toBe("added");
  });

  it("keeps replacements and mixed line kinds gold", () => {
    const changedFunction = node("ts:src/settings.ts#save", 20, 30, "ts:src/settings.ts");

    expect(reviewNodeChangeStatus(changedFunction, [], "modified", {
      kinds: [
        { start: 21, end: 21, kind: "added" },
        { start: 25, end: 25, kind: "modified" },
      ],
    })).toBe("modified");
  });

  it("maps base-graph spans into head coordinates before classifying", () => {
    const shiftedFunction = node("ts:src/settings.ts#save", 20, 24, "ts:src/settings.ts");

    expect(reviewNodeChangeStatus(shiftedFunction, [], "modified", {
      edits: [{ oldStart: 5, oldLines: 0, newStart: 5, newLines: 3 }],
      kinds: [{ start: 23, end: 24, kind: "added" }],
    })).toBe("added");
  });

  it("ignores child changes when classifying a directly changed container", () => {
    const container = node("ts:src/settings.ts#Settings", 1, 30);
    const child = node("ts:src/settings.ts#Settings.save", 10, 20, container.id);

    expect(reviewNodeChangeStatus(container, [child], "modified", {
      kinds: [
        { start: 2, end: 2, kind: "added" },
        { start: 12, end: 12, kind: "modified" },
      ],
    })).toBe("added");
  });

  it("falls back to the file status when exact kinds do not touch the node", () => {
    const changedFunction = node("ts:src/settings.ts#save", 20, 30, "ts:src/settings.ts");

    expect(reviewNodeChangeStatus(changedFunction, [], "renamed", {
      kinds: [{ start: 40, end: 41, kind: "added" }],
    })).toBe("renamed");
  });
});

describe("reviewSourceChangeStatus", () => {
  it("classifies a flow step from its own source line instead of its callee", () => {
    expect(reviewSourceChangeStatus({ file: "src/settings.ts", line: 42 }, {
      "src/settings.ts": { kinds: [{ start: 42, end: 42, kind: "added" }] },
    })).toBe("added");
    expect(reviewSourceChangeStatus({ file: "src/settings.ts", line: 43 }, {
      "src/settings.ts": { kinds: [{ start: 42, end: 42, kind: "added" }] },
    })).toBeUndefined();
  });

  it("maps a base-graph source anchor to the PR head before classifying", () => {
    expect(reviewSourceChangeStatus({ file: "src/settings.ts", line: 20 }, {
      "src/settings.ts": {
        edits: [{ oldStart: 5, oldLines: 0, newStart: 5, newLines: 3 }],
        kinds: [{ start: 23, end: 23, kind: "deleted" }],
      },
    })).toBe("deleted");
  });
});
