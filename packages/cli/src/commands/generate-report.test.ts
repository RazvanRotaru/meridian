import { describe, expect, it, vi } from "vitest";
import type { ExtractionResult, GraphArtifact, LanguageExtractor } from "@meridian/core";
import type { Reporter } from "../reporter";
import { reportGenerate } from "./generate-report";

describe("generate human warning report", () => {
  it("prints the warning count and at most twenty details while JSON retains the full list", () => {
    const info = vi.fn();
    const payload = vi.fn();
    const warnings = Array.from({ length: 22 }, (_, index) => `warning ${index + 1}`);

    reportGenerate({ info, payload } as unknown as Reporter, {
      extractors: [EXTRACTOR],
      depth: "function",
      artifact: ARTIFACT,
      extraction: EXTRACTION,
      warnings,
      outPath: "/repo/graph.json",
    });

    const lines = info.mock.calls.map(([line]) => line as string);
    expect(lines).toContain("validated   ok (22 warnings)");
    expect(lines).toContain("warning     warning 1");
    expect(lines).toContain("warning     warning 20");
    expect(lines).not.toContain("warning     warning 21");
    expect(lines).toContain("warning     … and 2 more");
    expect(lines.at(-1)).toBe("wrote       /repo/graph.json");
    expect(payload).toHaveBeenCalledWith(expect.objectContaining({ warnings }));
  });
});

const EXTRACTOR = {
  language: "typescript",
  displayName: "Fixture TypeScript",
  extensions: [".ts"],
} as LanguageExtractor;

const EXTRACTION = {
  language: "typescript",
  nodes: [],
  edges: [],
  diagnostics: [],
  stats: {
    files: 1,
    nodeCountByKind: {},
    edgeCountByResolution: {},
    summaryCoverage: { withSummary: 0, total: 0 },
    externalCallsDropped: 0,
    unresolvedCalls: 0,
  },
} satisfies ExtractionResult;

const ARTIFACT = {
  nodes: [],
  edges: [],
} as unknown as GraphArtifact;
