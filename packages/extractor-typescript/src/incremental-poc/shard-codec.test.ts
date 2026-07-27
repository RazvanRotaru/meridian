import { describe, expect, it } from "vitest";
import { decodeUnitExtraction } from "./shard-codec";

describe("immutable unit shard decoding", () => {
  it("accepts a minimal schema-v2 unit payload", () => {
    expect(decodeUnitExtraction(validPayload())).toMatchObject({
      nodes: [],
      rawEdges: [],
      flows: {},
      files: 0,
    });
  });

  it.each([
    ["null node", (value: Record<string, unknown>) => { value.nodes = [null]; }],
    ["null raw edge", (value: Record<string, unknown>) => { value.rawEdges = [null]; }],
    ["null flow", (value: Record<string, unknown>) => { value.flows = { owner: null }; }],
    ["null port", (value: Record<string, unknown>) => { value.ports = [null]; }],
    ["null diagnostic", (value: Record<string, unknown>) => { value.diagnostics = [null]; }],
    ["null re-export", (value: Record<string, unknown>) => {
      (value.summary as Record<string, unknown>).pendingReexports = [null];
    }],
    ["negative file count", (value: Record<string, unknown>) => { value.files = -1; }],
  ])("rejects a structurally invalid %s", (_name, mutate) => {
    const value = validPayload();
    mutate(value);
    expect(() => decodeUnitExtraction(value)).toThrow(
      /invalid immutable TypeScript unit (?:shard payload|summary)/,
    );
  });
});

function validPayload(): Record<string, unknown> {
  return {
    nodes: [],
    rawEdges: [],
    implementationMembers: [],
    flows: {},
    ports: [],
    summary: {
      dir: "packages/example",
      name: "@fixture/example",
      entryFile: "packages/example/src/index.ts",
      sourceDir: "packages/example/src",
      exportsByFile: [],
      moduleIdByRelPath: [],
      pendingReexports: [],
    },
    diagnostics: [],
    files: 0,
  };
}
