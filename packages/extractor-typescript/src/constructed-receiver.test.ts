/** Regression coverage for calls through deliberately untyped mutable instance storage. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const FRAMEWORK_SOURCE = `
export class ChatFramework {
  async initialize(): Promise<void> {}
}

export class AlternateFramework {
  async initialize(): Promise<void> {}
}
`;

const SOURCE = `
export class DelegateClient {
  private framework: any = null;

  async init(): Promise<void> {
    const [{ ChatFramework }] = await Promise.all([import("./framework")]);
    this.framework = new ChatFramework();
    await this.framework.initialize();
  }

  destroy(): void {
    this.framework = null;
  }
}

export class AmbiguousClient {
  private framework: any = null;

  async init(alternate: boolean): Promise<void> {
    const [{ ChatFramework, AlternateFramework }] = await Promise.all([import("./framework")]);
    this.framework = new ChatFramework();
    if (alternate) this.framework = new AlternateFramework();
    await this.framework.initialize();
  }
}

export class ParameterClient {
  async init(framework: any, useConstructed: boolean): Promise<void> {
    const [{ ChatFramework }] = await Promise.all([import("./framework")]);
    if (useConstructed) framework = new ChatFramework();
    await framework.initialize();
  }
}

export class MutatedMemberClient {
  private framework: any = null;

  async init(): Promise<void> {
    const [{ ChatFramework }] = await Promise.all([import("./framework")]);
    this.framework = new ChatFramework();
    this.framework.initialize = async (): Promise<void> => {};
    await this.framework.initialize();
  }
}

export class UnionConstructorClient {
  private framework: any = null;

  async init(alternate: boolean): Promise<void> {
    const [{ ChatFramework, AlternateFramework }] = await Promise.all([import("./framework")]);
    const Constructor: typeof ChatFramework | typeof AlternateFramework = alternate
      ? AlternateFramework
      : ChatFramework;
    this.framework = new Constructor();
    await this.framework.initialize();
  }
}

export class DifferentInstanceClient {
  private framework: any = null;

  async init(other: DifferentInstanceClient): Promise<void> {
    const [{ ChatFramework }] = await Promise.all([import("./framework")]);
    this.framework = new ChatFramework();
    await other.framework.initialize();
  }
}

export class DeferredClient {
  private framework: any = null;

  async init(): Promise<void> {
    const [{ ChatFramework }] = await Promise.all([import("./framework")]);
    this.framework = new ChatFramework();
    queueMicrotask(() => this.framework.initialize());
  }
}
`;

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-constructed-receiver-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "framework.ts"), FRAMEWORK_SOURCE);
  writeFileSync(join(root, "src", "delegate.ts"), SOURCE);
  result = await createTypeScriptExtractor().extract({ root, include: ["src/**/*.ts"], includeUnresolved: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function id(qualifiedName: string): string {
  const node = result.nodes.find((candidate) => candidate.qualifiedName === qualifiedName);
  expect(node, `missing ${qualifiedName}`).toBeDefined();
  return node!.id;
}

function call(source: string, target: string): GraphEdge | undefined {
  return result.edges.find((edge) =>
    edge.kind === "calls"
    && edge.source === id(source)
    && edge.target === id(target),
  );
}

describe("constructed receiver call resolution", () => {
  it("resolves the direct call immediately following construction of the same receiver", () => {
    expect(call("DelegateClient.init", "ChatFramework.initialize")).toMatchObject({
      resolution: "resolved",
      callSites: [expect.objectContaining({ file: "src/delegate.ts", line: 8 })],
    });
    expect(result.flows?.[id("DelegateClient.init")]).toContainEqual(expect.objectContaining({
      kind: "call",
      label: "initialize",
      target: id("ChatFramework.initialize"),
      resolution: "resolved",
    }));
  });

  it("stays unresolved when direct writes construct different receiver types", () => {
    expect(call("AmbiguousClient.init", "ChatFramework.initialize")).toBeUndefined();
    expect(call("AmbiguousClient.init", "AlternateFramework.initialize")).toBeUndefined();
    expect(result.flows?.[id("AmbiguousClient.init")]).toContainEqual(expect.objectContaining({
      kind: "call",
      label: "initialize",
      resolution: "unresolved",
    }));
  });

  it.each([
    "ParameterClient.init",
    "MutatedMemberClient.init",
    "UnionConstructorClient.init",
    "DifferentInstanceClient.init",
  ])("does not guess a target for unsafe storage in %s", (source) => {
    expect(call(source, "ChatFramework.initialize")).toBeUndefined();
    expect(call(source, "AlternateFramework.initialize")).toBeUndefined();
    expect(result.flows?.[id(source)]?.some((step) =>
      step.kind === "call"
      && step.label.endsWith("initialize")
      && step.resolution === "unresolved",
    )).toBe(true);
  });

  it("does not treat a call captured by a deferred callback as the adjacent invocation", () => {
    expect(call("DeferredClient.init", "ChatFramework.initialize")).toBeUndefined();
    expect(call("DeferredClient.init", "AlternateFramework.initialize")).toBeUndefined();
  });
});
