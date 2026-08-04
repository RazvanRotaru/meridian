import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_UI = fileURLToPath(new URL("../../web-ui/index.html", import.meta.url));
const ORIGIN = "http://meridian.local";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);
const HEAD_KEY = "d".repeat(64);
const COMPARISON_KEY = "e".repeat(64);

type TerminalValidator = (
  data: Record<string, unknown>,
  request: Record<string, unknown>,
  origin: string,
) => { destination: string; evidence: unknown; pair: unknown } | null;

describe("landing PR preparation terminal contract", () => {
  const validate = shippedTerminalValidator();

  it("accepts ready progressive and advisory canonical handoffs", () => {
    expect(validate(terminal(), request(), ORIGIN)).toMatchObject({
      destination: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1",
      evidence: { ready: true, depth: 1, prefetchDepth: 3 },
    });

    expect(validate(terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
      initialProjectionCache: { ...evidence(), ready: false },
    }), request(), ORIGIN)).toMatchObject({
      destination: "/view?id=head-graph&view=modules&prn=41&rev=1",
      evidence: { ready: false },
    });
    expect(validate(terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
      initialProjectionCache: {
        ...evidence(),
        headKey: null,
        comparisonKey: null,
        ready: false,
      },
    }), request(), ORIGIN)).not.toBeNull();

    const withoutEvidence = terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
    });
    delete withoutEvidence.initialProjectionCache;
    expect(validate(withoutEvidence, request(), ORIGIN)).toMatchObject({ evidence: undefined });
  });

  it("accepts only an exact provisional pair route for the early readiness checkpoint", () => {
    const pairId = "f".repeat(20);
    const ready = terminal({
      stage: "ready",
      pairId,
      completeness: "provisional",
      preparedPair: {
        ...(terminal().preparedPair as Record<string, unknown>),
        completeness: "provisional",
        pairId,
      },
      viewUrl: `/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1&partial=1&pair=${pairId}`,
    });
    expect(validate(ready, request(), ORIGIN)).toMatchObject({
      destination: `/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1&partial=1&pair=${pairId}`,
    });
    const done = { ...ready, stage: "done" };
    expect(validate(done, request(), ORIGIN)).toMatchObject({
      destination: `/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1&partial=1&pair=${pairId}`,
    });
    expect(validate({ ...ready, pairId: "wrong" }, request(), ORIGIN)).toBeNull();
    expect(validate({ ...ready, viewUrl: terminal().viewUrl }, request(), ORIGIN)).toBeNull();
  });

  it("requires the exact version-one initial projection evidence shape", () => {
    const invalidEvidence = [
      { ...evidence(), extra: true },
      { ...evidence(), version: 2 },
      { ...evidence(), depth: 2 },
      { ...evidence(), prefetchDepth: 4 },
      { ...evidence(), ready: "true" },
      { ...evidence(), headKey: "not-a-key" },
      { ...evidence(), comparisonKey: "F".repeat(64) },
      { ...evidence(), headKey: null },
      { ...evidence(), comparisonKey: HEAD_KEY },
      [],
      null,
    ];
    for (const initialProjectionCache of invalidEvidence) {
      expect(validate(terminal({ initialProjectionCache }), request(), ORIGIN)).toBeNull();
    }
  });

  it("requires the progressive marker exactly when readiness is proven", () => {
    expect(validate(terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
    }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      initialProjectionCache: { ...evidence(), ready: false },
    }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      initialProjectionCache: { ...evidence(), ready: false },
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=0",
    }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1&progressive=1",
    }), request(), ORIGIN)).toBeNull();

    const absentButProgressive = terminal();
    delete absentButProgressive.initialProjectionCache;
    expect(validate(absentButProgressive, request(), ORIGIN)).toBeNull();
  });

  it("treats an unrecognized ready shape as advisory while keeping invalid done fatal", () => {
    const html = readFileSync(WEB_UI, "utf8");
    expect(html).toContain('if (data.stage === "ready") return null;');
    expect(html).toContain(
      'throw expectedGenerationError("PR preparation returned an invalid immutable graph pair.");',
    );
  });

  it("rejects stale pair, active request, terminal, and destination coordinates", () => {
    const invalid = [
      [terminal(), request({ prNumber: 42 })],
      [terminal(), request({ headSha: "f".repeat(40) })],
      [terminal({ graphId: "stale-head" }), request()],
      [terminal({ comparisonGraphId: "stale-base" }), request()],
      [terminal({
        comparisonGraphId: "head-graph",
        preparedPair: {
          ...(terminal().preparedPair as Record<string, unknown>),
          mergeBaseGraphId: "head-graph",
        },
      }), request()],
      [terminal({ headSha: "f".repeat(40) }), request()],
      [terminal({ baseSha: "f".repeat(40) }), request()],
      [terminal({ mergeBaseSha: "f".repeat(40) }), request()],
      [terminal({ viewUrl: "/view?id=stale&view=modules&prn=41&rev=1&progressive=1" }), request()],
      [terminal({ viewUrl: "/view?id=head-graph&view=modules&prn=42&rev=1&progressive=1" }), request()],
      [terminal({ viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=2&progressive=1" }), request()],
      [terminal({ viewUrl: "/view?id=head-graph&view=files&prn=41&rev=1&progressive=1" }), request()],
      [terminal({ viewUrl: "https://example.test/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1" }), request()],
      [terminal({ viewUrl: "/view?id=head-graph&id=head-graph&view=modules&prn=41&rev=1&progressive=1" }), request()],
    ] as const;
    for (const [data, activeRequest] of invalid) {
      expect(validate(data, activeRequest, ORIGIN)).toBeNull();
    }
  });
});

function shippedTerminalValidator(): TerminalValidator {
  const html = readFileSync(WEB_UI, "utf8");
  const start = html.indexOf("function validatedPrPrepareTerminal(");
  const end = html.indexOf("\n\n      function resetReviewManifestShell", start);
  if (start < 0 || end < 0) throw new Error("landing terminal validator was not found");
  const source = html.slice(start, end).trim();
  return Function(`"use strict"; return (${source});`)() as TerminalValidator;
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: "org/repo",
    prNumber: 41,
    baseRef: "main",
    headRef: "feature/review",
    headSha: HEAD_SHA,
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: "done",
    graphId: "head-graph",
    comparisonGraphId: "base-graph",
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    changedFiles: [],
    counts: { nodes: 0, edges: 0 },
    cache: "hit",
    initialProjectionCache: evidence(),
    preparedPair: {
      version: 1,
      prNumber: 41,
      headGraphId: "head-graph",
      mergeBaseGraphId: "base-graph",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
    },
    viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1",
    ...overrides,
  };
}

function evidence(): Record<string, unknown> {
  return {
    version: 1,
    depth: 1,
    prefetchDepth: 3,
    headKey: HEAD_KEY,
    comparisonKey: COMPARISON_KEY,
    ready: true,
  };
}
