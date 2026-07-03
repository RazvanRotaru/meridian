/**
 * Golden test for the logic-flow pass: extract a fixture of hand-picked specimens and assert
 * the exact `FlowStep` tree each callable produces — kinds, order, nesting, call labels and
 * resolved targets. Covers linearity, execution order, loops, if/else, switch-less branches,
 * loops-with-branches, and try/catch, plus the "empty flow is omitted" rule — and a module's
 * top-level (load-time) code charted as the module node's own flow.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, FlowStep } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = `
export function add(a: number, b: number) {
  const x = a * 2;
  return x + b;
}

export function checkout() {
  validate();
  price();
  save();
  notify();
}
function validate() {}
function price() {}
function save() {}
function notify() {}

export function sumScores(ids: string[]) {
  let total = fetchScore(ids[0]);
  for (const id of ids) {
    total += fetchScore(id);
  }
  return total;
}
function fetchScore(id: string) { return 0; }

export function render(items: string[]) {
  if (items.length === 0) {
    emptyState();
  } else {
    list();
  }
}
function emptyState() {}
function list() {}

export function handleNested(x: string) {
  return respond(transform(parse(x)));
}
function parse(x: string) { return x; }
function transform(x: string) { return x; }
function respond(x: string) { return x; }

export function getWithRetry() {
  for (let i = 0; i < 3; i++) {
    const res = fetch();
    if (res) {
      return res;
    }
    backoff();
    wait();
  }
}
function fetch(): unknown { return null; }
function backoff() {}
function wait() {}

export function handleTry() {
  try {
    doWork();
  } catch (e) {
    report(e);
    fallback();
  }
}
function doWork() {}
function report(e: unknown) {}
function fallback() {}
`;

// A module whose top-level runs at load: a call, a branch, a loop — plus declarations that do
// NOT run at load (helper's body is helper's own flow, not the module's).
const MODULE_SOURCE = `
const flag = true;
const xs: number[] = [1, 2, 3];

setup();
if (flag) {
  enable();
}
for (const x of xs) {
  handle(x);
}

export function helper() {
  ignored();
}

function setup() {}
function enable() {}
function handle(x: number) {}
function ignored() {}
`;

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-flow-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "specimens.ts"), SOURCE);
  writeFileSync(join(root, "src", "boot.ts"), MODULE_SOURCE);
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root, include: ["src/**/*.ts"] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function idOf(qualname: string): string | undefined {
  return result.nodes.find((node) => node.qualifiedName === qualname)?.id;
}

function stepsFor(qualname: string): FlowStep[] | undefined {
  const id = idOf(qualname);
  return id ? result.flows?.[id] : undefined;
}

function callLabels(steps: FlowStep[]): string[] {
  return steps.filter((step) => step.kind === "call").map((step) => (step as { label: string }).label);
}

// Every call label anywhere in a flow tree, in execution order — used to prove a call is absent.
function allCallLabels(steps: FlowStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind === "call") return [step.label];
    if (step.kind === "loop") return allCallLabels(step.body);
    return step.paths.flatMap((path) => allCallLabels(path.body));
  });
}

describe("logic-flow pass", () => {
  it("omits a callable with no calls or control structures (add)", () => {
    expect(stepsFor("add")).toBeUndefined();
  });

  it("emits linear calls in source order with resolved targets (checkout)", () => {
    const steps = stepsFor("checkout") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call", "call", "call", "call"]);
    expect(callLabels(steps)).toEqual(["validate", "price", "save", "notify"]);
    const first = steps[0];
    expect(first.kind).toBe("call");
    if (first.kind === "call") {
      expect(first.resolution).toBe("resolved");
      expect(first.target).toBe(idOf("validate"));
    }
  });

  it("nests a repeated call inside a for..of loop (sumScores)", () => {
    const steps = stepsFor("sumScores") ?? [];
    expect(steps[0]).toMatchObject({ kind: "call", label: "fetchScore" });
    const loop = steps[1];
    expect(loop.kind).toBe("loop");
    if (loop.kind === "loop") {
      expect(loop.label).toBe("for each id");
      expect(callLabels(loop.body)).toEqual(["fetchScore"]);
    }
  });

  it("splits an if/else into then and else paths (render)", () => {
    const steps = stepsFor("render") ?? [];
    expect(steps).toHaveLength(1);
    const branch = steps[0];
    expect(branch.kind).toBe("branch");
    if (branch.kind === "branch") {
      expect(branch.label).toBe("if items.length === 0");
      expect(branch.paths.map((path) => path.label)).toEqual(["then", "else"]);
      expect(callLabels(branch.paths[0].body)).toEqual(["emptyState"]);
      expect(callLabels(branch.paths[1].body)).toEqual(["list"]);
    }
  });

  it("emits nested-call arguments before their call (handleNested)", () => {
    expect(callLabels(stepsFor("handleNested") ?? [])).toEqual(["parse", "transform", "respond"]);
  });

  it("threads a branch and trailing calls through a loop (getWithRetry)", () => {
    const steps = stepsFor("getWithRetry") ?? [];
    expect(steps).toHaveLength(1);
    const loop = steps[0];
    expect(loop.kind).toBe("loop");
    if (loop.kind === "loop") {
      expect(loop.body.map((step) => step.kind)).toEqual(["call", "branch", "call", "call"]);
      expect(callLabels(loop.body)).toEqual(["fetch", "backoff", "wait"]);
      const branch = loop.body[1];
      if (branch.kind === "branch") {
        expect(branch.paths.map((path) => path.label)).toEqual(["then"]);
        expect(branch.paths[0].body).toEqual([]);
      }
    }
  });

  it("charts a module's top-level code as its load-time flow, skipping declarations (boot)", () => {
    const steps = stepsFor("src/boot.ts") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call", "branch", "loop"]);
    expect(steps[0]).toMatchObject({ kind: "call", label: "setup" });

    const branch = steps[1];
    expect(branch.kind).toBe("branch");
    if (branch.kind === "branch") {
      expect(branch.label).toBe("if flag");
      expect(branch.paths.map((path) => path.label)).toEqual(["then"]);
      expect(callLabels(branch.paths[0].body)).toEqual(["enable"]);
    }

    const loop = steps[2];
    expect(loop.kind).toBe("loop");
    if (loop.kind === "loop") {
      expect(loop.label).toBe("for each x");
      expect(callLabels(loop.body)).toEqual(["handle"]);
    }

    // helper() is declared at load, not run — its call to ignored() is helper's own flow.
    expect(allCallLabels(steps)).toEqual(["setup", "enable", "handle"]);
    expect(callLabels(stepsFor("helper") ?? [])).toEqual(["ignored"]);
  });

  it("maps try/catch to try and catch paths (handleTry)", () => {
    const steps = stepsFor("handleTry") ?? [];
    expect(steps).toHaveLength(1);
    const branch = steps[0];
    expect(branch.kind).toBe("branch");
    if (branch.kind === "branch") {
      expect(branch.label).toBe("try/catch");
      expect(branch.paths.map((path) => path.label)).toEqual(["try", "catch e"]);
      expect(callLabels(branch.paths[0].body)).toEqual(["doWork"]);
      expect(callLabels(branch.paths[1].body)).toEqual(["report", "fallback"]);
    }
  });
});
