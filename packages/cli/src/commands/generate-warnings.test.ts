import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ExtractionResult, GraphArtifact, LanguageExtractor } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { attachIstanbulCoverage } from "../istanbul-coverage";
import { readJsonFile, writeJsonAtomic } from "../json-io";
import { validateOrThrow } from "../validation";
import { reportGenerate } from "./generate-report";
import { runGenerate } from "./generate";
import { CliError, EXIT } from "../errors";

vi.mock("../repository-analysis", () => ({ analyzeRepository: vi.fn() }));
vi.mock("../istanbul-coverage", () => ({ attachIstanbulCoverage: vi.fn() }));
vi.mock("../json-io", () => ({ readJsonFile: vi.fn(), writeJsonAtomic: vi.fn() }));
vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, validateOrThrow: vi.fn() };
});
vi.mock("./generate-report", () => ({ reportGenerate: vi.fn() }));

const ARTIFACT = artifact("plain");
const COVERED_ARTIFACT = artifact("covered");
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
const EXTRACTOR = {
  language: "typescript",
  displayName: "Fixture TypeScript",
  extensions: [".ts"],
} as LanguageExtractor;

describe("generate warning propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(analyzeRepository).mockResolvedValue({
      artifact: ARTIFACT,
      extraction: EXTRACTION,
      extractors: [EXTRACTOR],
      warnings: ["extractor warning", "duplicate warning"],
    });
    vi.mocked(readJsonFile).mockReturnValue({ coverage: true });
    vi.mocked(attachIstanbulCoverage).mockReturnValue(COVERED_ARTIFACT);
    vi.mocked(validateOrThrow).mockReturnValue({
      artifact: COVERED_ARTIFACT,
      warnings: ["duplicate warning", "coverage validation warning"],
    });
  });

  it("retains extraction warnings through coverage validation and dedupes in first-seen order", async () => {
    await runGenerate(".", {
      cwd: "/repo",
      out: "graph.json",
      testCoverage: "coverage.json",
      quiet: true,
    });

    expect(writeJsonAtomic).toHaveBeenCalledWith("/repo/graph.json", COVERED_ARTIFACT);
    expect(reportGenerate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      warnings: ["extractor warning", "duplicate warning", "coverage validation warning"],
    }));
  });

  it("does not write or report when extraction fails on an error diagnostic", async () => {
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new CliError(
      EXIT.extractor,
      "Fixture extraction reported 1 error diagnostic",
    ));

    await expect(runGenerate(".", {
      cwd: "/repo",
      out: "graph.json",
      quiet: true,
    })).rejects.toMatchObject({ exitCode: EXIT.extractor });

    expect(writeJsonAtomic).not.toHaveBeenCalled();
    expect(reportGenerate).not.toHaveBeenCalled();
  });
});

function artifact(name: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name, root: ".", language: "typescript" },
    nodes: [],
    edges: [],
  };
}
