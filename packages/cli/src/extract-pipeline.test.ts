import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionDiagnostic, ExtractionResult, LanguageTag } from "@meridian/core";
import { selectInitialTypeScriptProjectionFiles } from "@meridian/extractor-typescript";
import { selectInitialPythonProjectionFiles } from "@meridian/extractor-python";
import { CliError, EXIT } from "./errors";
import { extractToArtifact, selectExtractors } from "./extract-pipeline";

const fake = vi.hoisted(() => ({
  typescript: { detects: true, files: 1, nodeKind: "module", diagnostics: [] as ExtractionDiagnostic[] },
  python: { detects: false, files: 0, nodeKind: "module", diagnostics: [] as ExtractionDiagnostic[] },
}));

vi.mock("@meridian/extractor-typescript", () => ({
  MAX_INITIAL_PROJECTION_SELECTED_FILES: 20_000,
  TypeScriptExtractor: class FakeTypeScriptExtractor {
    readonly language = "typescript";
    readonly displayName = "Fake TypeScript";
    readonly extensions = [".ts", ".tsx"];
    async detect() { return detection(fake.typescript.detects); }
    async extract() { return extraction("typescript", "ts", fake.typescript); }
  },
  selectInitialTypeScriptProjectionFiles: vi.fn(({ seeds }: { seeds: string[] }) => ({
    files: [...seeds],
    seeds: [...seeds],
    frontier: [],
  })),
}));

vi.mock("@meridian/extractor-python", () => ({
  PythonExtractor: class FakePythonExtractor {
    readonly language = "python";
    readonly displayName = "Fake Python";
    readonly extensions = [".py"];
    async detect() { return detection(fake.python.detects); }
    async extract() { return extraction("python", "py", fake.python); }
  },
  selectInitialPythonProjectionFiles: vi.fn(async ({ seeds }: { seeds: string[] }) => ({
    files: [...seeds],
    extractionFiles: [...seeds],
    seeds: [...seeds],
    frontier: [],
  })),
}));

describe("extractToArtifact diagnostics", () => {
  beforeEach(() => {
    Object.assign(fake.typescript, { detects: true, files: 1, nodeKind: "module", diagnostics: [] });
    Object.assign(fake.python, { detects: false, files: 0, nodeKind: "module", diagnostics: [] });
  });

  it("returns normalized extractor warnings together with validation warnings", async () => {
    fake.typescript.nodeKind = "futureNode";
    fake.typescript.diagnostics = [{
      severity: "warn",
      message: "symbol resolution\n  used a fallback",
      nodeId: "ts:src/app.ts",
    }];

    const result = await extractToArtifact(request());

    expect(result.warnings).toEqual([
      "Fake TypeScript: symbol resolution used a fallback [ts:src/app.ts]",
      "node ts:src/app.ts has unregistered kind 'futureNode'",
    ]);
  });

  it("fails with extractor exit 4 and caps multiline error diagnostic details", async () => {
    fake.typescript.diagnostics = Array.from({ length: 22 }, (_, index) => ({
      severity: "error" as const,
      message: `failure ${index + 1}\nfrom analyzer`,
      nodeId: "ts:src/app.ts",
    }));

    const error = await extractToArtifact(request()).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      exitCode: EXIT.extractor,
      message: "Fake TypeScript extraction reported 22 error diagnostics",
    });
    expect((error as CliError).details).toHaveLength(21);
    expect((error as CliError).details[0]).toBe("  - Fake TypeScript: failure 1 from analyzer [ts:src/app.ts]");
    expect((error as CliError).details.at(-1)).toBe("  … and 2 more");
  });

  it("reports only extractors that produced files while retaining attempted-extractor warnings", async () => {
    fake.python.detects = true;
    fake.python.diagnostics = [{ severity: "warn", message: "no import roots were inferred" }];

    const result = await extractToArtifact(request());

    expect(result.extractors.map((extractor) => extractor.language)).toEqual(["typescript"]);
    expect(result.warnings).toContain("Fake Python: no import roots were inferred");
  });

  it("fails when every selected extractor produces zero files", async () => {
    fake.typescript.files = 0;

    await expect(extractToArtifact(request())).rejects.toMatchObject({
      exitCode: EXIT.extractor,
      message: "detected extractors found no source files under /repo",
    });
  });

  it("allows an explicitly empty side while preserving every hinted language", async () => {
    Object.assign(fake.typescript, { detects: false, files: 0 });
    Object.assign(fake.python, { detects: false, files: 0 });

    const result = await extractToArtifact({
      ...request(),
      hintedFiles: ["frontend/app.ts", "backend/app.py"],
      allowEmpty: true,
    });

    expect(result.extractors.map((extractor) => extractor.language)).toEqual(["typescript", "python"]);
    expect(result.extraction).toMatchObject({
      language: "mixed",
      nodes: [],
      edges: [],
      stats: { files: 0 },
    });
    expect(result.artifact.target.language).toBe("mixed");
  });

  it("allows an empty bounded projection without weakening canonical empty extraction", async () => {
    fake.typescript.files = 0;

    const result = await extractToArtifact({
      ...request(),
      initialGraph: { depth: 1, seedFiles: [] },
    });

    expect(result.extractors.map((extractor) => extractor.language)).toEqual(["typescript"]);
    expect(result.extraction.stats.files).toBe(0);
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: [],
      selectedFiles: [],
      frontierFiles: [],
    });
  });

  it("combines bounded TypeScript and Python neighbourhoods without canonical fallback", async () => {
    fake.python.detects = true;
    fake.python.files = 1;

    const result = await extractToArtifact({
      ...request(),
      initialGraph: { depth: 1, seedFiles: ["src/app.ts", "worker/job.py"] },
    });

    expect(selectInitialPythonProjectionFiles).toHaveBeenCalledWith(expect.objectContaining({
      seeds: ["worker/job.py"],
      depth: 1,
    }));
    expect(result.artifact.extensions?.prInitialGraph).toMatchObject({
      seedFiles: ["src/app.ts", "worker/job.py"],
      selectedFiles: ["src/app.ts", "worker/job.py"],
      frontierFiles: [],
    });
    expect(result.artifact.target.language).toBe("mixed");
  });

  it("fails before Python selection when TypeScript exhausts the aggregate initial slice cap", async () => {
    fake.python.detects = true;
    fake.python.files = 1;
    vi.mocked(selectInitialTypeScriptProjectionFiles).mockReturnValueOnce({
      files: Array.from({ length: 20_000 }, (_, index) => `src/${String(index).padStart(5, "0")}.ts`),
      seeds: ["src/app.ts"],
      frontier: [],
    });
    vi.mocked(selectInitialPythonProjectionFiles).mockClear();

    await expect(extractToArtifact({
      ...request(),
      initialGraph: { depth: 1, seedFiles: ["src/app.ts", "worker/job.py"] },
    })).rejects.toMatchObject({
      exitCode: EXIT.extractor,
      message: "initial source graph exceeded its aggregate selected-file limit",
    });
    expect(selectInitialPythonProjectionFiles).not.toHaveBeenCalled();
  });

  it("uses a child-validated topology preselection without rescanning the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-preselected-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/app.ts"), "export const app = true;\n");
    try {
      vi.mocked(selectInitialTypeScriptProjectionFiles).mockClear();
      const result = await extractToArtifact({
        absoluteRoot: root,
        cwd: root,
        materializeBoundary: false,
        initialGraph: {
          depth: 2,
          seedFiles: ["src/app.ts"],
          selectedFiles: ["src/app.ts"],
          extractionFiles: ["src/app.ts"],
          frontierFiles: [],
          lineage: {
            graphId: "pr-partial-0123456789abcdefabcd-" + "a".repeat(40),
            generation: "b".repeat(64),
          },
        },
      });

      expect(selectInitialTypeScriptProjectionFiles).not.toHaveBeenCalled();
      expect(result.artifact.extensions).toMatchObject({
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 2,
          seedFiles: ["src/app.ts"],
          selectedFiles: ["src/app.ts"],
          frontierFiles: [],
        },
        prPartialGraph: {
          version: 1,
          graphId: "pr-partial-0123456789abcdefabcd-" + "a".repeat(40),
          generation: "b".repeat(64),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts child preselection in the shared UTF-16 binary order", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-preselected-order-"));
    const selectedFiles = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/😀.ts",
      "src/\uE000.ts",
    ];
    mkdirSync(join(root, "src"));
    for (const path of selectedFiles) writeFileSync(join(root, path), "export {};\n");
    try {
      vi.mocked(selectInitialTypeScriptProjectionFiles).mockClear();
      const result = await extractToArtifact({
        absoluteRoot: root,
        cwd: root,
        materializeBoundary: false,
        initialGraph: {
          depth: 1,
          seedFiles: selectedFiles,
          selectedFiles,
          extractionFiles: selectedFiles,
          frontierFiles: [],
          lineage: {
            graphId: "pr-partial-0123456789abcdefabcd-" + "c".repeat(40),
            generation: "d".repeat(64),
          },
        },
      });

      expect(selectInitialTypeScriptProjectionFiles).not.toHaveBeenCalled();
      expect(result.artifact.extensions?.prInitialGraph).toMatchObject({
        seedFiles: selectedFiles,
        selectedFiles,
        frontierFiles: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractor hints", () => {
  beforeEach(() => {
    fake.typescript.detects = false;
    fake.python.detects = false;
  });

  it("selects the registered language for a deeply nested changed file", async () => {
    const extractors = await selectExtractors("/repo", ["products/risk/internal/v1/rules.PY"]);
    expect(extractors.map((extractor) => extractor.language)).toEqual(["python"]);
  });
});

function request() {
  return { absoluteRoot: "/repo", cwd: "/repo", materializeBoundary: false };
}

function detection(matches: boolean) {
  return { matches, confidence: matches ? 1 : 0, reason: matches ? "fixture" : "none" };
}

function extraction(
  language: LanguageTag,
  idLanguage: string,
  state: { files: number; nodeKind: string; diagnostics: ExtractionDiagnostic[] },
): ExtractionResult {
  const nodes = state.files > 0
    ? [{
        id: `${idLanguage}:src/app.${idLanguage === "py" ? "py" : "ts"}`,
        kind: state.nodeKind,
        qualifiedName: "src/app",
        displayName: "app",
        summary: null,
        parentId: null,
        location: { file: `src/app.${idLanguage === "py" ? "py" : "ts"}`, startLine: 1, endLine: 1 },
      }]
    : [];
  return {
    language,
    nodes,
    edges: [],
    stats: {
      files: state.files,
      nodeCountByKind: state.files > 0 ? { [state.nodeKind]: 1 } : {},
      edgeCountByResolution: {},
      summaryCoverage: { withSummary: 0, total: nodes.length },
      externalCallsDropped: 0,
      unresolvedCalls: 0,
    },
    diagnostics: state.diagnostics,
  } as ExtractionResult;
}
