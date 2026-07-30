import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractionResult } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildArtifact } from "./artifact-header";

const EMPTY_EXTRACTION: ExtractionResult = {
  language: "typescript",
  nodes: [],
  edges: [],
  diagnostics: [],
  stats: {
    files: 0,
    nodeCountByKind: {},
    edgeCountByResolution: {},
    summaryCoverage: { withSummary: 0, total: 0 },
    externalCallsDropped: 0,
    unresolvedCalls: 0,
  },
};

describe("buildArtifact changedSince metadata", () => {
  it("persists the versioned formatting proof beside the unchanged exact diff metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-artifact-header-"));
    try {
      const changedSince = {
        baseRef: "main",
        files: { "src/a.ts": [{ start: 2, end: 2 }] },
        stats: { "src/a.ts": { added: 1, deleted: 1 } },
        kinds: { "src/a.ts": [{ start: 2, end: 2, kind: "modified" as const }] },
        diffLines: {
          "src/a.ts": [
            {
              kind: "deleted" as const,
              oldLine: 2,
              newLine: null,
              beforeNewLine: 2,
              text: "old",
            },
            {
              kind: "added" as const,
              oldLine: null,
              newLine: 2,
              beforeNewLine: 2,
              text: "new",
            },
          ],
        },
        manifest: [{ path: "src/a.ts", status: "modified" as const }],
        formattingOnly: {
          version: 1 as const,
          edits: [{
            path: "src/a.ts",
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 1,
            oldRows: [{ text: "old", noNewline: false }],
            newRows: [{ text: "new", noNewline: false }],
          }],
        },
      };
      const artifact = buildArtifact({
        absoluteRoot: root,
        rootRelativeToCwd: ".",
        language: "typescript",
        extraction: EMPTY_EXTRACTION,
        changedSince,
      });

      expect(artifact.extensions?.changedSince).toEqual(changedSince);
      expect(changedSince.diffLines["src/a.ts"]).toEqual([
        { kind: "deleted", oldLine: 2, newLine: null, beforeNewLine: 2, text: "old" },
        { kind: "added", oldLine: null, newLine: 2, beforeNewLine: 2, text: "new" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
