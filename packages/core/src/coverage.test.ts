import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./types";
import { computeCoverage } from "./coverage";

function node(id: string, kind: string, file: string, parentId: string | null = null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

function edge(kind: string, source: string, target: string, resolution = "resolved"): GraphEdge {
  return { id: `${kind}@${source}|${target}`, source, target, kind, resolution: resolution as GraphEdge["resolution"] };
}

/**
 * Fixture: a test calls Service.place directly; place calls Repo.save (indirect);
 * Email.send is called only by the uncovered Routes.handle; Util.dead is never called.
 */
const NODES: GraphNode[] = [
  node("ts:src/svc", "module", "src/svc.ts"),
  node("ts:src/svc#Service", "class", "src/svc.ts", "ts:src/svc"),
  node("ts:src/svc#Service.place", "method", "src/svc.ts", "ts:src/svc#Service"),
  node("ts:src/svc#Service.cancel", "method", "src/svc.ts", "ts:src/svc#Service"),
  node("ts:src/repo#Repo.save", "method", "src/repo.ts"),
  node("ts:src/routes#Routes.handle", "method", "src/routes.ts"),
  node("ts:src/email#Email.send", "method", "src/email.ts"),
  node("ts:src/util#dead", "function", "src/util.ts"),
  node("ts:src/svc.test#t1", "function", "src/svc.test.ts"),
];

const EDGES: GraphEdge[] = [
  edge("calls", "ts:src/svc.test#t1", "ts:src/svc#Service.place"),
  edge("calls", "ts:src/svc#Service.place", "ts:src/repo#Repo.save"),
  edge("calls", "ts:src/routes#Routes.handle", "ts:src/svc#Service.place"),
  edge("calls", "ts:src/routes#Routes.handle", "ts:src/email#Email.send"),
  edge("calls", "ts:src/svc.test#t1", "unresolved:dynamic", "unresolved"),
];

describe("computeCoverage", () => {
  const report = computeCoverage(NODES, EDGES);

  it("labels direct, indirect, and uncovered callables", () => {
    expect(report.leaves["ts:src/svc#Service.place"].status).toBe("covered");
    expect(report.leaves["ts:src/svc#Service.place"].directTestCallers).toEqual(["ts:src/svc.test#t1"]);
    expect(report.leaves["ts:src/repo#Repo.save"]).toMatchObject({ status: "indirect", distance: 2 });
    expect(report.leaves["ts:src/email#Email.send"].status).toBe("uncovered");
    expect(report.leaves["ts:src/svc.test#t1"]).toBeUndefined(); // tests are not their own coverage subjects
  });

  it("explains WHY a callable is uncovered", () => {
    expect(report.leaves["ts:src/util#dead"].reason).toEqual({ kind: "never-called", callers: [] });
    expect(report.leaves["ts:src/email#Email.send"].reason).toEqual({
      kind: "only-uncovered-callers",
      callers: ["ts:src/routes#Routes.handle"],
    });
    // Routes.handle calls a covered method, but nothing reaches Routes.handle itself.
    expect(report.leaves["ts:src/routes#Routes.handle"].reason?.kind).toBe("never-called");
  });

  it("rolls containers up to a percentage", () => {
    // Service: place covered, cancel uncovered -> 50% partial; module sees the same two.
    expect(report.containers["ts:src/svc#Service"]).toMatchObject({ covered: 1, total: 2, percent: 50, status: "partial" });
    expect(report.containers["ts:src/svc"]).toMatchObject({ percent: 50, status: "partial" });
  });

  it("summarizes and surfaces unresolved test calls as a caveat", () => {
    expect(report.summary).toMatchObject({ callables: 6, covered: 1, indirect: 1, uncovered: 4, unresolvedFromTests: 1 });
    expect(report.summary.percent).toBe(33);
  });

  it("does not count non-callable function-depth resource nodes as coverage leaves", () => {
    const promiseId = "promise:src/svc.ts#Service.ready";
    const withResource = computeCoverage(
      [...NODES, node(promiseId, "promise", "src/svc.ts", "ts:src/svc#Service")],
      EDGES,
    );

    expect(withResource.leaves[promiseId]).toBeUndefined();
    expect(withResource.summary.callables).toBe(report.summary.callables);
    expect(withResource.containers["ts:src/svc#Service"]).toMatchObject({ total: 2, percent: 50 });
  });

  it("covers a constructor when a test instantiates its class", () => {
    const withCtor = computeCoverage(
      [
        ...NODES,
        node("ts:src/svc#Service.constructor", "method", "src/svc.ts", "ts:src/svc#Service"),
      ].map((n) => (n.id === "ts:src/svc#Service.constructor" ? { ...n, displayName: "constructor" } : n)),
      [...EDGES, edge("instantiates", "ts:src/svc.test#t1", "ts:src/svc#Service")],
    );
    expect(withCtor.leaves["ts:src/svc#Service.constructor"].status).toBe("covered");
  });

  it("does not treat unresolved edges as coverage", () => {
    const withUnresolved = computeCoverage(NODES, [
      ...EDGES,
      edge("calls", "ts:src/svc.test#t1", "ts:src/util#dead", "unresolved"),
    ]);
    expect(withUnresolved.leaves["ts:src/util#dead"].status).toBe("uncovered");
  });
});
