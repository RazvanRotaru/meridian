import { describe, expect, it } from "vitest";
import {
  changedDiffLinesFromExtensions,
  changedFileManifestFromExtensions,
  changedLineDeltaForNode,
  changedLineKindsFromExtensions,
  changedLineKindsWithin,
  changedLineStatsFromExtensions,
  changedLinesWithin,
  changedRangesFromExtensions,
  collectChangedIds,
  tagChangedNodes,
} from "./changed-detection";
import type { ChangedLineKinds, ChangedLineStats, ChangedRanges, GraphNode } from "./index";

function node(id: string, kind: string, file: string, startLine: number, endLine?: number): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, location: { file, startLine, endLine } };
}

const MODULE = node("ts:src/a.ts", "module", "src/a.ts", 1, 40);
const ALPHA = node("ts:src/a.ts#alpha", "function", "src/a.ts", 3, 10);
const BETA = node("ts:src/a.ts#beta", "function", "src/a.ts", 12, 20);
const OTHER = node("ts:src/b.ts#gamma", "function", "src/b.ts", 1, 5);

describe("tagChangedNodes", () => {
  it("tags only the declarations whose span overlaps a changed range", () => {
    const changed: ChangedRanges = { "src/a.ts": [{ start: 5, end: 6 }] };
    const tagged = tagChangedNodes([MODULE, ALPHA, BETA, OTHER], changed);
    expect(collectChangedIds(tagged)).toEqual(new Set(["ts:src/a.ts#alpha"]));
  });

  it("treats range/span touching at a boundary line as overlap", () => {
    const changed: ChangedRanges = { "src/a.ts": [{ start: 10, end: 12 }] };
    const tagged = tagChangedNodes([MODULE, ALPHA, BETA], changed);
    expect(collectChangedIds(tagged)).toEqual(new Set(["ts:src/a.ts#alpha", "ts:src/a.ts#beta"]));
  });

  it("falls back to the module when a file's change touches no declaration", () => {
    const changed: ChangedRanges = { "src/a.ts": [{ start: 1, end: 1 }] }; // an import line
    const tagged = tagChangedNodes([MODULE, ALPHA, BETA], changed);
    expect(collectChangedIds(tagged)).toEqual(new Set(["ts:src/a.ts"]));
  });

  it("never tags the module when a declaration already absorbed the change", () => {
    const changed: ChangedRanges = { "src/a.ts": [{ start: 4, end: 4 }] };
    const tagged = tagChangedNodes([MODULE, ALPHA], changed);
    expect(collectChangedIds(tagged)).toEqual(new Set(["ts:src/a.ts#alpha"]));
  });

  it("leaves untouched nodes as the same references and is idempotent on re-tagging", () => {
    const changed: ChangedRanges = { "src/a.ts": [{ start: 4, end: 4 }] };
    const once = tagChangedNodes([MODULE, ALPHA, BETA], changed);
    expect(once[0]).toBe(MODULE);
    expect(once[2]).toBe(BETA);
    const twice = tagChangedNodes(once, changed);
    expect(twice[1].tags).toEqual(ALPHA.tags ? [...ALPHA.tags, "changed"] : ["changed"]);
  });

  it("matches windows-style artifact paths against forward-slash diff paths", () => {
    const winNode = node("ts:src/win.ts#f", "function", "src\\win.ts", 2, 3);
    const tagged = tagChangedNodes([winNode], { "src/win.ts": [{ start: 2, end: 2 }] });
    expect(collectChangedIds(tagged)).toEqual(new Set(["ts:src/win.ts#f"]));
  });

  it("returns everything unchanged for an empty diff", () => {
    const nodes = [MODULE, ALPHA];
    expect(tagChangedNodes(nodes, {})).toEqual(nodes);
  });
});

describe("changedFileManifestFromExtensions", () => {
  it("round-trips the complete file manifest, including a rename's base path", () => {
    const manifest = [
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      { path: "assets/logo.png", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
      { path: "src/new-file.ts", status: "added" },
    ];

    expect(changedFileManifestFromExtensions({ changedSince: { manifest } })).toEqual(manifest);
    expect(changedFileManifestFromExtensions({ changedSince: { manifest: [] } })).toEqual([]);
  });

  it("fails the whole manifest closed on malformed, duplicate, or inconsistent entries", () => {
    expect(changedFileManifestFromExtensions(undefined)).toBeNull();
    expect(changedFileManifestFromExtensions({ changedSince: { manifest: {} } })).toBeNull();
    expect(changedFileManifestFromExtensions({
      changedSince: { manifest: [{ path: "src/a.ts", status: "renamed" }] },
    })).toBeNull();
    expect(changedFileManifestFromExtensions({
      changedSince: { manifest: [{ path: "src/a.ts", status: "modified", previousPath: "src/old.ts" }] },
    })).toBeNull();
    expect(changedFileManifestFromExtensions({
      changedSince: {
        manifest: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/a.ts", status: "deleted" },
        ],
      },
    })).toBeNull();
    expect(changedFileManifestFromExtensions({
      changedSince: { manifest: [{ path: "bad\0path.ts", status: "added" }] },
    })).toBeNull();
    for (const path of ["/absolute.ts", "C:/absolute.ts", "../escape.ts", "src/../escape.ts", "src\\win.ts", "src//a.ts", "./src/a.ts"]) {
      expect(changedFileManifestFromExtensions({
        changedSince: { manifest: [{ path, status: "modified" }] },
      })).toBeNull();
    }
  });
});

describe("changedRangesFromExtensions", () => {
  it("round-trips the shape the CLI persists", () => {
    const extensions = { changedSince: { baseRef: "main", files: { "src/a.ts": [{ start: 3, end: 5 }] } } };
    expect(changedRangesFromExtensions(extensions)).toEqual({ "src/a.ts": [{ start: 3, end: 5 }] });
  });

  it("yields null without the extension and skips malformed entries instead of throwing", () => {
    expect(changedRangesFromExtensions(undefined)).toBeNull();
    expect(changedRangesFromExtensions({ changedSince: { baseRef: "main" } })).toBeNull();
    expect(changedRangesFromExtensions({ changedSince: { files: "junk" } })).toBeNull();
    const mixed = { changedSince: { files: { "a.ts": [{ start: 1, end: 2 }, { start: "x" }, null], "b.ts": 7 } } };
    expect(changedRangesFromExtensions(mixed)).toEqual({ "a.ts": [{ start: 1, end: 2 }] });
  });
});

describe("changedLineStatsFromExtensions", () => {
  it("round-trips file add/delete counts", () => {
    const extensions = {
      changedSince: {
        baseRef: "main",
        stats: {
          "src/a.ts": { added: 12, deleted: 4 },
        },
      },
    };
    expect(changedLineStatsFromExtensions(extensions)).toEqual({ "src/a.ts": { added: 12, deleted: 4 } });
  });

  it("yields null without stats and skips malformed entries", () => {
    expect(changedLineStatsFromExtensions(undefined)).toBeNull();
    expect(changedLineStatsFromExtensions({ changedSince: { files: {} } })).toBeNull();
    const mixed = {
      changedSince: {
        stats: {
          "src/a.ts": { added: 1, deleted: 0 },
          "src/b.ts": { added: -2, deleted: 0 },
          "src/c.ts": { added: "x", deleted: 1 },
        },
      },
    };
    expect(changedLineStatsFromExtensions(mixed)).toEqual({ "src/a.ts": { added: 1, deleted: 0 } });
  });
});

describe("changedLineKindsFromExtensions", () => {
  it("round-trips per-line kinds and normalizes file separators", () => {
    const extensions = {
      changedSince: {
        kinds: {
          "src\\a.ts": [{ start: 12, end: 14, kind: "added" }],
        },
      },
    };
    expect(changedLineKindsFromExtensions(extensions)).toEqual({
      "src/a.ts": [{ start: 12, end: 14, kind: "added" }],
    });
  });

  it("yields null without kinds and skips malformed entries", () => {
    expect(changedLineKindsFromExtensions(undefined)).toBeNull();
    expect(changedLineKindsFromExtensions({ changedSince: { files: {} } })).toBeNull();
    const mixed = {
      changedSince: {
        kinds: {
          "src/a.ts": [{ start: 1, end: 1, kind: "added" }, { start: 2, end: 2, kind: "x" }],
          "src/b.ts": "junk",
        },
      },
    };
    expect(changedLineKindsFromExtensions(mixed)).toEqual({
      "src/a.ts": [{ start: 1, end: 1, kind: "added" }],
    });
  });
});

describe("changedDiffLinesFromExtensions", () => {
  it("round-trips exact ordered add/delete rows and normalizes file separators", () => {
    const extensions = {
      changedSince: {
        diffLines: {
          "src\\a.ts": [
            { kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 4, text: "old", noNewline: true },
            { kind: "added", oldLine: null, newLine: 4, beforeNewLine: 4, text: "new" },
          ],
        },
      },
    };
    expect(changedDiffLinesFromExtensions(extensions)).toEqual({
      "src/a.ts": [
        { kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 4, text: "old", noNewline: true },
        { kind: "added", oldLine: null, newLine: 4, beforeNewLine: 4, text: "new" },
      ],
    });
  });

  it("yields null without diffLines and skips malformed rows and entries", () => {
    expect(changedDiffLinesFromExtensions(undefined)).toBeNull();
    expect(changedDiffLinesFromExtensions({ changedSince: { files: {} } })).toBeNull();
    const mixed = {
      changedSince: {
        diffLines: {
          "src/a.ts": [
            { kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "ok" },
            { kind: "deleted", oldLine: null, newLine: null, beforeNewLine: 1, text: "bad" },
            { kind: "added", oldLine: null, newLine: 0, beforeNewLine: 0, text: "bad" },
            { kind: "added", oldLine: null, newLine: 2, beforeNewLine: 3, text: "bad" },
            { kind: "added", oldLine: null, newLine: 3, beforeNewLine: 3, text: "bad", noNewline: "yes" },
          ],
          "src/b.ts": "junk",
        },
      },
    };
    expect(changedDiffLinesFromExtensions(mixed)).toEqual({
      "src/a.ts": [{ kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "ok" }],
    });
  });
});

describe("changedLineDeltaForNode", () => {
  it("returns the node file's line delta with normalized separators", () => {
    const stats: ChangedLineStats = { "src/a.ts": { added: 7, deleted: 3 } };
    const posix = node("ts:src/a.ts#f", "function", "src/a.ts", 1, 1);
    const windows = node("ts:src/a.ts#g", "function", "src\\a.ts", 2, 2);
    expect(changedLineDeltaForNode(stats, posix)).toEqual({ added: 7, deleted: 3 });
    expect(changedLineDeltaForNode(stats, windows)).toEqual({ added: 7, deleted: 3 });
  });
});

describe("changedLinesWithin", () => {
  const ranges: ChangedRanges = { "src/a.ts": [{ start: 4, end: 6 }, { start: 30, end: 31 }] };

  it("intersects the file's ranges with the node span", () => {
    expect(changedLinesWithin(ranges, "src/a.ts", 5, 30)).toEqual(new Set([5, 6, 30]));
  });

  it("is empty for an untouched file and treats a missing endLine as a one-line span", () => {
    expect(changedLinesWithin(ranges, "src/b.ts", 1, 99).size).toBe(0);
    expect(changedLinesWithin(ranges, "src/a.ts", 4, undefined)).toEqual(new Set([4]));
  });

  it("normalizes windows-style node paths to the diff's forward slashes", () => {
    expect(changedLinesWithin(ranges, "src\\a.ts", 4, 4)).toEqual(new Set([4]));
  });
});

describe("changedLineKindsWithin", () => {
  const kinds: ChangedLineKinds = {
    "src/a.ts": [
      { start: 4, end: 4, kind: "added" },
      { start: 5, end: 6, kind: "modified" },
      { start: 6, end: 7, kind: "deleted" },
    ],
  };

  it("returns per-line kinds intersected with a node span", () => {
    expect(changedLineKindsWithin(kinds, "src/a.ts", 4, 6)).toEqual(
      new Map([
        [4, "added"],
        [5, "modified"],
        [6, "deleted"],
      ]),
    );
  });

  it("normalizes windows paths and uses deleted > modified > added precedence", () => {
    expect(changedLineKindsWithin(kinds, "src\\a.ts", 6, 6)).toEqual(new Map([[6, "deleted"]]));
  });
});
