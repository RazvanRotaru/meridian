import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PR_PREPARE_MAX_CHANGED_PATH_BYTES,
  PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL,
  PR_PREPARE_MAX_LINE_BYTES,
  PR_PREPARE_MAX_WARNINGS,
  PR_PREPARE_MAX_WARNING_BYTES,
  PR_PREPARE_MAX_WARNING_BYTES_TOTAL,
} from "@meridian/core";
import {
  fetchPreparedReviewHandoff,
  preparedReviewFileCursor,
  preparedReviewFileForCursor,
  remapPreparedReviewFilePath,
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
const INVALID_DESCRIPTOR_ENDPOINTS = [
  ["manifestUrl", "http://meridian.local/api/graph/manifest?id=pr-head"],
  ["manifestUrl", "//evil.example/api/graph/manifest?id=pr-head"],
  ["manifestUrl", "//meridian.local/api/graph/manifest?id=pr-head"],
  ["manifestUrl", "https://evil.example/api/graph/manifest?id=pr-head"],
  ["manifestUrl", "/api/graph/other/../manifest?id=pr-head"],
  ["manifestUrl", "/api/graph/projection?id=pr-head"],
  ["projectionUrl", "/api/graph/manifest?id=pr-head"],
  ["searchUrl", "/api/graph/projection?id=pr-head"],
  ["sourceUrl", "/api/meta?id=pr-head"],
  ["metaUrl", "/api/source?id=pr-head"],
  ["manifestUrl", "/api/graph/manifest"],
  ["manifestUrl", "/api/graph/manifest?id=other"],
  ["manifestUrl", "/api/graph/manifest?id=pr-head&id=other"],
  ["manifestUrl", "/api/graph/manifest?id=pr-head&format=json"],
  ["manifestUrl", "/api/graph/manifest?id=pr-head#"],
  ["manifestUrl", "/api/graph/manifest?id=pr-head#fragment"],
] as const;

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
    expect(result).toEqual(expectedResult());
  });

  it("rejects unknown request fields before starting transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamPrPreparation("/api/pr/prepare", {
      ...REQUEST,
      graphId: "legacy-session",
    } as unknown as PrPrepareRequest, () => {}))
      .rejects.toThrow("request fields do not match protocol version 1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 in the NDJSON stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d, 0x0a]),
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    )));

    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation stream: expected UTF-8");
  });

  it("addresses one canonical manifest entry without replaying its path", () => {
    const files = [
      { path: "src/a.ts", status: "deleted" as const },
      { path: "src/b.ts", previousPath: "src/a-old.ts", status: "renamed" as const },
      { path: "src/z.ts", status: "modified" as const },
    ];
    expect(preparedReviewFileCursor(files)).toBeNull();
    expect(preparedReviewFileCursor(files, "src/z.ts")).toBe("file:2");
    expect(preparedReviewFileCursor(files, "src/missing.ts")).toBeNull();
    expect(preparedReviewFileForCursor(files, "file:1")).toEqual(files[1]);
    expect(preparedReviewFileForCursor(files, "file:01")).toBeNull();
    expect(preparedReviewFileForCursor(files, "file:9")).toBeNull();
  });

  it("remaps a committed file across refresh by current path or one canonical rename", () => {
    const previous = [
      { path: "src/a.ts", status: "modified" as const },
      { path: "src/b.ts", previousPath: "src/b-old.ts", status: "renamed" as const },
      { path: "src/removed.ts", status: "deleted" as const },
    ];
    expect(remapPreparedReviewFilePath(previous, "file:0", [
      { path: "src/a.ts", status: "modified" },
    ])).toBe("src/a.ts");
    expect(remapPreparedReviewFilePath(previous, "file:0", [
      { path: "src/a-renamed.ts", previousPath: "src/a.ts", status: "renamed" },
    ])).toBe("src/a-renamed.ts");
    expect(remapPreparedReviewFilePath(previous, "file:1", [
      { path: "src/b-old.ts", status: "modified" },
    ])).toBe("src/b-old.ts");
    expect(remapPreparedReviewFilePath(previous, "file:2", [
      { path: "src/other.ts", status: "modified" },
    ])).toBeNull();
  });

  it("accepts repository-wide manifests beyond the removed path-selector cap", () => {
    const files = Array.from({ length: 513 }, (_, index) => ({
      path: `src/${index.toString().padStart(4, "0")}.ts`,
      status: "modified" as const,
    }));
    expect(preparedReviewFileCursor(files, files[512]!.path)).toBe("file:512");
  });

  it("rejects the removed unversioned stage/done protocol", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { stage: "clone" },
      { stage: "done", graphId: "legacy", headSha: "head-sha" },
    ])));

    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("expected protocol version 1");
  });

  it.each([
    ["progress", { ...progress("resolve", 1), legacyStage: "clone" }, "progress fields"],
    ["done", { ...doneLine(), graphId: "legacy-session" }, "done fields"],
    ["error", { version: 1, type: "error", message: "failed", retryable: true }, "error fields"],
  ])("rejects unknown fields on a %s record", async (_kind, record, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([record])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow(message);
  });

  it.each([
    [{ ...progress("resolve", 1), stage: "clone" }, "progress.stage"],
    [{ ...progress("resolve", 1), elapsedMs: -1 }, "progress.elapsedMs"],
  ])("rejects progress outside the five-stage finite timing contract %#", async (record, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([record])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow(message);
  });

  it.each([
    [{ totalMs: 1 }],
    [{ resolve: -1 }],
    [{ resolve: Number.POSITIVE_INFINITY }],
  ])("rejects non-v1 timing records %#", async (timings) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), timings }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation done line: timings");
  });

  it.each([
    [Array.from({ length: PR_PREPARE_MAX_WARNINGS + 1 }, () => "warning")],
    [["x".repeat(PR_PREPARE_MAX_WARNING_BYTES + 1)]],
    [Array.from(
      { length: Math.ceil(PR_PREPARE_MAX_WARNING_BYTES_TOTAL / PR_PREPARE_MAX_WARNING_BYTES) + 1 },
      () => "x".repeat(PR_PREPARE_MAX_WARNING_BYTES),
    )],
  ])("rejects warnings outside the shared publication bounds %#", async (warnings) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), warnings }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation done line: warnings");
  });

  it.each(INVALID_CHANGED_FILES)("rejects malformed changed-file routing data %#", async (changedFiles) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), changedFiles }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation done line: changedFiles");
  });

  it.each([
    [[{
      path: "é".repeat(Math.floor(PR_PREPARE_MAX_CHANGED_PATH_BYTES / 2) + 1),
      status: "modified",
    }]],
    [Array.from(
      { length: Math.ceil(PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL / 4_000) + 1 },
      (_, index) => ({ path: `${index.toString(36)}/${"x".repeat(4_000)}`, status: "modified" }),
    )],
  ])("rejects changed paths outside the shared UTF-8 publication bounds %#", async (changedFiles) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), changedFiles }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("invalid PR preparation done line: changedFiles");
  });

  it.each(INVALID_DESCRIPTOR_ENDPOINTS)(
    "rejects an unsafe or unbound descriptor endpoint in %s: %s",
    async (field, endpoint) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{
        ...doneLine(),
        head: { ...HEAD, [field]: endpoint },
      }])));

      await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
        .rejects.toThrow(`invalid PR preparation done line: head.${field}`);
    },
  );

  it.each([
    [
      "descriptor",
      { ...doneLine(), head: { ...HEAD, legacyGraphId: "session-graph" } },
      "head descriptor",
    ],
    [
      "graph summary",
      { ...doneLine(), head: { ...HEAD, graphSummary: { ...HEAD.graphSummary, complete: true } } },
      "head.graphSummary",
    ],
    [
      "changed file",
      { ...doneLine(), changedFiles: [{ path: "src/a.ts", status: "modified", additions: 1 }] },
      "changedFiles",
    ],
    [
      "handoff link",
      { ...doneLine(), handoff: { ...doneResult().handoff, graphId: "legacy-session" } },
      "handoff",
    ],
  ])("rejects unknown fields in a nested %s record", async (_kind, record, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([record])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow(message);
  });

  it.each([
    null,
    { id: "opaque-handoff", url: "/api/pr/prepared?id=other", viewUrl: "/view?id=pr-head&view=modules&prn=7&rev=1&prepared=opaque-handoff" },
    { id: "opaque-handoff", url: "/api/pr/prepared?id=opaque-handoff", viewUrl: "/view?id=other&view=modules&prn=7&rev=1&prepared=opaque-handoff" },
    { id: "opaque-handoff", url: "/api/pr/prepared?id=opaque-handoff", viewUrl: "/view?id=pr-head&view=modules&prn=9&rev=1&prepared=opaque-handoff" },
  ])("rejects a missing or mismatched immutable handoff %#", async (handoff) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([{ ...doneLine(), handoff }])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("handoff");
  });

  it("rejects any line after the terminal done response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([doneLine(), progress("publish", 50)])));
    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("data followed the done line");
  });

  it("cancels a live NDJSON body when protocol validation fails", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":0}\n'));
      },
      cancel(reason) {
        canceledWith = reason;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    })));

    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("expected protocol version 1");
    expect(canceledWith).toBe("invalid PR preparation stream: expected protocol version 1");
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

  it("cancels a live response whose advertised preparation media type is invalid", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceledWith = reason;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(streamPrPreparation("/api/pr/prepare", REQUEST, () => {}))
      .rejects.toThrow("expected application/x-ndjson");
    expect(canceledWith).toBe("PR preparation content type is invalid");
  });
});

describe("fetchPreparedReviewHandoff", () => {
  it("GETs and strictly parses one immutable v1 handoff", async () => {
    const handoff = { version: 1, request: REQUEST, ...pairResult() };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(handoff));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque")).resolves.toEqual({
      request: REQUEST,
      ...expectedPair(),
    });
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/prepared?id=opaque");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  });

  it("bounds an unadvertised handoff body while it is streaming", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PR_PREPARE_MAX_LINE_BYTES));
        controller.enqueue(new Uint8Array([0]));
      },
      cancel(reason) {
        canceledWith = reason;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque"))
      .rejects.toThrow("invalid prepared review handoff: response is too large");
    expect(canceledWith).toBe("prepared review handoff exceeded its byte limit");
  });

  it("bounds and cancels an oversized handoff error body", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceledWith = reason;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 503,
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
    })));

    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque"))
      .rejects.toThrow("Prepared review handoff request failed (503)");
    expect(canceledWith).toBe("prepared review error response exceeded its byte limit");
  });

  it.each([
    { version: 0, request: REQUEST, ...doneResult() },
    { version: 1, request: { ...REQUEST, prNumber: 0 }, ...doneResult() },
    { version: 1, request: { ...REQUEST, subdir: "../escape" }, ...doneResult() },
    { version: 1, request: REQUEST, ...doneResult(), mergeBase: null },
  ])("rejects malformed or non-v1 handoff data %#", async (handoff) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(handoff)));
    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque")).rejects.toThrow();
  });

  it("applies the same descriptor endpoint validation to immutable GET handoffs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      version: 1,
      request: REQUEST,
      ...pairResult(),
      mergeBase: {
        ...BASE,
        projectionUrl: "/api/graph/projection?id=pr-head",
      },
    })));

    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque"))
      .rejects.toThrow("invalid PR preparation done line: mergeBase.projectionUrl");
  });

  it("rejects unknown fields throughout an immutable handoff", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      version: 1,
      request: REQUEST,
      ...pairResult(),
      legacyGraphId: "session-graph",
    })));
    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque"))
      .rejects.toThrow("fields do not match protocol version 1");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      version: 1,
      request: { ...REQUEST, token: "secret" },
      ...pairResult(),
    })));
    await expect(fetchPreparedReviewHandoff("/api/pr/prepared?id=opaque"))
      .rejects.toThrow("invalid prepared review handoff: request");
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
    searchUrl: `/api/graph/search?id=${graphId}`,
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
    ...doneResult(),
  };
}

function doneResult() {
  return {
    ...pairResult(),
    handoff: {
      id: "opaque-handoff",
      url: "/api/pr/prepared?id=opaque-handoff",
      viewUrl: "/view?id=pr-head&view=modules&prn=7&rev=1&prepared=opaque-handoff",
    },
  };
}

function pairResult() {
  return {
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
    timings: { resolve: 1, git: 12, "extract-head": 23, "extract-merge-base": 34, publish: 45 },
    warnings: ["one bounded warning"],
  };
}

function expectedResult() {
  return {
    ...expectedPair(),
    handoff: {
      id: "opaque-handoff",
      url: "/api/pr/prepared?id=opaque-handoff",
      viewUrl: "/view?id=pr-head&view=modules&prn=7&rev=1&prepared=opaque-handoff",
    },
  };
}

function expectedPair() {
  return {
    head: HEAD,
    mergeBase: BASE,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    changedFiles: [
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
    ],
    cache: "miss" as const,
    timings: { resolve: 1, git: 12, "extract-head": 23, "extract-merge-base": 34, publish: 45 },
    warnings: ["one bounded warning"],
  };
}

function ndjsonResponse(lines: readonly unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
