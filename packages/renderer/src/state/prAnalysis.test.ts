import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPrAnalysis, type PrAnalyzeRequest, type PrAnalyzeStage } from "./prAnalysis";

const REQUEST: PrAnalyzeRequest = { id: "artifact-1", prNumber: 7, baseRef: "main", headRef: "feature" };

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
    const graphId = await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage) => stages.push(stage));
    expect(stages).toEqual(["clone", "checkout", "extract"]);
    expect(graphId).toBe("pr-abc");
  });

  it("reassembles lines split across arbitrary chunk boundaries (final line unterminated)", async () => {
    // Boundaries land mid-token on purpose; the done line carries no trailing newline, so the
    // leftover-buffer flush after the stream closes must still apply it.
    const chunks = ['{"stage":"cl', 'one"}\n{"stage":"check', 'out"}\n{"stage":"extract"}\n{"stage":"do', 'ne","graphId":"pr-split"}'];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(chunks)));
    const stages: PrAnalyzeStage[] = [];
    const graphId = await streamPrAnalysis("/api/pr/analyze", REQUEST, (stage) => stages.push(stage));
    expect(stages).toEqual(["clone", "checkout", "extract"]);
    expect(graphId).toBe("pr-split");
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
