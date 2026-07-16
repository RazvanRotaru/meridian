/**
 * Named lexical helpers are first-class graph nodes. This is especially important for event/RPC
 * setup: the outer callback is the trigger, while a nested helper owns the async work that follows.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = `
function leaf(): void {}

export function wire(on: (event: string, callback: () => void) => void): void {
  function declared(): void {
    leaf();
  }

  const replay = async (): Promise<void> => {
    const push = (): void => {
      leaf();
    };
    push();
  };

  on("ready", async () => {
    const synchronize = async (): Promise<void> => {
      await replay();
    };
    await synchronize();
  });

  declared();
}

export function makeBinding() {
  const replay = (): void => {
    leaf();
  };
  return { replay };
}

export function invokeBinding(): void {
  const binding = makeBinding();
  binding.replay();
}
`;

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-nested-callables-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "wire.ts"), SOURCE);
  result = await createTypeScriptExtractor().extract({ root, include: ["src/**/*.ts"] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function id(qualifiedName: string): string {
  const node = result.nodes.find((candidate) => candidate.qualifiedName === qualifiedName);
  expect(node, `missing ${qualifiedName}`).toBeDefined();
  return node!.id;
}

function hasCall(source: string, target: string): boolean {
  const sourceId = id(source);
  const targetId = id(target);
  return result.edges.some(
    (edge: GraphEdge) => edge.kind === "calls" && edge.source === sourceId && edge.target === targetId,
  );
}

describe("nested named callables", () => {
  it("emits declarations and callable consts under their nearest named owner", () => {
    expect(result.nodes.find((node) => node.qualifiedName === "wire.declared")?.parentId).toBe(id("wire"));
    expect(result.nodes.find((node) => node.qualifiedName === "wire.replay")?.parentId).toBe(id("wire"));
    expect(result.nodes.find((node) => node.qualifiedName === "wire.synchronize")?.parentId).toBe(id("wire"));
    expect(result.nodes.find((node) => node.qualifiedName === "wire.replay.push")?.parentId).toBe(id("wire.replay"));
  });

  it("attributes calls to the helper that actually owns them", () => {
    expect(hasCall("wire", "wire.declared")).toBe(true);
    expect(hasCall("wire", "wire.synchronize")).toBe(true);
    expect(hasCall("wire.declared", "leaf")).toBe(true);
    expect(hasCall("wire.synchronize", "wire.replay")).toBe(true);
    expect(hasCall("wire.replay", "wire.replay.push")).toBe(true);
    expect(hasCall("wire.replay.push", "leaf")).toBe(true);
    expect(hasCall("invokeBinding", "makeBinding.replay")).toBe(true);
  });

  it("gives every nested helper its own logic flow", () => {
    expect(result.flows?.[id("wire.synchronize")]).toEqual([
      expect.objectContaining({ kind: "call", label: "replay", awaited: true }),
    ]);
    expect(result.flows?.[id("wire.replay")]).toEqual([
      expect.objectContaining({ kind: "call", label: "push" }),
    ]);
  });
});
