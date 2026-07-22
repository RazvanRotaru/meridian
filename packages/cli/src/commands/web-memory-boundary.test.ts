import { describe, expect, it, vi } from "vitest";

const evaluations = vi.hoisted(() => ({
  extractPipeline: 0,
  pythonExtractor: 0,
  repositoryAnalysis: 0,
  syntheticExecution: 0,
  tsMorph: 0,
  typescriptExtractor: 0,
}));

vi.mock("../repository-analysis", () => {
  evaluations.repositoryAnalysis += 1;
  return {
    analyzeRepository: vi.fn(),
    REPOSITORY_ANALYSIS_POLICY: "test-policy",
    REPOSITORY_ANALYSIS_VERSION: 1,
  };
});

vi.mock("../extract-pipeline", () => {
  evaluations.extractPipeline += 1;
  return { extractToArtifact: vi.fn(), selectExtractors: vi.fn() };
});

vi.mock("@meridian/extractor-typescript", () => {
  evaluations.typescriptExtractor += 1;
  return { TypeScriptExtractor: class TypeScriptExtractor {} };
});

vi.mock("@meridian/extractor-python", () => {
  evaluations.pythonExtractor += 1;
  return { PythonExtractor: class PythonExtractor {} };
});

vi.mock("ts-morph", () => {
  evaluations.tsMorph += 1;
  return {};
});

vi.mock("../server/synthetic-execution", () => {
  evaluations.syntheticExecution += 1;
  return {
    loadSyntheticScenarios: vi.fn(() => []),
    syntheticExecutionRuntimeSupported: vi.fn(() => false),
    syntheticSourceFingerprint: vi.fn(),
  };
});

describe("web parent process memory boundary", () => {
  it("loads the web command without evaluating graph extraction or synthetic AST machinery", async () => {
    const { runWeb } = await import("./web");

    expect(runWeb).toBeTypeOf("function");
    expect(evaluations).toEqual({
      extractPipeline: 0,
      pythonExtractor: 0,
      repositoryAnalysis: 0,
      syntheticExecution: 0,
      tsMorph: 0,
      typescriptExtractor: 0,
    });
  });
});
