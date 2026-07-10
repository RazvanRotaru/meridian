import { describe, expect, it } from "vitest";
import { computeChangeGroups } from "./change-groups";
import type { ChangedFile, GraphEdge, GraphNode, LogicFlows } from "./index";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1, endLine: undefined },
  };
}

function mod(file: string): GraphNode {
  return node(`ts:${file}`, "module", file);
}

function edge(source: string, target: string, kind: string, resolution?: GraphEdge["resolution"]): GraphEdge {
  return { id: `${source}->${target}`, source, target, kind, resolution };
}

function changed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, status: "modified" }));
}

function groupFiles(result: { groups: { files: string[] }[] }): string[][] {
  return result.groups.map((group) => group.files);
}

describe("computeChangeGroups — connectivity", () => {
  it("splits changed files with no edge between them into separate groups", () => {
    const nodes = [mod("src/a.ts"), mod("src/b.ts")];
    const result = computeChangeGroups(nodes, [], changed("src/a.ts", "src/b.ts"));
    expect(groupFiles(result)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("merges two changed modules joined by a resolved module→module imports edge", () => {
    const nodes = [mod("src/a.ts"), mod("src/b.ts")];
    // resolution omitted ⇒ treated as resolved (coverage.ts precedent).
    const edges = [edge("ts:src/a.ts", "ts:src/b.ts", "imports")];
    const result = computeChangeGroups(nodes, edges, changed("src/a.ts", "src/b.ts"));
    expect(groupFiles(result)).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(result.groups[0].moduleIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("merges via a lifted leaf `calls` edge alone — the Python parity case (no imports edges)", () => {
    const nodes = [
      mod("src/a.ts"),
      mod("src/b.ts"),
      node("ts:src/a.ts#f", "function", "src/a.ts", "ts:src/a.ts"),
      node("ts:src/b.ts#g", "function", "src/b.ts", "ts:src/b.ts"),
    ];
    const edges = [edge("ts:src/a.ts#f", "ts:src/b.ts#g", "calls", "resolved")];
    const result = computeChangeGroups(nodes, edges, changed("src/a.ts", "src/b.ts"));
    expect(groupFiles(result)).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("keeps two changed modules apart when they only share an UNCHANGED neighbor (A → X ← B)", () => {
    const nodes = [mod("src/a.ts"), mod("src/b.ts"), mod("src/x.ts")];
    const edges = [
      edge("ts:src/a.ts", "ts:src/x.ts", "imports", "resolved"),
      edge("ts:src/b.ts", "ts:src/x.ts", "imports", "resolved"),
    ];
    // x.ts is NOT in the changed set, so neither edge has two changed-module endpoints.
    const result = computeChangeGroups(nodes, edges, changed("src/a.ts", "src/b.ts"));
    expect(groupFiles(result)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("ignores external/unresolved connecting edges", () => {
    const nodes = [mod("src/a.ts"), mod("src/b.ts")];
    const edges = [
      edge("ts:src/a.ts", "ts:src/b.ts", "imports", "external"),
      edge("ts:src/a.ts", "ts:src/b.ts", "imports", "unresolved"),
    ];
    const result = computeChangeGroups(nodes, edges, changed("src/a.ts", "src/b.ts"));
    expect(groupFiles(result)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });
});

describe("computeChangeGroups — ungrouped files", () => {
  it("lists changed paths with no matching module node", () => {
    const nodes = [mod("src/a.ts")];
    const result = computeChangeGroups(nodes, [], changed("src/a.ts", "docs/readme.md"));
    expect(groupFiles(result)).toEqual([["src/a.ts"]]);
    expect(result.ungroupedFiles).toEqual(["docs/readme.md"]);
  });
});

describe("computeChangeGroups — labels", () => {
  it("labels a single-file group with the file's basename", () => {
    const nodes = [mod("src/services/SearchBox.tsx")];
    const result = computeChangeGroups(nodes, [], changed("src/services/SearchBox.tsx"));
    expect(result.groups[0].label).toBe("SearchBox.tsx");
  });

  it("labels a multi-file group with the discriminating common directory", () => {
    const nodes = [mod("src/services/a.ts"), mod("src/services/b.ts"), mod("lib/x.ts")];
    const edges = [edge("ts:src/services/a.ts", "ts:src/services/b.ts", "imports", "resolved")];
    const result = computeChangeGroups(nodes, edges, changed("src/services/a.ts", "src/services/b.ts", "lib/x.ts"));
    const services = result.groups.find((group) => group.files.length === 2);
    // Common dir `src/services` is deeper than the global root (`src` and `lib` share nothing).
    expect(services?.label).toBe("src/services");
  });

  it("falls back to `+`-joined next-level dirs when the common dir is just the non-discriminating root", () => {
    const nodes = [mod("src/api/a.ts"), mod("src/services/b.ts"), mod("src/ui/c.tsx")];
    const edges = [
      edge("ts:src/api/a.ts", "ts:src/services/b.ts", "imports", "resolved"),
      edge("ts:src/services/b.ts", "ts:src/ui/c.tsx", "imports", "resolved"),
    ];
    const result = computeChangeGroups(nodes, edges, changed("src/api/a.ts", "src/services/b.ts", "src/ui/c.tsx"));
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe("api+services+ui");
  });

  it("caps the `+`-join at three names with a trailing ellipsis", () => {
    const files = ["src/a1/x.ts", "src/a2/x.ts", "src/a3/x.ts", "src/a4/x.ts"];
    const nodes = files.map(mod);
    const edges = [
      edge("ts:src/a1/x.ts", "ts:src/a2/x.ts", "imports", "resolved"),
      edge("ts:src/a2/x.ts", "ts:src/a3/x.ts", "imports", "resolved"),
      edge("ts:src/a3/x.ts", "ts:src/a4/x.ts", "imports", "resolved"),
    ];
    const result = computeChangeGroups(nodes, edges, changed(...files));
    expect(result.groups[0].label).toBe("a1+a2+a3+…");
  });
});

describe("computeChangeGroups — flows", () => {
  const nodes = [
    mod("src/a.ts"),
    mod("src/b.ts"),
    node("ts:src/a.ts#f1", "function", "src/a.ts", "ts:src/a.ts"),
    node("ts:src/a.ts#f2", "function", "src/a.ts", "ts:src/a.ts"),
    node("ts:src/b.ts#g1", "function", "src/b.ts", "ts:src/b.ts"),
    node("ts:src/b.ts#g2", "function", "src/b.ts", "ts:src/b.ts"),
  ];
  const flows: LogicFlows = {
    "ts:src/a.ts#f1": [],
    "ts:src/b.ts#g1": [],
    // f2 lives in group A but calls into group B — a cross-group flow.
    "ts:src/a.ts#f2": [{ kind: "call", label: "g2", target: "ts:src/b.ts#g2", resolution: "resolved" }],
  };

  it("assigns flows per group and lists a cross-group flow in both groups and crossGroupFlowIds", () => {
    const result = computeChangeGroups(nodes, [], changed("src/a.ts", "src/b.ts"), flows);
    const groupA = result.groups.find((group) => group.files[0] === "src/a.ts");
    const groupB = result.groups.find((group) => group.files[0] === "src/b.ts");
    expect(groupA?.flowIds).toEqual(["ts:src/a.ts#f1", "ts:src/a.ts#f2"]);
    expect(groupB?.flowIds).toEqual(["ts:src/a.ts#f2", "ts:src/b.ts#g1"]);
    expect(result.crossGroupFlowIds).toEqual(["ts:src/a.ts#f2"]);
  });

  it("leaves flowIds empty when no flows are supplied", () => {
    const result = computeChangeGroups(nodes, [], changed("src/a.ts", "src/b.ts"));
    expect(result.groups.every((group) => group.flowIds.length === 0)).toBe(true);
    expect(result.crossGroupFlowIds).toEqual([]);
  });
});

describe("computeChangeGroups — determinism", () => {
  it("produces an identical result (ids included) regardless of input order", () => {
    const nodes = [
      mod("src/a.ts"),
      mod("src/b.ts"),
      mod("src/c.ts"),
      node("ts:src/a.ts#f", "function", "src/a.ts", "ts:src/a.ts"),
      node("ts:src/b.ts#g", "function", "src/b.ts", "ts:src/b.ts"),
    ];
    const edges = [edge("ts:src/a.ts#f", "ts:src/b.ts#g", "calls", "resolved")];
    const files = changed("src/a.ts", "src/b.ts", "src/c.ts");
    const forward = computeChangeGroups(nodes, edges, files);
    const reversed = computeChangeGroups([...nodes].reverse(), [...edges].reverse(), [...files].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.groups.map((group) => group.id)).toEqual(reversed.groups.map((group) => group.id));
  });
});
