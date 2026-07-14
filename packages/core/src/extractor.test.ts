import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "./extractor";
import { mergeExtractionResults } from "./extractor";

const TYPESCRIPT: ExtractionResult = {
  language: "typescript",
  nodes: [
    {
      id: "ts:src/app.ts",
      kind: "module",
      qualifiedName: "src/app.ts",
      displayName: "app.ts",
      parentId: null,
      location: { file: "src/app.ts", startLine: 1, endLine: 8 },
    },
  ],
  edges: [
    {
      id: "imports@ts:src/app.ts|ext:npm/react",
      source: "ts:src/app.ts",
      target: "ext:npm/react",
      kind: "imports",
      resolution: "external",
      weight: 1,
      callSites: [{ file: "src/app.ts", line: 1 }],
    },
  ],
  stats: {
    files: 2,
    nodeCountByKind: { module: 1, function: 2 },
    edgeCountByResolution: { resolved: 3, external: 1, unresolved: 0 },
    summaryCoverage: { withSummary: 2, total: 3 },
    externalCallsDropped: 4,
    unresolvedCalls: 1,
  },
  diagnostics: [{ severity: "warn", message: "typescript warning", nodeId: "ts:src/app.ts" }],
  flows: {
    "ts:src/app.ts#start": [{ kind: "exit", variant: "return", label: null }],
  },
  ports: [
    {
      nodeId: "ts:src/app.ts",
      direction: "out",
      protocol: "http",
      channel: "GET /health",
      label: "/health",
      callSite: { file: "src/app.ts", line: 4 },
    },
  ],
};

const PYTHON: ExtractionResult = {
  language: "python",
  nodes: [
    {
      id: "py:backend.app",
      kind: "module",
      qualifiedName: "backend.app",
      displayName: "app",
      parentId: null,
      location: { file: "src/backend/app.py", startLine: 1, endLine: 5 },
    },
  ],
  edges: [],
  stats: {
    files: 1,
    nodeCountByKind: { module: 1, class: 1 },
    edgeCountByResolution: { resolved: 2, external: 0, unresolved: 1 },
    summaryCoverage: { withSummary: 1, total: 2 },
    externalCallsDropped: 2,
    unresolvedCalls: 3,
  },
  diagnostics: [{ severity: "error", message: "python diagnostic" }],
  flows: {
    "py:backend.app#serve": [{ kind: "exit", variant: "return", label: "response" }],
  },
  ports: [
    {
      nodeId: "py:backend.app",
      direction: "in",
      protocol: "http",
      channel: "GET /health",
      label: "/health",
      callSite: { file: "src/backend/app.py", line: 3 },
    },
  ],
};

describe("mergeExtractionResults", () => {
  it("merges every language and all extractor side channels into one mixed result", () => {
    const merged = mergeExtractionResults([TYPESCRIPT, PYTHON]);

    expect(merged.language).toBe("mixed");
    expect(merged.nodes).toEqual([
      { ...TYPESCRIPT.nodes[0], language: "typescript" },
      { ...PYTHON.nodes[0], language: "python" },
    ]);
    expect(TYPESCRIPT.nodes[0]).not.toHaveProperty("language");
    expect(PYTHON.nodes[0]).not.toHaveProperty("language");
    expect(merged.edges).toEqual(TYPESCRIPT.edges);
    expect(merged.stats).toEqual({
      files: 3,
      nodeCountByKind: { module: 2, function: 2, class: 1 },
      edgeCountByResolution: { resolved: 5, external: 1, unresolved: 1 },
      summaryCoverage: { withSummary: 3, total: 5 },
      externalCallsDropped: 6,
      unresolvedCalls: 4,
    });
    expect(merged.diagnostics).toEqual([...TYPESCRIPT.diagnostics, ...PYTHON.diagnostics]);
    expect(merged.flows).toEqual({ ...TYPESCRIPT.flows, ...PYTHON.flows });
    expect(merged.ports).toEqual([...TYPESCRIPT.ports!, ...PYTHON.ports!]);
  });

  it("preserves a single extractor's language and omits empty optional channels", () => {
    const source = { ...PYTHON, flows: undefined, ports: undefined };
    const merged = mergeExtractionResults([source]);

    expect(merged.language).toBe("python");
    expect(merged.nodes[0]).not.toHaveProperty("language");
    expect(merged.flows).toBeUndefined();
    expect(merged.ports).toBeUndefined();
  });

  it("rejects an empty extraction set", () => {
    expect(() => mergeExtractionResults([])).toThrow("cannot merge an empty extraction set");
  });
});
