import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow } from "./reviewFiles";
import {
  deriveReviewCommentNodeEvidence,
  projectReviewCommentNodeEvidence,
  type ReviewCommentNodeInput,
} from "./reviewCommentNodes";

const PACKAGE = "ts:src";
const FILE = "ts:src/a.ts";
const CLASS = "ts:src/a.ts#Service";
const METHOD = "ts:src/a.ts#Service.run";
const SURVIVOR = "ts:src/a.ts#Service.next";
const OTHER = "ts:src/a.ts#outside";
const TEST_FILE = "ts:src/a.test.ts";
const TEST_METHOD = "ts:src/a.test.ts#coversRun";
const PR_PATH = "repo/src/a.ts";
const TEST_PR_PATH = "repo/src/a.test.ts";

const INDEX = buildGraphIndex({
  nodes: [
    node(PACKAGE, "package", null, "src", 1, 1),
    node(FILE, "module", PACKAGE, "src/a.ts", 1, 100),
    node(CLASS, "class", FILE, "src/a.ts", 10, 60),
    node(METHOD, "method", CLASS, "src/a.ts", 20, 30),
    node(SURVIVOR, "method", CLASS, "src/a.ts", 31, 40),
    node(OTHER, "function", FILE, "src/a.ts", 70, 80),
    node(TEST_FILE, "module", PACKAGE, "src/a.test.ts", 1, 40),
    node(TEST_METHOD, "function", TEST_FILE, "src/a.test.ts", 10, 20),
  ],
  edges: [],
} as unknown as GraphArtifact);

const FILE_ROW: ReviewFileRow = {
  path: PR_PATH,
  status: "modified",
  isTest: false,
  moduleId: FILE,
  units: [],
  fingerprint: "fixture",
  blastRadius: 0,
  deletedImpact: null,
};

describe("review comment node evidence", () => {
  it("maps unit, file, and HEAD-line comments to one most-specific owner", () => {
    const result = deriveReviewCommentNodeEvidence(input({
      drafts: [
        draft("unit", METHOD, null),
        draft("file", null, null),
        draft("method-line", null, 25),
        draft("class-line", null, 15),
      ],
      existingComments: [
        existing("RIGHT", 24),
        existing("RIGHT", 24),
        existing("LEFT", 25),
        existing(null, null),
      ],
    }));

    expect(Object.fromEntries(result)).toEqual({
      [METHOD]: { draftCount: 2, existingCount: 2 },
      [FILE]: { draftCount: 1, existingCount: 2 },
      [CLASS]: { draftCount: 1, existingCount: 0 },
    });
  });

  it("keeps HEAD-line comments on the file until a prepared graph can resolve them", () => {
    const lineDraft = input({
      drafts: [draft("shifted", null, 33)],
      lineCoordinatesMatchGraph: false,
    });

    expect(Object.fromEntries(deriveReviewCommentNodeEvidence(lineDraft))).toEqual({
      [FILE]: { draftCount: 1, existingCount: 0 },
    });
    expect(Object.fromEntries(deriveReviewCommentNodeEvidence({ ...lineDraft, lineCoordinatesMatchGraph: true }))).toEqual({
      [SURVIVOR]: { draftCount: 1, existingCount: 0 },
    });
  });

  it("never infers a specific HEAD owner from deletion-shifted base spans", () => {
    const result = deriveReviewCommentNodeEvidence(input({
      existingComments: [existing("RIGHT", 20)],
      lineCoordinatesMatchGraph: false,
    }));

    expect(Object.fromEntries(result)).toEqual({
      [FILE]: { draftCount: 0, existingCount: 1 },
    });
  });

  it("rolls unsafe or vanished anchors to the file and hides only existing-comment evidence", () => {
    const result = deriveReviewCommentNodeEvidence(input({
      drafts: [
        { ...draft("stale", METHOD, 25), lineStale: true },
        draft("vanished", "ts:src/a.ts#gone", null),
      ],
      existingComments: [existing("RIGHT", 25)],
      existingCommentsVisible: false,
    }));

    expect(Object.fromEntries(result)).toEqual({
      [FILE]: { draftCount: 2, existingCount: 0 },
    });
    expect(deriveReviewCommentNodeEvidence(input({
      files: [{ ...FILE_ROW, path: "deleted.ts", moduleId: null }],
      drafts: [{ ...draft("deleted", null, null), path: "deleted.ts" }],
      existingComments: [{ ...existing("LEFT", 4), path: "deleted.ts" }],
    })).size).toBe(0);
  });

  it("does not roll a draft from a projected-out file onto a visible ancestor", () => {
    const evidence = deriveReviewCommentNodeEvidence(input({
      drafts: [{ ...draft("hidden-test", TEST_METHOD, null), path: TEST_PR_PATH }],
    }));

    expect(evidence.size).toBe(0);
    expect(projectReviewCommentNodeEvidence(evidence, [rfNode(PACKAGE, 1)], INDEX).size).toBe(0);
  });
});

describe("review comment visible-node projection", () => {
  it("aggregates onto the nearest ancestor in every semantic population", () => {
    const evidence = new Map([
      [METHOD, { draftCount: 1, existingCount: 2 }],
      [OTHER, { draftCount: 0, existingCount: 1 }],
    ]);
    const visible: Node[] = [
      rfNode(CLASS, 0),
      rfNode(FILE, 0),
      rfNode(PACKAGE, 1),
    ];

    expect(Object.fromEntries(projectReviewCommentNodeEvidence(evidence, visible, INDEX))).toEqual({
      [CLASS]: { draftCount: 1, existingCount: 2 },
      [FILE]: { draftCount: 0, existingCount: 1 },
      [PACKAGE]: { draftCount: 1, existingCount: 3 },
    });
  });
});

function input(overrides: Partial<ReviewCommentNodeInput> = {}): ReviewCommentNodeInput {
  return {
    drafts: [],
    existingComments: [],
    existingCommentsVisible: true,
    files: [FILE_ROW],
    index: INDEX,
    lineCoordinatesMatchGraph: true,
    ...overrides,
  };
}

function node(id: string, kind: string, parentId: string | null, file: string, startLine: number, endLine: number): GraphNode {
  return { id, kind, parentId, qualifiedName: id, displayName: id, location: { file, startLine, endLine } };
}

function draft(id: string, nodeId: string | null, line: number | null): ReviewComment {
  return { id, path: PR_PATH, nodeId, line, anchorLabel: null, body: id, at: "2026-07-12T00:00:00Z" };
}

function existing(side: PrGitHubComment["side"], line: number | null): PrGitHubComment {
  return { id: 401, inReplyToId: null, viewerCanEdit: false, path: PR_PATH, side, line, body: "existing", author: "octo", updatedAt: "2026-07-12T00:00:00Z", url: "" };
}

function rfNode(id: string, semanticDepth: number): Node {
  return { id, type: "file", position: { x: 0, y: 0 }, data: { semanticDepth } };
}
