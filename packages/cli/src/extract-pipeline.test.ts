import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionDiagnostic, ExtractionResult, LanguageTag } from "@meridian/core";
import { CliError, EXIT } from "./errors";
import { extractToArtifact, selectExtractors } from "./extract-pipeline";

const fake = vi.hoisted(() => ({
  typescript: { detects: true, files: 1, nodeKind: "module", diagnostics: [] as ExtractionDiagnostic[] },
  python: { detects: false, files: 0, nodeKind: "module", diagnostics: [] as ExtractionDiagnostic[] },
}));

vi.mock("@meridian/extractor-typescript", () => ({
  TypeScriptExtractor: class FakeTypeScriptExtractor {
    readonly language = "typescript";
    readonly displayName = "Fake TypeScript";
    readonly extensions = [".ts", ".tsx"];
    async detect() { return detection(fake.typescript.detects); }
    async extract() { return extraction("typescript", "ts", fake.typescript); }
  },
}));

vi.mock("@meridian/extractor-python", () => ({
  PythonExtractor: class FakePythonExtractor {
    readonly language = "python";
    readonly displayName = "Fake Python";
    readonly extensions = [".py"];
    async detect() { return detection(fake.python.detects); }
    async extract() { return extraction("python", "py", fake.python); }
  },
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
