import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changedFileProjectionPaths,
  streamPrPreparation,
  type PrPrepareRequest,
  type PrPrepareStage,
} from "./prPreparation";

const REQUEST: PrPrepareRequest = {
  owner: "acme",
  repo: "shop",
  subdir: "packages/api",
  prNumber: 7,
  baseRef: "main",
  headRef: "feature",
};

const HEAD = descriptor("pr-head");
const BASE = descriptor("pr-base");
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);
const INVALID_CHANGED_FILES: unknown[][] = [
  [{ path: "../escape.ts", status: "modified" }],
  [{ path: "/absolute.ts", status: "modified" }],
  [{ path: "C:drive.ts", status: "modified" }],
  [{ path: "src\\windows.ts", status: "modified" }],
  [{ path: "src/a.ts", status: "renamed" }],
  [{ path: "src/a.ts", status: "renamed", previousPath: "src/a.ts" }],
  [{ path: "src/a.ts", status: "modified", previousPath: "src/old.ts" }],
  [{ path: "src/a.ts", status: "modified" }, { path: "src/a.ts", status: "deleted" }],
];

afterEach(() => vi.unstubAllGlobals());

describe("streamPrPreparation", () => {
  it("POSTs the exact direct request and accepts only the v1 descriptor protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([
      progress("resolve", 1),
      progress("git", 12),
      progress("extract-head", 23),
      progress("extract-merge-base", 34),
      progress("publish", 45),
      doneLine(),
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const stages: PrPrepareStage[] = [];

    const result = await streamPrPreparation("/api/pr/prepare", REQUEST, (stage) => stages.push(stage));

    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/prepare");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(REQUEST);
    expect(stages).toEqual(["resolve", "git", "extract-head", "extract-merge-base", "publish"]);
    expect(result).toEqual({
      head: HEAD,
      mergeBase: BASE,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      changedFiles: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      ],
      cache: "miss",
      timings: { gitMs: 12, extractMs: 34 },
      warnings: ["one bounded warning"],
    });
  });

  it("canonicalizes both sides of renames for review projection routing", () => {
    expect(changedFileProjectionPaths([
      { path: "src/z.ts", status: "modified" },
      { path: "src/b.ts", previousPath: "src/a.ts", status: "renamed" },
      { path: "src/a.ts", status: "deleted" },
    ])).toEqual(["src/a.ts", "src/b.ts", "src/z.ts"]);
  });

  it("rejects the removed unversioned stage/done protocol", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { stage: "clone" },
      { stage: "done", graphId: "legacy", headSha: "head-sha" },
    ])));

    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("expected protocol version 1");
  });

  it.each(INVALID_CHANGED_FILES)("rejects malformed changed-file routing data %#", async (changedFiles) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), changedFiles }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation done line: changedFiles");
  });

  it("rejects any line after the terminal done response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([doneLine(), progress("publish", 50)])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("data followed the done line");
  });

  it("surfaces typed stream errors and direct endpoint admission errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { version: 1, type: "error", message: "preparation failed safely" },
    ])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("preparation failed safely");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: "inspection queue is full; retry later" },
      { status: 429 },
    )));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("inspection queue is full; retry later");
  });
});

function progress(stage: PrPrepareStage, elapsedMs: number) {
  return { version: 1, type: "progress", stage, elapsedMs };
}

function descriptor(graphId: string) {
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${graphId}`,
    projectionUrl: `/api/graph/projection?id=${graphId}`,
    sourceUrl: `/api/source?id=${graphId}`,
    metaUrl: `/api/meta?id=${graphId}`,
    graphSummary: {
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-15T00:00:00.000Z",
      nodeCount: 10,
      edgeCount: 20,
    },
  };
}

function doneLine() {
  return {
    version: 1,
    type: "done",
    head: HEAD,
    mergeBase: BASE,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    changedFiles: [
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
    ],
    cache: "miss",
    timings: { gitMs: 12, extractMs: 34 },
    warnings: ["one bounded warning"],
  };
}

function ndjsonResponse(lines: readonly unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
