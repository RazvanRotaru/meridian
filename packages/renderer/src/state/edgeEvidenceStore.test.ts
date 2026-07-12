import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { EdgeEvidenceContext } from "../graph/edgeEvidence";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, EDGE_EVIDENCE_CONTEXT_LINES, type StoreDependencies } from "./store";

const SOURCE_ID = "ts:src/a.ts#A.run";
const TARGET_ID = "ts:src/b.ts#B.go";

function node(id: string, file: string): GraphNode {
  return {
    id,
    kind: "method",
    qualifiedName: id,
    displayName: id.split("#").at(-1) ?? id,
    location: { file, startLine: 1, endLine: 300 },
  };
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [node(SOURCE_ID, "src/a.ts"), node(TARGET_ID, "src/b.ts")],
  edges: [],
};

function freshStore(extra?: Partial<StoreDependencies>) {
  return createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: "/api/source?id=fixture",
    prsUrl: "/api/prs",
    prOneUrl: "/api/prs/one",
    prFilesUrl: "/api/prs/files",
    prRelatedUrl: "/api/prs/related",
    prCommentsUrl: "/api/prs/comments",
    prChecksUrl: "/api/prs/checks",
    prReviewUrl: "/api/prs/review",
    ...extra,
  });
}

function context(
  file = "src/a.ts",
  line = 100,
  endLine = 102,
  kind = "calls",
): EdgeEvidenceContext {
  return {
    edgeId: `${kind}@${SOURCE_ID}|${TARGET_ID}`,
    source: SOURCE_ID,
    target: TARGET_ID,
    kind,
    site: { file, line, col: 4, endLine, endCol: 18 },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { location: { origin: "http://meridian.local" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("edge source evidence store", () => {
  it("opens contextual source with generous context and exact focused rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      code: Array.from({ length: 163 }, (_, index) => `line ${index + 20}`).join("\n"),
      startLine: 20,
      truncated: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();

    await store.getState().showEdgeEvidence([context()]);

    const request = new URL(fetchMock.mock.calls[0]![0].toString());
    expect(request.searchParams.get("file")).toBe("src/a.ts");
    expect(request.searchParams.get("start")).toBe(String(100 - EDGE_EVIDENCE_CONTEXT_LINES));
    expect(request.searchParams.get("end")).toBe(String(102 + EDGE_EVIDENCE_CONTEXT_LINES));
    expect(store.getState().codeView).toMatchObject({
      mode: "modal",
      loading: false,
      baseLine: 20,
      edgeEvidence: {
        activeIndex: 0,
        focusStartLine: 100,
        focusEndLine: 102,
      },
    });
  });

  it("navigates between same-edge occurrences and loads the selected file on demand", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "one\ntwo\nthree", truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore();
    const contexts = [context(), context("src/b.ts", 12, 12, "registers")];

    await store.getState().showEdgeEvidence(contexts);
    await store.getState().selectEdgeEvidence(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1]![0].toString()).searchParams.get("file")).toBe("src/b.ts");
    expect(store.getState().codeView?.edgeEvidence).toMatchObject({
      activeIndex: 1,
      focusStartLine: 12,
      focusEndLine: 12,
    });
  });

  it("maps base-artifact evidence into PR-head coordinates before highlighting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      code: Array.from({ length: 400 }, (_, index) => `head ${index + 1}`).join("\n"),
      truncated: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ prFileUrl: "/api/prs/file" });
    store.setState({
      prReviewed: 7,
      reviewHeadRef: "feature",
      reviewDiffByFile: {
        "src/a.ts": {
          edits: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 3 }],
          kinds: [],
        },
      },
      reviewFileDelta: { "src/a.ts": { added: 2, deleted: 0, status: "modified" } },
    });

    await store.getState().showEdgeEvidence([context()]);

    expect(new URL(fetchMock.mock.calls[0]![0].toString()).pathname).toBe("/api/prs/file");
    expect(store.getState().codeView?.edgeEvidence).toMatchObject({
      focusStartLine: 102,
      focusEndLine: 104,
    });
  });

  it("does not invent a source modal when the session has no source capability", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = freshStore({ sourceUrl: null });
    await store.getState().showEdgeEvidence([context()]);
    expect(store.getState().codeView).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes edge evidence without dismissing an unrelated source panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "one", truncated: false })));
    const store = freshStore();
    await store.getState().showEdgeEvidence([context()]);

    store.getState().closeEdgeEvidence();
    expect(store.getState().codeView).toBeNull();

    const ordinary = {
      node: ARTIFACT.nodes[0]!,
      code: "ordinary",
      loading: false,
      error: null,
      mode: "modal" as const,
    };
    store.setState({ codeView: ordinary });
    store.getState().closeEdgeEvidence();
    expect(store.getState().codeView).toBe(ordinary);
  });

  it("cannot resurrect contextual source after the dock closes during a request", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; })));
    const store = freshStore();

    const pending = store.getState().showEdgeEvidence([context()]);
    expect(store.getState().codeView?.loading).toBe(true);
    store.getState().closeEdgeEvidence();
    resolve(Response.json({ code: "late", truncated: false }));
    await pending;

    expect(store.getState().codeView).toBeNull();
  });

  it("clears prior contextual source when the newly inspected wire has no source sites", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "one", truncated: false })));
    const store = freshStore();
    await store.getState().showEdgeEvidence([context()]);

    await store.getState().showEdgeEvidence([]);

    expect(store.getState().codeView).toBeNull();
  });
});
