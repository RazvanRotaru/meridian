import { describe, expect, it } from "vitest";
import {
  readTestExecutionCoverage,
  type GraphArtifact,
} from "@meridian/core";
import { CliError, EXIT } from "./errors";
import { attachIstanbulCoverage, importIstanbulCoverage } from "./istanbul-coverage";
import { buildProgram } from "./program";

const SPAN = {
  start: { line: 4, column: 2 },
  end: { line: 8, column: 3 },
};

function artifact(files = ["src/order.ts"]): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "meridian", version: "0.1.0" },
    target: { name: "orders", root: ".", language: "typescript" },
    nodes: files.map((file, index) => ({
      id: `ts:${file}#fn${index}`,
      kind: "function",
      qualifiedName: `fn${index}`,
      displayName: `fn${index}`,
      location: { file, startLine: 4 },
    })),
    edges: [],
    extensions: { existing: true },
  };
}

function fileCoverage(path: string, functionHits = 0, branchHits: number[] = [2, 0]): Record<string, unknown> {
  return {
    path,
    statementMap: { "0": SPAN },
    fnMap: { "0": { name: "placeOrder", decl: SPAN, loc: SPAN, line: 4 } },
    branchMap: { "0": { type: "if", loc: SPAN, locations: [SPAN, SPAN], line: 4 } },
    s: { "0": 2 },
    f: { "0": functionHits },
    b: { "0": branchHits },
  };
}

describe("importIstanbulCoverage", () => {
  it("maps absolute, Windows, and relative report paths to extraction-root-relative POSIX files", () => {
    const cases = [
      { root: "/repo", key: "/repo/src/order.ts", path: "/repo/src/order.ts" },
      { root: "C:\\repo", key: "C:\\repo\\src\\order.ts", path: "C:/repo/src/order.ts" },
      { root: "/repo", key: "src/order.ts", path: "src/order.ts" },
    ];
    for (const entry of cases) {
      const result = importIstanbulCoverage(
        { [entry.key]: fileCoverage(entry.path) },
        artifact(),
        entry.root,
      );
      expect(Object.keys(result.files)).toEqual(["src/order.ts"]);
    }
  });

  it("preserves explicit zero function and branch-path counts and source coordinates", () => {
    const result = importIstanbulCoverage(
      { "/repo/src/order.ts": fileCoverage("/repo/src/order.ts") },
      artifact(),
      "/repo",
    );
    expect(result.files["src/order.ts"]?.functions[0]).toMatchObject({
      name: "placeOrder",
      hits: 0,
      decl: SPAN,
      location: SPAN,
    });
    expect(result.files["src/order.ts"]?.branches[0]).toEqual({
      type: "if",
      location: SPAN,
      paths: [
        { index: 0, hits: 2, location: SPAN },
        { index: 1, hits: 0, location: SPAN },
      ],
    });
  });

  it("accepts Vitest V8 null columns and empty implicit-else locations", () => {
    const raw = fileCoverage("/repo/src/order.ts");
    raw.statementMap = { "0": { start: {}, end: {} } };
    raw.fnMap = {
      "0": {
        name: "placeOrder",
        decl: { start: { line: 4, column: 2 }, end: { line: 4, column: null } },
        loc: { start: { line: 4, column: 2 }, end: { line: 8, column: null } },
      },
    };
    raw.branchMap = {
      "0": {
        type: "if",
        loc: { start: { line: 4, column: 2 }, end: { line: 8, column: null } },
        locations: [
          { start: { line: 4, column: 2 }, end: { line: 8, column: null } },
          { start: {}, end: {} },
        ],
      },
    };

    const result = importIstanbulCoverage(
      { "/repo/src/order.ts": raw },
      artifact(),
      "/repo",
    );
    const file = result.files["src/order.ts"]!;
    expect(file.functions[0]?.decl.end).toEqual({ line: 4 });
    expect(file.branches[0]?.location.end).toEqual({ line: 8 });
    expect(file.branches[0]?.paths).toEqual([
      {
        index: 0,
        hits: 2,
        location: { start: { line: 4, column: 2 }, end: { line: 8 } },
      },
      { index: 1, hits: 0 },
    ]);
  });

  it("omits unmatched files instead of manufacturing zero evidence", () => {
    const result = importIstanbulCoverage(
      { "/repo/src/unrelated.ts": fileCoverage("/repo/src/unrelated.ts") },
      artifact(),
      "/repo",
    );
    expect(result.files).toEqual({});
  });

  it("refuses an ambiguous suffix rather than guessing a graph file", () => {
    try {
      importIstanbulCoverage(
        { "/other/src/order.ts": fileCoverage("/other/src/order.ts") },
        artifact(["src/order.ts", "order.ts"]),
        "/repo",
      );
      throw new Error("expected ambiguous coverage path to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).details.join("\n")).toMatch(/ambiguously matches/);
    }
  });

  it("strictly rejects malformed maps, mismatched ids, bad counters, and escaping paths", () => {
    const missing = fileCoverage("/repo/src/order.ts");
    delete missing.fnMap;
    const mismatched = fileCoverage("/repo/src/order.ts");
    mismatched.f = { "1": 1 };
    const negative = fileCoverage("/repo/src/order.ts");
    negative.b = { "0": [1, -1] };

    for (const candidate of [
      { "/repo/src/order.ts": missing },
      { "/repo/src/order.ts": mismatched },
      { "/repo/src/order.ts": negative },
      { "../src/order.ts": fileCoverage("../src/order.ts") },
    ]) {
      try {
        importIstanbulCoverage(candidate, artifact(), "/repo");
        throw new Error("expected coverage validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT.validation);
      }
    }
  });

  it("attaches a defensively readable extension without replacing existing extensions", () => {
    const attached = attachIstanbulCoverage(
      artifact(),
      { "/repo/src/order.ts": fileCoverage("/repo/src/order.ts") },
      "/repo",
    );
    expect(attached.extensions?.existing).toBe(true);
    expect(readTestExecutionCoverage(attached)?.files["src/order.ts"]?.functions[0]?.hits).toBe(0);
  });
});

describe("test coverage command wiring", () => {
  it("offers --test-coverage on generate and the single web launcher only", () => {
    const program = buildProgram();
    const generate = program.commands.find((command) => command.name() === "generate");
    const web = program.commands.find((command) => command.name() === "web");
    const coverage = program.commands.find((command) => command.name() === "coverage");
    expect(generate?.options.some((option) => option.long === "--test-coverage")).toBe(true);
    expect(web?.options.some((option) => option.long === "--test-coverage")).toBe(true);
    expect(coverage?.options.some((option) => option.long === "--test-coverage")).toBe(false);
  });
});
