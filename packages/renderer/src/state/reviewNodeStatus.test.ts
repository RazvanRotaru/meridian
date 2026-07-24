import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import { reviewNodeChangeStatus, reviewNodeStatusSourcesFromDiff, reviewSourceChangeStatus } from "./reviewNodeStatus";

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

  it("does not treat inherited prototype members as file status sources", () => {
    expect(reviewSourceChangeStatus({ file: "constructor", line: 1 }, {})).toBeUndefined();
    expect(reviewSourceChangeStatus({ file: "__proto__", line: 1 }, {})).toBeUndefined();
  });
});

describe("reviewNodeStatusSourcesFromDiff", () => {
  it("creates a graph-only deletion seam without adding a displayed HEAD deletion kind", () => {
    expect(reviewNodeStatusSourcesFromDiff({}, {
      "src/settings.ts": [{ kind: "deleted", oldLine: 42, newLine: null, beforeNewLine: 42, text: "gone();" }],
    })).toEqual({
      "src/settings.ts": { kinds: [{ start: 42, end: 42, kind: "deleted" }] },
    });
  });

  it("keeps slash and literal-backslash files as independent exact sources", () => {
    const sources = reviewNodeStatusSourcesFromDiff({
      "src/a\\b.ts": [{ start: 4, end: 4, kind: "added" }],
      "src/a/b.ts": [{ start: 4, end: 4, kind: "deleted" }],
    }, null);

    expect(reviewSourceChangeStatus({ file: "src/a\\b.ts", line: 4 }, sources)).toBe("added");
    expect(reviewSourceChangeStatus({ file: "src/a/b.ts", line: 4 }, sources)).toBe("deleted");
  });

  it("stores prototype-named files as ordinary own keys", () => {
    const kinds = {} as Record<string, [{ start: number; end: number; kind: "added" }]>;
    Object.defineProperty(kinds, "constructor", {
      value: [{ start: 1, end: 1, kind: "added" }],
      enumerable: true,
    });
    Object.defineProperty(kinds, "__proto__", {
      value: [{ start: 2, end: 2, kind: "added" }],
      enumerable: true,
    });
    const sources = reviewNodeStatusSourcesFromDiff(kinds, null);

    expect(reviewSourceChangeStatus({ file: "constructor", line: 1 }, sources)).toBe("added");
    expect(reviewSourceChangeStatus({ file: "__proto__", line: 2 }, sources)).toBe("added");
  });
});
