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
  formattingOnlyEditsFromExtensions,
  tagChangedNodes,
} from "./changed-detection";
import type {
  ChangedLineKinds,
  ChangedLineStats,
  ChangedRanges,
  FormattingOnlyEdit,
  GraphNode,
} from "./index";

function node(id: string, kind: string, file: string, startLine: number, endLine?: number): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, location: { file, startLine, endLine } };
}

const MODULE = node("ts:src/a.ts", "module", "src/a.ts", 1, 40);
const ALPHA = node("ts:src/a.ts#alpha", "function", "src/a.ts", 3, 10);
const BETA = node("ts:src/a.ts#beta", "function", "src/a.ts", 12, 20);
const OTHER = node("ts:src/b.ts#gamma", "function", "src/b.ts", 1, 5);

function formattingEdit(
  path: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): FormattingOnlyEdit {
  return {
    path,
    oldStart,
    oldLines,
    newStart,
    newLines,
    oldRows: Array.from({ length: oldLines }, (_, index) => ({
      text: `old ${oldStart + index}`,
      noNewline: false,
    })),
    newRows: Array.from({ length: newLines }, (_, index) => ({
      text: `new ${newStart + index}`,
      noNewline: false,
    })),
  };
}

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

  it("does not conflate a literal-backslash node path with slash-keyed diff metadata", () => {
    const winNode = node("ts:src/win.ts#f", "function", "src\\win.ts", 2, 3);
    const tagged = tagChangedNodes([winNode], { "src/win.ts": [{ start: 2, end: 2 }] });
    expect(collectChangedIds(tagged)).toEqual(new Set());
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
    for (const path of ["/absolute.ts", "../escape.ts", "src/../escape.ts", "src//a.ts", "./src/a.ts"]) {
      expect(changedFileManifestFromExtensions({
        changedSince: { manifest: [{ path, status: "modified" }] },
      })).toBeNull();
    }
    for (const path of ["C:/literal.ts", "src\\literal.ts"]) {
      expect(changedFileManifestFromExtensions({
        changedSince: { manifest: [{ path, status: "modified" }] },
      })).toEqual([{ path, status: "modified" }]);
    }
  });
});

describe("formattingOnlyEditsFromExtensions", () => {
  const manifest = [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "modified" },
  ];

  it("groups one canonical v1 proof transaction by exact file path", () => {
    const first = formattingEdit("src/a.ts", 10, 1, 10, 5);
    first.newRows[4].noNewline = true;
    const second = formattingEdit("src/a.ts", 30, 2, 34, 2);
    const third = formattingEdit("src/b.ts", 4, 1, 4, 1);
    const extensions = {
      changedSince: {
        manifest,
        formattingOnly: {
          version: 1,
          edits: [first, second, third],
        },
      },
    };

    expect(formattingOnlyEditsFromExtensions(extensions)).toEqual({
      "src/a.ts": [first, second],
      "src/b.ts": [third],
    });
  });

  it("accepts an empty proof but fails open on unknown, partial, or risky proof data", () => {
    expect(formattingOnlyEditsFromExtensions({
      changedSince: { manifest, formattingOnly: { version: 1, edits: [] } },
    })).toEqual({});

    for (const formattingOnly of [
      undefined,
      { version: 2, edits: [] },
      { version: 1 },
      { version: 1, edits: [], extra: true },
      { version: 1, edits: [{ path: "src/a.ts", oldStart: 1, oldLines: 0, newStart: 1, newLines: 0 }] },
      { version: 1, edits: [{ path: "../a.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
      { version: 1, edits: [{ path: "src/a.ts", oldStart: 0, oldLines: 1, newStart: 1, newLines: 1 }] },
      {
        version: 1,
        edits: [{ path: "src/a.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, extra: true }],
      },
    ]) {
      expect(formattingOnlyEditsFromExtensions({
        changedSince: { manifest, formattingOnly },
      })).toBeNull();
    }
  });

  it("rejects incomplete, malformed, or unbounded exact row bindings", () => {
    const valid = formattingEdit("src/a.ts", 1, 1, 1, 1);
    for (const edit of [
      { ...valid, oldRows: [] },
      { ...valid, newRows: [{ text: "new\nrow", noNewline: false }] },
      { ...valid, newRows: [{ text: "new", noNewline: "no" }] },
      { ...valid, newRows: [{ text: "new", noNewline: false, extra: true }] },
    ]) {
      expect(formattingOnlyEditsFromExtensions({
        changedSince: { manifest, formattingOnly: { version: 1, edits: [edit] } },
      })).toBeNull();
    }

    const tooManyForOneFile = Array.from({ length: 65 }, (_, index) =>
      formattingEdit("src/a.ts", index * 2 + 1, 1, index * 2 + 1, 1)
    );
    expect(formattingOnlyEditsFromExtensions({
      changedSince: {
        manifest,
        formattingOnly: { version: 1, edits: tooManyForOneFile },
      },
    })).toBeNull();
  });

  it("rejects stale paths, non-modified files, noncanonical order, duplicates, and overlap", () => {
    const edit = formattingEdit("src/a.ts", 10, 1, 10, 5);
    for (const [candidateManifest, edits] of [
      [manifest, [{ ...edit, path: "src/missing.ts" }]],
      [[{ path: "src/a.ts", status: "renamed", previousPath: "src/old.ts" }], [edit]],
      [manifest, [{ ...edit, path: "src/b.ts" }, edit]],
      [manifest, [edit, edit]],
      [manifest, [edit, formattingEdit("src/a.ts", 10, 1, 14, 1)]],
    ] as const) {
      expect(formattingOnlyEditsFromExtensions({
        changedSince: {
          manifest: candidateManifest,
          formattingOnly: { version: 1, edits },
        },
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
  it("round-trips per-line kinds without collapsing literal backslashes", () => {
    const extensions = {
      changedSince: {
        kinds: {
          "src\\a.ts": [{ start: 12, end: 14, kind: "added" }],
        },
      },
    };
    expect(changedLineKindsFromExtensions(extensions)).toEqual({
      "src\\a.ts": [{ start: 12, end: 14, kind: "added" }],
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
  it("round-trips exact ordered add/delete rows without collapsing literal backslashes", () => {
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
      "src\\a.ts": [
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
  it("returns only the node file's exact line delta", () => {
    const stats: ChangedLineStats = { "src/a.ts": { added: 7, deleted: 3 } };
    const posix = node("ts:src/a.ts#f", "function", "src/a.ts", 1, 1);
    const windows = node("ts:src/a.ts#g", "function", "src\\a.ts", 2, 2);
    expect(changedLineDeltaForNode(stats, posix)).toEqual({ added: 7, deleted: 3 });
    expect(changedLineDeltaForNode(stats, windows)).toBeNull();
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

  it("does not borrow a slash sibling's ranges for a literal-backslash path", () => {
    expect(changedLinesWithin(ranges, "src\\a.ts", 4, 4)).toEqual(new Set());
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

  it("keeps literal-backslash files separate while using deleted > modified > added precedence", () => {
    expect(changedLineKindsWithin(kinds, "src\\a.ts", 6, 6)).toEqual(new Map());
    expect(changedLineKindsWithin(kinds, "src/a.ts", 6, 6)).toEqual(new Map([[6, "deleted"]]));
  });
});
