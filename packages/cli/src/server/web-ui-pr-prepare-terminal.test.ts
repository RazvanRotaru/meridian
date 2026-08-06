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
const HANDOFF_CLAIM_ID = "h".repeat(32);
const CANONICAL_VIEW_URL = "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1";

type TerminalValidator = (
  data: Record<string, unknown>,
  request: Record<string, unknown>,
  origin: string,
) => {
  destination: string;
  canonicalDestination: string;
  evidence: unknown;
  pair: unknown;
} | null;

describe("landing PR preparation terminal contract", () => {
  const validate = shippedTerminalValidator();

  it("accepts a claimed progressive handoff and ordinary claimless compatibility terminals", () => {
    expect(validate(terminal(), request(), ORIGIN)).toMatchObject({
      destination: `${CANONICAL_VIEW_URL}&handoff=${HANDOFF_CLAIM_ID}`,
      canonicalDestination: CANONICAL_VIEW_URL,
      evidence: { ready: true, depth: 1, prefetchDepth: 3 },
    });

    expect(validate(claimlessTerminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
      initialProjectionCache: { ...evidence(), ready: false },
    }), request(), ORIGIN)).toMatchObject({
      destination: "/view?id=head-graph&view=modules&prn=41&rev=1",
      canonicalDestination: "/view?id=head-graph&view=modules&prn=41&rev=1",
      evidence: { ready: false },
    });
    expect(validate(claimlessTerminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1",
      initialProjectionCache: {
        ...evidence(),
        headKey: null,
        comparisonKey: null,
        ready: false,
      },
    }), request(), ORIGIN)).not.toBeNull();

    const withoutEvidence = claimlessTerminal({
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
      canonicalViewUrl: provisionalCanonicalViewUrl(pairId),
      viewUrl: claimedViewUrl(provisionalCanonicalViewUrl(pairId)),
    });
    expect(validate(ready, request(), ORIGIN)).toMatchObject({
      destination: claimedViewUrl(provisionalCanonicalViewUrl(pairId)),
      canonicalDestination: provisionalCanonicalViewUrl(pairId),
    });
    const done = { ...ready, stage: "done" };
    expect(validate(done, request(), ORIGIN)).toMatchObject({
      destination: claimedViewUrl(provisionalCanonicalViewUrl(pairId)),
      canonicalDestination: provisionalCanonicalViewUrl(pairId),
    });
    expect(validate({ ...ready, pairId: "wrong" }, request(), ORIGIN)).toBeNull();
    expect(validate({ ...ready, viewUrl: terminal().viewUrl }, request(), ORIGIN)).toBeNull();
  });

  it("requires one exact claim and a separate claimless canonical destination", () => {
    const missingHandoff = terminal();
    delete missingHandoff.preparedReviewHandoff;
    expect(validate(missingHandoff, request(), ORIGIN)).toBeNull();

    const missingCanonical = terminal();
    delete missingCanonical.canonicalViewUrl;
    expect(validate(missingCanonical, request(), ORIGIN)).toBeNull();

    expect(validate(terminal({ viewUrl: CANONICAL_VIEW_URL }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      viewUrl: `${claimedViewUrl(CANONICAL_VIEW_URL)}&handoff=${HANDOFF_CLAIM_ID}`,
    }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      canonicalViewUrl: `${CANONICAL_VIEW_URL}&handoff=${HANDOFF_CLAIM_ID}`,
    }), request(), ORIGIN)).toBeNull();
  });

  it.each([
    ["short claim", { claimId: "too-short", url: "/api/pr-review-handoffs/too-short" }],
    ["claim URL mismatch", { url: `/api/pr-review-handoffs/${"i".repeat(32)}` }],
    ["foreign claim URL", { url: `https://example.test/api/pr-review-handoffs/${HANDOFF_CLAIM_ID}` }],
    ["head mismatch", { headGraphId: "different-head" }],
    ["comparison mismatch", { comparisonGraphId: "different-base" }],
    ["invalid expiry", { expiresAtMs: -1 }],
    ["unsupported version", { version: 2 }],
    ["extra field", { extra: true }],
  ])("rejects a malformed prepared review handoff: %s", (_label, override) => {
    expect(validate(terminal({
      preparedReviewHandoff: { ...handoff(), ...override },
    }), request(), ORIGIN)).toBeNull();
  });

  it("rejects a view URL whose claim does not match its handoff", () => {
    expect(validate(terminal({
      viewUrl: claimedViewUrl(CANONICAL_VIEW_URL, "i".repeat(32)),
    }), request(), ORIGIN)).toBeNull();
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
    expect(validate(claimlessTerminal({
      initialProjectionCache: { ...evidence(), ready: false },
      viewUrl: CANONICAL_VIEW_URL,
    }), request(), ORIGIN)).toBeNull();
    expect(validate(claimlessTerminal({
      initialProjectionCache: { ...evidence(), ready: false },
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=0",
    }), request(), ORIGIN)).toBeNull();
    expect(validate(terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1&progressive=1",
    }), request(), ORIGIN)).toBeNull();

    const absentButProgressive = claimlessTerminal({ viewUrl: CANONICAL_VIEW_URL });
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
      [terminalForCanonical("/view?id=stale&view=modules&prn=41&rev=1&progressive=1"), request()],
      [terminalForCanonical("/view?id=head-graph&view=modules&prn=42&rev=1&progressive=1"), request()],
      [terminalForCanonical("/view?id=head-graph&view=modules&prn=41&rev=2&progressive=1"), request()],
      [terminalForCanonical("/view?id=head-graph&view=files&prn=41&rev=1&progressive=1"), request()],
      [terminalForCanonical("https://example.test/view?id=head-graph&view=modules&prn=41&rev=1&progressive=1"), request()],
      [terminalForCanonical("/view?id=head-graph&id=head-graph&view=modules&prn=41&rev=1&progressive=1"), request()],
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
    preparedReviewHandoff: handoff(),
    canonicalViewUrl: CANONICAL_VIEW_URL,
    viewUrl: claimedViewUrl(CANONICAL_VIEW_URL),
    ...overrides,
  };
}

function claimlessTerminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = terminal(overrides);
  delete value.preparedReviewHandoff;
  delete value.canonicalViewUrl;
  return value;
}

function terminalForCanonical(canonicalViewUrl: string): Record<string, unknown> {
  return terminal({
    canonicalViewUrl,
    viewUrl: claimedViewUrl(canonicalViewUrl),
  });
}

function claimedViewUrl(canonicalViewUrl: string, claimId = HANDOFF_CLAIM_ID): string {
  return `${canonicalViewUrl}&handoff=${encodeURIComponent(claimId)}`;
}

function provisionalCanonicalViewUrl(pairId: string): string {
  return `${CANONICAL_VIEW_URL}&partial=1&pair=${pairId}`;
}

function handoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    claimId: HANDOFF_CLAIM_ID,
    url: `/api/pr-review-handoffs/${HANDOFF_CLAIM_ID}`,
    expiresAtMs: 10_000,
    headGraphId: "head-graph",
    comparisonGraphId: "base-graph",
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
