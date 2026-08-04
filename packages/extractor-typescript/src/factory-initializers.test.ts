/**
 * Module-scope factory results are values, not functions. When an inline initializer callback
 * owns named lexical helpers, retain the callback under an explicit synthetic identity so its
 * body and helpers remain reviewable without pretending the factory result is callable.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeAffectedFlows,
  computeAffectedNodes,
  type ChangedFile,
  type ExtractionResult,
  type FlowStep,
  type GraphEdge,
  type GraphNode,
} from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = `import { load } from "./deps";

declare function create<T>(initializer: (set: () => void, get: () => T) => T): T;
declare function buildApi<T>(callback: () => T): T;
declare function subscribe(callback: () => void): unknown;
declare function noop(): void;

export const store = create((set, get) => {
  const helper = (): void => {
    load();
  };
  helper();
  set();
  return get();
});

export const api = buildApi(() => noop());
export const subscription = subscribe((() => noop()) as () => void);
export const mapped = [1].map((() => {
  const iteratee = (): void => noop();
  iteratee();
  return 1;
}) as () => number);
store();

export const subscriptionWithHelper = subscribe((() => {
  const onChange = (): void => noop();
  onChange();
}) as () => void);
subscriptionWithHelper();

export const wrappedStore = (create((set, get) => {
  const wrappedHelper = (): void => noop();
  wrappedHelper();
  set();
  return get();
}) as unknown);
wrappedStore();
`;
const DEPS = `export function load(): void {}\n`;

let root: string;
let result: ExtractionResult;
let repeated: ExtractionResult;
let moduleDepth: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-factory-initializers-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "store.ts"), SOURCE);
  writeFileSync(join(root, "src", "deps.ts"), DEPS);
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root, include: ["src/**/*.ts"] });
  repeated = await extractor.extract({ root, include: ["src/**/*.ts"] });
  moduleDepth = await extractor.extract({ root, include: ["src/**/*.ts"], depth: "module" });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function node(qualifiedName: string, file = "src/store.ts"): GraphNode | undefined {
  return result.nodes.find(
    (candidate) => candidate.location.file === file && candidate.qualifiedName === qualifiedName,
  );
}

function id(qualifiedName: string, file = "src/store.ts"): string {
  const match = node(qualifiedName, file);
  expect(match, `missing ${file}#${qualifiedName}`).toBeDefined();
  return match!.id;
}

function hasCall(source: string, target: string): boolean {
  return result.edges.some(
    (edge: GraphEdge) => edge.kind === "calls" && edge.source === source && edge.target === target,
  );
}

function allCallLabels(steps: readonly FlowStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind === "call") return [step.label];
    if (step.kind === "loop" || step.kind === "callback") return allCallLabels(step.body);
    if (step.kind === "branch") return step.paths.flatMap((path) => allCallLabels(path.body));
    return [];
  });
}

function changedAt(line: number): ChangedFile[] {
  return [{ path: "src/store.ts", status: "modified", hunks: [{ start: line, end: line }] }];
}

describe("module-scope callbacks passed to value-producing calls", () => {
  it("emits stable callback/helper identities, parentage, and exact source locations", () => {
    const callback = node("store.<callback>");
    const helper = node("store.<callback>.helper");

    expect(callback).toMatchObject({
      id: "ts:src/store.ts#store.<callback>",
      kind: "function",
      displayName: "store callback",
      parentId: "ts:src/store.ts",
      location: { file: "src/store.ts", startLine: 8, endLine: 15 },
    });
    expect(callback?.telemetry).toBeUndefined();
    expect(helper).toMatchObject({
      id: "ts:src/store.ts#store.<callback>.helper",
      kind: "function",
      displayName: "helper",
      parentId: callback?.id,
      location: { file: "src/store.ts", startLine: 9, endLine: 11 },
    });
    expect(node("store")).toBeUndefined();
  });

  it("keeps result values non-callable while representing rich callbacks truthfully", () => {
    const storeCallbackId = id("store.<callback>");
    const subscriptionCallbackId = id("subscriptionWithHelper.<callback>");
    const wrappedCallbackId = id("wrappedStore.<callback>");
    expect(node("api")).toBeUndefined();
    expect(node("api.<callback>")).toBeUndefined();
    expect(node("subscription")).toBeUndefined();
    expect(node("subscription.<callback>")).toBeUndefined();
    expect(node("mapped")).toBeUndefined();
    expect(node("mapped.<callback>")).toBeUndefined();
    expect(node("subscriptionWithHelper")).toBeUndefined();
    expect(node("subscriptionWithHelper.<callback>.onChange")?.parentId).toBe(subscriptionCallbackId);
    expect(node("wrappedStore")).toBeUndefined();
    expect(node("wrappedStore.<callback>.wrappedHelper")?.parentId).toBe(wrappedCallbackId);
    const moduleSteps = result.flows?.["ts:src/store.ts"] ?? [];
    expect(moduleSteps.filter((step) => step.kind === "loop")).toHaveLength(1);
    const conciseSubscription = moduleSteps.find(
      (step) => step.kind === "callback" && step.label === "callback → subscribe",
    );
    expect(conciseSubscription?.kind).toBe("callback");
    if (conciseSubscription?.kind === "callback") {
      expect(allCallLabels(conciseSubscription.body)).toEqual(["noop"]);
    }
    // These calls resolve through the VariableDeclaration only if a callback was falsely anchored
    // there. A callback-anchored synthetic node can never become a result value's call target.
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          [storeCallbackId, subscriptionCallbackId, wrappedCallbackId].includes(edge.target),
      ),
    ).toBe(false);
  });

  it("attributes calls and flows to the callback/helper that actually owns them", () => {
    const moduleId = "ts:src/store.ts";
    const callbackId = id("store.<callback>");
    const helperId = id("store.<callback>.helper");
    const subscriptionCallbackId = id("subscriptionWithHelper.<callback>");
    const onChangeId = id("subscriptionWithHelper.<callback>.onChange");
    const loadId = id("load", "src/deps.ts");
    const noopId = id("noop");

    expect(hasCall(moduleId, id("create"))).toBe(true);
    expect(hasCall(moduleId, id("subscribe"))).toBe(true);
    expect(hasCall(callbackId, helperId)).toBe(true);
    expect(hasCall(helperId, loadId)).toBe(true);
    expect(hasCall(moduleId, helperId)).toBe(false);
    expect(hasCall(subscriptionCallbackId, onChangeId)).toBe(true);
    expect(hasCall(onChangeId, noopId)).toBe(true);
    expect(hasCall(moduleId, onChangeId)).toBe(false);

    expect(allCallLabels(result.flows?.[callbackId] ?? [])).toEqual(["helper", "set", "get"]);
    expect(allCallLabels(result.flows?.[helperId] ?? [])).toEqual(["load"]);
    expect(allCallLabels(result.flows?.[subscriptionCallbackId] ?? [])).toEqual(["onChange"]);
    expect(allCallLabels(result.flows?.[onChangeId] ?? [])).toEqual(["noop"]);
    expect(allCallLabels(result.flows?.[moduleId] ?? [])).not.toContain("helper");
    expect(allCallLabels(result.flows?.[moduleId] ?? [])).not.toContain("load");
  });

  it("collapses both function-rank nodes and reattributes their cross-module edge", () => {
    expect(moduleDepth.nodes.some((candidate) => candidate.id.includes("<callback>"))).toBe(false);
    expect(moduleDepth.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "calls",
          source: "ts:src/store.ts",
          target: "ts:src/deps.ts",
          resolution: "resolved",
        }),
      ]),
    );
  });

  it("projects helper-only and callback-own-line changes onto the right review unit", () => {
    const helperId = id("store.<callback>.helper");
    const callbackId = id("store.<callback>");
    const helperChange = changedAt(10);

    expect(computeAffectedNodes(result.nodes, helperChange).map((entry) => entry.nodeId)).toEqual([
      helperId,
    ]);
    expect(computeAffectedNodes(result.nodes, changedAt(8)).map((entry) => entry.nodeId)).toEqual([
      callbackId,
    ]);
    expect(computeAffectedFlows(result.nodes, result.flows ?? {}, helperChange)).toEqual([
      expect.objectContaining({ flowId: helperId, ownerChanged: true }),
      expect.objectContaining({
        flowId: callbackId,
        ownerChanged: false,
        changedFilesHit: ["src/store.ts"],
      }),
    ]);
  });

  it("is deterministic across independent cold extraction calls", () => {
    expect({
      nodes: repeated.nodes,
      edges: repeated.edges,
      flows: repeated.flows,
      ports: repeated.ports,
    }).toEqual({
      nodes: result.nodes,
      edges: result.edges,
      flows: result.flows,
      ports: result.ports,
    });
  });
});
