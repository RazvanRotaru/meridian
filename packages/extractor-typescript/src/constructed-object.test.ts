/** Constructed singleton bindings are first-class objects and own both their uses and creation. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-constructed-object-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "semanticActionBus.ts"), [
    "export class SemanticActionBus {}",
    "export const semanticActionBus = new SemanticActionBus();",
  ].join("\n"));
  writeFileSync(join(root, "src", "middleware.ts"), [
    'import { semanticActionBus } from "./semanticActionBus";',
    "export function defaultPorts() {",
    "  return { bus: semanticActionBus };",
    "}",
  ].join("\n"));
  result = await createTypeScriptExtractor().extract({
    root,
    include: ["src/**/*.ts"],
    valueRefs: true,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("constructed singleton objects", () => {
  it("emits a new-initialized binding as an object node", () => {
    expect(node("semanticActionBus")).toMatchObject({ kind: "object", displayName: "semanticActionBus" });
  });

  it("connects an imported value use directly to the singleton object", () => {
    expect(edge("references", "defaultPorts", "semanticActionBus")).toMatchObject({
      callSites: [expect.objectContaining({ file: "src/middleware.ts", line: 3 })],
    });
  });

  it("sources construction from the singleton object instead of its module", () => {
    expect(edge("instantiates", "semanticActionBus", "SemanticActionBus")).toMatchObject({
      callSites: [expect.objectContaining({ file: "src/semanticActionBus.ts", line: 2 })],
    });
    const busModule = result.nodes.find((candidate) => candidate.qualifiedName === "src/semanticActionBus.ts");
    expect(result.edges).not.toContainEqual(expect.objectContaining({
      kind: "instantiates",
      source: busModule?.id,
      target: node("SemanticActionBus")?.id,
    }));
  });
});

function node(qualifiedName: string) {
  return result.nodes.find((candidate) => candidate.qualifiedName === qualifiedName);
}

function edge(kind: string, source: string, target: string): GraphEdge | undefined {
  return result.edges.find((candidate) =>
    candidate.kind === kind
    && candidate.source === node(source)?.id
    && candidate.target === node(target)?.id,
  );
}
