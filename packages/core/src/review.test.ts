import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode, JsonValue } from "./types";
import type { FlowStep, LogicFlows } from "./flow";
import { REVIEW_EXTENSION, changedPathSet, readReviewContext, type ChangedFile } from "./review";
import { computeAffectedFlows, flowFingerprint } from "./affected-flows";

// ── fixtures ────────────────────────────────────────────────────────────────

function node(id: string, kind: string, file: string, startLine = 1): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, location: { file, startLine } };
}

type CallResolution = "resolved" | "external" | "unresolved";

function call(target: string | null, resolution: CallResolution = "resolved"): FlowStep {
  return { kind: "call", label: "call", target, resolution };
}

function artifactWith(review: unknown): GraphArtifact {
  const extensions = { [REVIEW_EXTENSION]: review } as unknown as Record<string, JsonValue>;
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00Z",
    generator: { name: "test", version: "0" },
    target: { name: "t", root: ".", language: "typescript" },
    nodes: [],
    edges: [],
    extensions,
  };
}

const VALID_CONTEXT = {
  changedFiles: [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "renamed", previousPath: "src/old-b.ts" },
  ],
  baseRef: "origin/main",
  baseSha: "abc123",
  headRef: "feat/x",
  reviewKey: "github.com/acme/shop|feat/x|origin/main",
  warnings: ["1 changed file(s) outside the extraction root were skipped"],
};

// ── readReviewContext ───────────────────────────────────────────────────────

describe("readReviewContext", () => {
  it("round-trips a valid context, preserving previousPath on renames", () => {
    const context = readReviewContext(artifactWith(VALID_CONTEXT));
    expect(context).toEqual(VALID_CONTEXT);
  });

  it("accepts an empty changed-file set and empty warnings", () => {
    const context = readReviewContext(
      artifactWith({ ...VALID_CONTEXT, changedFiles: [], warnings: [] }),
    );
    expect(context?.changedFiles).toEqual([]);
  });

  it("accepts null refs (--changed mode)", () => {
    const context = readReviewContext(
      artifactWith({ ...VALID_CONTEXT, baseRef: null, baseSha: null, headRef: null }),
    );
    expect(context?.baseRef).toBeNull();
  });

  it("returns null when the extension is absent", () => {
    const artifact = artifactWith(VALID_CONTEXT);
    delete artifact.extensions;
    expect(readReviewContext(artifact)).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(readReviewContext(artifactWith("nope"))).toBeNull();
    expect(readReviewContext(artifactWith([VALID_CONTEXT]))).toBeNull();
    expect(readReviewContext(artifactWith(42))).toBeNull();
  });

  it("returns null when changedFiles is not an array", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, changedFiles: {} }))).toBeNull();
  });

  it("returns null for a changed-file with a missing/non-string path", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, changedFiles: [{ status: "added" }] }))).toBeNull();
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, changedFiles: [{ path: 1, status: "added" }] }))).toBeNull();
  });

  it("returns null for an unknown change status", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, changedFiles: [{ path: "x", status: "copied" }] }))).toBeNull();
  });

  it("returns null when previousPath is present but not a string", () => {
    const changedFiles = [{ path: "x", status: "renamed", previousPath: 7 }];
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, changedFiles }))).toBeNull();
  });

  it("returns null when a ref is neither string nor null", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, baseRef: 5 }))).toBeNull();
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, headRef: undefined }))).toBeNull();
  });

  it("returns null for a missing or empty reviewKey", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, reviewKey: "" }))).toBeNull();
    const noKey = { ...VALID_CONTEXT } as Record<string, unknown>;
    delete noKey.reviewKey;
    expect(readReviewContext(artifactWith(noKey))).toBeNull();
  });

  it("returns null when warnings is not a string array", () => {
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, warnings: ["ok", 3] }))).toBeNull();
    expect(readReviewContext(artifactWith({ ...VALID_CONTEXT, warnings: "oops" }))).toBeNull();
  });
});

describe("changedPathSet", () => {
  it("collects path values only, never previousPath", () => {
    const files: ChangedFile[] = [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "renamed", previousPath: "src/old-b.ts" },
    ];
    const set = changedPathSet(files);
    expect([...set].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(set.has("src/old-b.ts")).toBe(false);
  });
});

// ── computeAffectedFlows ────────────────────────────────────────────────────

describe("computeAffectedFlows", () => {
  const nodes: GraphNode[] = [
    node("ts:src/a.ts#fa", "function", "src/a.ts", 5),
    node("ts:src/b.ts#fb", "function", "src/b.ts", 3),
    node("ts:src/c.ts#fc", "function", "src/c.ts", 2),
    node("ts:src/pkg", "package", "src/pkg"),
    node("ext:lodash#map", "external", "lodash"),
  ];

  it("marks a flow whose owner file changed", () => {
    const flows: LogicFlows = { "ts:src/b.ts#fb": [call("ts:src/a.ts#fa")] };
    const affected = computeAffectedFlows(nodes, flows, new Set(["src/b.ts"]));
    expect(affected).toEqual([
      { flowId: "ts:src/b.ts#fb", ownerFile: "src/b.ts", ownerChanged: true, changedFilesHit: [] },
    ]);
  });

  it("marks a flow that calls into a changed file (owner unchanged)", () => {
    const flows: LogicFlows = { "ts:src/a.ts#fa": [call("ts:src/b.ts#fb")] };
    const [affected] = computeAffectedFlows(nodes, flows, new Set(["src/b.ts"]));
    expect(affected).toMatchObject({ ownerChanged: false, changedFilesHit: ["src/b.ts"] });
  });

  it("never counts external/unresolved or boundary-id targets", () => {
    const flows: LogicFlows = {
      "ts:src/a.ts#fa": [
        { kind: "call", label: "map", target: "ext:lodash#map", resolution: "external" },
        { kind: "call", label: "map", target: "ext:lodash#map", resolution: "resolved" },
        { kind: "call", label: "dyn", target: null, resolution: "unresolved" },
      ],
    };
    // "lodash" is in changedPaths to prove boundary targets are still excluded.
    expect(computeAffectedFlows(nodes, flows, new Set(["lodash"]))).toEqual([]);
  });

  it("excludes package-kind call targets even when their directory path is 'changed'", () => {
    const flows: LogicFlows = { "ts:src/a.ts#fa": [call("ts:src/pkg")] };
    expect(computeAffectedFlows(nodes, flows, new Set(["src/pkg"]))).toEqual([]);
  });

  it("walks nested branch/loop/callback bodies", () => {
    const deep: FlowStep = {
      kind: "branch",
      label: "if",
      paths: [{ label: "then", body: [{ kind: "loop", label: "for", body: [{ kind: "callback", label: "cb", body: [call("ts:src/b.ts#fb")] }] }] }],
    };
    const flows: LogicFlows = { "ts:src/a.ts#fa": [deep] };
    const [affected] = computeAffectedFlows(nodes, flows, new Set(["src/b.ts"]));
    expect(affected.changedFilesHit).toEqual(["src/b.ts"]);
  });

  it("dedupes and sorts changedFilesHit", () => {
    const flows: LogicFlows = {
      "ts:src/a.ts#fa": [call("ts:src/c.ts#fc"), call("ts:src/c.ts#fc"), call("ts:src/b.ts#fb")],
    };
    const [affected] = computeAffectedFlows(nodes, flows, new Set(["src/b.ts", "src/c.ts"]));
    expect(affected.changedFilesHit).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("omits flows that neither own nor call into a changed file", () => {
    const flows: LogicFlows = { "ts:src/a.ts#fa": [call("ts:src/c.ts#fc")] };
    expect(computeAffectedFlows(nodes, flows, new Set(["src/b.ts"]))).toEqual([]);
  });

  it("sorts ownerChanged desc → ownerFile asc (nulls last) → startLine asc → flowId asc", () => {
    const sortNodes: GraphNode[] = [
      node("ts:src/b.ts#f1", "function", "src/b.ts", 10),
      node("ts:src/b.ts#f2", "function", "src/b.ts", 3),
      node("ts:src/b.ts#f2b", "function", "src/b.ts", 3),
      node("ts:src/c.ts#f3", "function", "src/c.ts", 5),
      node("ts:src/a.ts#g1", "function", "src/a.ts", 1),
    ];
    const changed = new Set(["src/b.ts", "src/c.ts"]);
    const flows: LogicFlows = {
      "ts:src/b.ts#f1": [call("ts:src/a.ts#g1")],
      "ts:src/b.ts#f2": [call("ts:src/a.ts#g1")],
      "ts:src/b.ts#f2b": [call("ts:src/a.ts#g1")],
      "ts:src/c.ts#f3": [call("ts:src/a.ts#g1")],
      "ts:src/a.ts#g1": [call("ts:src/b.ts#f1")], // impacted: owner src/a.ts unchanged
      "ts:src/z.ts#zz": [call("ts:src/c.ts#f3")], // impacted, owner not in nodes ⇒ ownerFile null
    };
    const order = computeAffectedFlows(sortNodes, flows, changed).map((flow) => flow.flowId);
    expect(order).toEqual([
      "ts:src/b.ts#f2",
      "ts:src/b.ts#f2b",
      "ts:src/b.ts#f1",
      "ts:src/c.ts#f3",
      "ts:src/a.ts#g1",
      "ts:src/z.ts#zz",
    ]);
  });
});

// ── flowFingerprint ─────────────────────────────────────────────────────────

describe("flowFingerprint", () => {
  const steps: FlowStep[] = [
    { kind: "branch", label: "if", paths: [{ label: "then", body: [call("ts:src/b.ts#fb")] }] },
  ];

  it("is a stable 8-char hex string across calls", () => {
    const first = flowFingerprint(steps);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(flowFingerprint(steps)).toBe(first);
  });

  it("changes when any step changes", () => {
    const base = flowFingerprint(steps);
    const relabelled: FlowStep[] = [
      { kind: "branch", label: "if", paths: [{ label: "else", body: [call("ts:src/b.ts#fb")] }] },
    ];
    const retargeted: FlowStep[] = [
      { kind: "branch", label: "if", paths: [{ label: "then", body: [call("ts:src/c.ts#fc")] }] },
    ];
    expect(flowFingerprint(relabelled)).not.toBe(base);
    expect(flowFingerprint(retargeted)).not.toBe(base);
    expect(flowFingerprint([])).not.toBe(base);
  });
});
