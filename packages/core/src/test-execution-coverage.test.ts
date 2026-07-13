import { describe, expect, it } from "vitest";
import { validArtifact } from "./testing/fixtures";
import { validateArtifact } from "./validate";
import {
  TEST_EXECUTION_COVERAGE_EXTENSION,
  TEST_EXECUTION_COVERAGE_VERSION,
  readTestExecutionCoverage,
  type TestExecutionCoverage,
} from "./test-execution-coverage";

function coverage(): TestExecutionCoverage {
  return {
    version: TEST_EXECUTION_COVERAGE_VERSION,
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: {
      "src/order.ts": {
        functions: [{
          name: "placeOrder",
          hits: 0,
          decl: { start: { line: 3, column: 0 }, end: { line: 3, column: 18 } },
          location: { start: { line: 3, column: 18 }, end: { line: 8, column: 1 } },
        }],
        branches: [{
          type: "if",
          location: { start: { line: 4, column: 2 }, end: { line: 6, column: 3 } },
          paths: [
            { index: 0, hits: 2, location: { start: { line: 4, column: 10 }, end: { line: 6, column: 3 } } },
            { index: 1, hits: 0, location: { start: { line: 4, column: 2 }, end: { line: 4, column: 10 } } },
          ],
        }],
      },
    },
  };
}

function artifactWith(value: unknown) {
  const artifact = validArtifact();
  artifact.extensions = { [TEST_EXECUTION_COVERAGE_EXTENSION]: value as never };
  return artifact;
}

describe("readTestExecutionCoverage", () => {
  it("remains valid GraphArtifact extension JSON without changing the artifact schema version", () => {
    const artifact = artifactWith(coverage());
    expect(artifact.schemaVersion).toBe("1.0.0");
    expect(validateArtifact(artifact).ok).toBe(true);
  });

  it("accepts the versioned provider-neutral shape and preserves explicit zero hits", () => {
    const result = readTestExecutionCoverage(artifactWith(coverage()));
    expect(result?.files["src/order.ts"]?.functions[0]?.hits).toBe(0);
    expect(result?.files["src/order.ts"]?.branches[0]?.paths[1]?.hits).toBe(0);
  });

  it("normalizes null columns and permits a branch path with no reporter location", () => {
    const value = structuredClone(coverage()) as unknown as {
      files: Record<string, { functions: Array<{ decl: { end: { column: number | null } } }>; branches: Array<{ paths: Array<{ location?: unknown }> }> }>;
    };
    value.files["src/order.ts"]!.functions[0]!.decl.end.column = null;
    delete value.files["src/order.ts"]!.branches[0]!.paths[1]!.location;

    const result = readTestExecutionCoverage(artifactWith(value));
    expect(result?.files["src/order.ts"]?.functions[0]?.decl.end).toEqual({ line: 3 });
    expect(result?.files["src/order.ts"]?.branches[0]?.paths[1]).toEqual({ index: 1, hits: 0 });
  });

  it("returns null for malformed spans, counters, versions, and non-relative paths", () => {
    const cases = [
      { ...coverage(), version: "2.0.0" },
      { ...coverage(), aggregate: false },
      { ...coverage(), files: { "/src/order.ts": coverage().files["src/order.ts"] } },
      { ...coverage(), files: { "src\\order.ts": coverage().files["src/order.ts"] } },
      { ...coverage(), files: { "../order.ts": coverage().files["src/order.ts"] } },
      { ...coverage(), files: { "src/order.ts": { functions: [], branches: [{ type: "if", location: {}, paths: [] }] } } },
      { ...coverage(), files: { "src/order.ts": { functions: [{ ...coverage().files["src/order.ts"]!.functions[0], hits: -1 }], branches: [] } } },
    ];
    for (const value of cases) {
      expect(readTestExecutionCoverage(artifactWith(value))).toBeNull();
    }
  });

  it("returns null when the extension is absent", () => {
    expect(readTestExecutionCoverage(validArtifact())).toBeNull();
  });
});
