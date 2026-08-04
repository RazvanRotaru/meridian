import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPrAnalysis, type PrAnalyzeRequest, type PrAnalyzeStage } from "./prAnalysis";

const REQUEST: PrAnalyzeRequest = { id: "artifact-1", prNumber: 7, baseRef: "main", headRef: "feature" };
const READY_PAIR_ID = "0123456789abcdefabcd";
const READY_HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const READY_MERGE_BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A streamed NDJSON Response whose body arrives in exactly the given chunks. */
function ndjsonResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamPrAnalysis", () => {
  it("POSTs the analyze request as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"done","graphId":"pr-1"}\n']));
    vi.stubGlobal("fetch", fetchMock);
    await streamPrAnalysis("/api/pr/analyze", REQUEST, () => {});
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://meridian.local/api/pr/analyze");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(REQUEST);
  });

  it("routes each stage and resolves the done line's graph id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"clone"}\n{"stage":"checkout"}\n{"stage":"extract"}\n{"stage":"done","graphId":"pr-abc"}\n'])),
    );
    const stages: PrAnalyzeStage[] = [];
    const result = await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage) => stages.push(stage));
    expect(stages).toEqual(["clone", "checkout", "extract"]);
    expect(result.graphId).toBe("pr-abc");
    // An older server's done line has no headSha — the provenance is honestly unknown, not "".
    expect(result).toEqual({
      graphId: "pr-abc",
      comparisonGraphId: null,
      headSha: null,
      mergeBaseSha: null,
      cache: null,
    });
  });

  it("routes detailed extraction, lane completion, and verified revision reuse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        '{"stage":"extract"}\n{"stage":"reuse-head"}\n{"stage":"extract-merge-base"}\n'
          + '{"stage":"lane-complete","lane":"mergeBase"}\n'
          + '{"stage":"lane-complete","lane":"unknown"}\n'
          + '{"stage":"reuse-merge-base"}\n{"stage":"done","graphId":"pr-abc"}\n',
      ])),
    );
    const stages: PrAnalyzeStage[] = [];
    const completedLanes: string[] = [];
    await streamPrAnalysis(
      "/api/pr/analyze",
      REQUEST,
      (stage) => stages.push(stage),
      (lane) => completedLanes.push(lane),
    );
    expect(stages).toEqual(["extract", "reuse-head", "extract-merge-base", "reuse-merge-base"]);
    expect(completedLanes).toEqual(["mergeBase"]);
  });

  it("reports an early immutable review pair and keeps draining to the canonical terminal pair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        `${JSON.stringify({ stage: "ready", pairId: READY_PAIR_ID, completeness: "provisional", graphId: "pr-bounded", comparisonGraphId: "base-bounded", headSha: READY_HEAD_SHA, mergeBaseSha: READY_MERGE_BASE_SHA })}\n`,
        '{"stage":"extract-head"}\n',
        `${JSON.stringify({ stage: "done", graphId: "pr-canonical", comparisonGraphId: "base-canonical", headSha: READY_HEAD_SHA, mergeBaseSha: READY_MERGE_BASE_SHA })}\n`,
      ])),
    );
    const ready: unknown[] = [];

    const result = await streamPrAnalysis(
      "/api/pr/analyze",
      REQUEST,
      () => undefined,
      () => undefined,
      (pair) => ready.push(pair),
    );

    expect(ready).toEqual([{
      graphId: "pr-bounded",
      pairId: READY_PAIR_ID,
      completeness: "provisional",
      comparisonGraphId: "base-bounded",
      headSha: READY_HEAD_SHA,
      mergeBaseSha: READY_MERGE_BASE_SHA,
      cache: null,
    }]);
    expect(result).toEqual({
      graphId: "pr-canonical",
      comparisonGraphId: "base-canonical",
      headSha: READY_HEAD_SHA,
      mergeBaseSha: READY_MERGE_BASE_SHA,
      cache: null,
    });
  });

  it("accepts the same bounded pair as the authoritative progressive terminal", async () => {
    const bounded = {
      pairId: READY_PAIR_ID,
      completeness: "provisional",
      graphId: "pr-bounded",
      comparisonGraphId: "base-bounded",
      headSha: READY_HEAD_SHA,
      mergeBaseSha: READY_MERGE_BASE_SHA,
      cache: "hit",
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        `${JSON.stringify({ stage: "ready", ...bounded })}\n`,
        `${JSON.stringify({ stage: "done", ...bounded })}\n`,
      ])),
    );
    const ready: unknown[] = [];

    const result = await streamPrAnalysis(
      "/api/pr/analyze",
      REQUEST,
      () => undefined,
      () => undefined,
      (pair) => ready.push(pair),
    );

    expect(ready).toHaveLength(1);
    expect(result).toEqual(bounded);
  });

  it.each([
    ["empty graph id", { graphId: "" }],
    ["non-canonical pair id", { pairId: "pair-1" }],
    ["uppercase pair id", { pairId: "0123456789ABCDEFABCD" }],
    ["missing comparison graph", { comparisonGraphId: undefined }],
    ["comparison graph equal to head graph", { comparisonGraphId: "pr-bounded" }],
    ["missing head revision", { headSha: undefined }],
    ["abbreviated head revision", { headSha: "abc123" }],
    ["missing merge-base revision", { mergeBaseSha: undefined }],
    ["abbreviated merge-base revision", { mergeBaseSha: "def456" }],
  ])("ignores a malformed early-ready line with %s", async (_case, override) => {
    const ready = {
      stage: "ready",
      pairId: READY_PAIR_ID,
      completeness: "provisional",
      graphId: "pr-bounded",
      comparisonGraphId: "base-bounded",
      headSha: READY_HEAD_SHA,
      mergeBaseSha: READY_MERGE_BASE_SHA,
      ...override,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        `${JSON.stringify(ready)}\n`,
        '{"stage":"done","graphId":"pr-canonical"}\n',
      ])),
    );
    const onReady = vi.fn();

    await expect(streamPrAnalysis(
      "/api/pr/analyze",
      REQUEST,
      () => undefined,
      () => undefined,
      onReady,
    )).resolves.toMatchObject({ graphId: "pr-canonical" });
    expect(onReady).not.toHaveBeenCalled();
  });

  it("preserves optional extraction observations and ignores unknown future stages", async () => {
    const observation = {
      version: 1,
      revision: {
        kind: "head",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        execution: { current: 1, total: 2 },
      },
      language: "typescript",
      phase: "structure",
      unit: null,
      sourceFile: null,
      futureField: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        `${JSON.stringify({ stage: "extract-head", progress: observation })}\n`,
        '{"stage":"future-progress-stage","future":true}\n',
        '{"stage":"done","graphId":"pr-abc","cache":"miss"}\n',
      ])),
    );
    const updates: Array<{ stage: PrAnalyzeStage; progress: unknown }> = [];
    const result = await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage, progress) => {
      updates.push({ stage, progress });
    });

    expect(updates).toEqual([{ stage: "extract-head", progress: observation }]);
    expect(result.cache).toBe("miss");
  });

  it("drops malformed extraction observations before notifying UI state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        '{"stage":"extract-head","progress":{"version":2,"future":true}}\n',
        '{"stage":"done","graphId":"pr-abc"}\n',
      ])),
    );
    const updates: Array<{ stage: PrAnalyzeStage; progress: unknown }> = [];

    await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage, progress) => {
      updates.push({ stage, progress });
    });

    expect(updates).toEqual([{ stage: "extract-head", progress: null }]);
  });

  it("ignores valid JSON primitives and arrays in the NDJSON stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        'null\n42\n[]\n{"stage":"done","graphId":"pr-abc"}\n',
      ])),
    );

    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => {}))
      .resolves.toMatchObject({ graphId: "pr-abc" });
  });

  it("rejects an unbounded NDJSON line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ndjsonResponse([
        `{"stage":"clone","padding":"${"x".repeat(4 * 1024 * 1024)}"}\n`,
      ])),
    );

    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => {}))
      .rejects.toThrow("oversized progress line");
  });

  it("carries the done line's exact head and merge-base comparison provenance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"done","graphId":"pr-abc","comparisonGraphId":"pr-base-def","headSha":"abc1234def56789","mergeBaseSha":"def5678abc12345"}\n',
    ])));
    const result = await streamPrAnalysis("/api/pr/analyze", REQUEST, () => {});
    expect(result).toEqual({
      graphId: "pr-abc",
      comparisonGraphId: "pr-base-def",
      headSha: "abc1234def56789",
      mergeBaseSha: "def5678abc12345",
      cache: null,
    });
  });

  it("rejects a canonical pair that aliases HEAD and comparison to one graph id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      `${JSON.stringify({
        stage: "done",
        graphId: "pr-aliased",
        comparisonGraphId: "pr-aliased",
        headSha: READY_HEAD_SHA,
        mergeBaseSha: READY_MERGE_BASE_SHA,
      })}\n`,
    ])));

    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => undefined))
      .rejects.toThrow("PR analysis ended without a graph");
  });

  it("reassembles lines split across arbitrary chunk boundaries (final line unterminated)", async () => {
    // Boundaries land mid-token on purpose; the done line carries no trailing newline, so the
    // leftover-buffer flush after the stream closes must still apply it.
    const chunks = ['{"stage":"cl', 'one"}\n{"stage":"check', 'out"}\n{"stage":"extract"}\n{"stage":"do', 'ne","graphId":"pr-split"}'];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(chunks)));
    const stages: PrAnalyzeStage[] = [];
    const result = await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage) => stages.push(stage));
    expect(stages).toEqual(["clone", "checkout", "extract"]);
    expect(result.graphId).toBe("pr-split");
  });

  it("throws the error line's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"clone"}\n{"stage":"error","message":"clone failed"}\n'])));
    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => {})).rejects.toThrow("clone failed");
  });

  it("throws when the stream ends without a done line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"clone"}\n'])));
    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => {})).rejects.toThrow("PR analysis ended without a graph.");
  });

  it("surfaces a pre-stream failure's JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "unknown artifact" }, { status: 404 })));
    await expect(streamPrAnalysis("/api/pr/analyze", REQUEST, () => {})).rejects.toThrow("unknown artifact");
  });
});
