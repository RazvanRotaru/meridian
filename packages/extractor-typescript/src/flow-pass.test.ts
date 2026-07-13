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

export function iterate(items: string[]) {
  prep();
  items.forEach((x) => {
    seen(x);
    if (x) {
      mark();
    }
  });
  done();
}
function prep() {}
function seen(x: string) {}
function mark() {}
function done() {}

export function iterateNamed(items: string[], handler: (x: string) => void) {
  items.forEach(handler);
}

export function iterateFrom() {
  getItems().forEach((x) => {
    use(x);
  });
}
function getItems(): string[] { return []; }
function use(x: string) {}

export async function placeOrder(flag: boolean) {
  if (!flag) {
    audit();
    return reject();
  }
  const data = await fetchData();
  void track(data);
  send(data).then((r) => log(r));
  return data;
}
function audit() {}
function reject() { return null; }
async function fetchData() { return {}; }
async function track(x: unknown) {}
async function send(x: unknown) { return x; }
function log(x: unknown) {}

export function longGuard(user: { role: string; active: boolean; verified: boolean; banned: boolean }) {
  if (user.role === "admin" && user.active && user.verified && !user.banned) {
    grant();
  }
}
function grant() {}

export function longLoop(items: number[]) {
  while (items.length > 0 && items[0] > 0 && items[items.length - 1] < 100) {
    drain();
  }
}
function drain() {}

export function withEmptyIterations(items: { id: string }[]) {
  doReal();
  const ids = items.map((x) => x.id);
  const evens = items.filter((x) => x.id.length > 0);
  return ids.length + evens.length;
}
function doReal() {}
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
    if (step.kind === "loop" || step.kind === "callback") return allCallLabels(step.body);
    if (step.kind === "branch") return step.paths.flatMap((path) => allCallLabels(path.body));
    return [];
  });
}

describe("logic-flow pass", () => {
  it("omits a callable with no calls or control structures (add)", () => {
    expect(stepsFor("add")).toBeUndefined();
  });

  it("keeps the full condition on a truncated branch label for the hover (longGuard)", () => {
    const branch = stepsFor("longGuard")?.find((step) => step.kind === "branch");
    expect(branch?.kind).toBe("branch");
    const b = branch as Extract<FlowStep, { kind: "branch" }>;
    // The displayed label stays compact — clipped with an ellipsis.
    expect(b.label.startsWith("if ")).toBe(true);
    expect(b.label.endsWith("…")).toBe(true);
    // …but the hover carries the whole condition, nothing lost.
    expect(b.fullLabel).toBe('if user.role === "admin" && user.active && user.verified && !user.banned');
    expect(b.fullLabel).not.toContain("…");
  });

  it("omits fullLabel when the condition already fits (render)", () => {
    const branch = stepsFor("render")?.find((step) => step.kind === "branch");
    const b = branch as Extract<FlowStep, { kind: "branch" }>;
    expect(b.label).toBe("if items.length === 0");
    expect(b.fullLabel).toBeUndefined();
  });

  it("keeps the full loop header on a truncated loop label for the hover (longLoop)", () => {
    const loop = stepsFor("longLoop")?.find((step) => step.kind === "loop");
    expect(loop?.kind).toBe("loop");
    const l = loop as Extract<FlowStep, { kind: "loop" }>;
    expect(l.label.startsWith("while ")).toBe(true);
    expect(l.label.endsWith("…")).toBe(true);
    expect(l.label).not.toContain("< 100"); // the tail was clipped from the compact label…
    expect(l.fullLabel).toContain("< 100"); // …but survives whole in the hover form
    expect(l.fullLabel).not.toContain("…");
  });

  it("omits a loop's fullLabel when its header already fits (sumScores)", () => {
    const loop = stepsFor("sumScores")?.find((step) => step.kind === "loop");
    const l = loop as Extract<FlowStep, { kind: "loop" }>;
    expect(l.label).toBe("for each id");
    expect(l.fullLabel).toBeUndefined();
  });

  it("drops array iterations whose callback charts no calls (withEmptyIterations)", () => {
    const steps = stepsFor("withEmptyIterations");
    expect(steps).toBeDefined();
    // The empty `.map`/`.filter` transforms would otherwise chart as childless loop containers
    // (zero-size ghost nodes); only the real call survives.
    expect(steps!.filter((step) => step.kind === "loop")).toEqual([]);
    expect(callLabels(steps!)).toContain("doReal");
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
        // The early return is charted, not swallowed: the then-path visibly EXITS the flow.
        expect(branch.paths[0].body).toEqual([{ kind: "exit", variant: "return", label: "res" }]);
      }
    }
  });

  it("charts returns as exit steps and stamps awaited/detached call flags (placeOrder)", () => {
    const steps = stepsFor("placeOrder") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["branch", "call", "call", "call", "call", "callback", "exit"]);

    const guard = steps[0];
    expect(guard.kind).toBe("branch");
    if (guard.kind === "branch") {
      expect(guard.paths.map((path) => path.label)).toEqual(["then"]);
      expect(guard.paths[0].body.map((step) => step.kind)).toEqual(["call", "call", "exit"]);
      expect(guard.paths[0].body[2]).toEqual({ kind: "exit", variant: "return", label: "reject()" });
    }

    expect(steps[1]).toMatchObject({ kind: "call", label: "fetchData", awaited: true });
    expect(steps[1]).not.toHaveProperty("detached");
    expect(steps[2]).toMatchObject({ kind: "call", label: "track", detached: true });
    // `send(data).then(cb)` standing alone is ONE hand-off: the head call carries the detached
    // flag; the continuation call itself stays unflagged so one statement never fans out into
    // several detached lanes downstream.
    expect(steps[3]).toMatchObject({ kind: "call", label: "send", detached: true });
    expect(steps[4]).toMatchObject({ kind: "call", label: "then" });
    expect(steps[4]).not.toHaveProperty("detached");
    expect(steps[5]).toMatchObject({ kind: "callback" });
    if (steps[5].kind === "callback") {
      expect(callLabels(steps[5].body)).toEqual(["log"]);
    }
    expect(steps[6]).toEqual({ kind: "exit", variant: "return", label: "data" });
  });

  it("leaves plain synchronous calls unflagged (checkout)", () => {
    const first = (stepsFor("checkout") ?? [])[0];
    expect(first).not.toHaveProperty("awaited");
    expect(first).not.toHaveProperty("detached");
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

  it("lifts an inline forEach callback into a loop with the callback body walked (iterate)", () => {
    const steps = stepsFor("iterate") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call", "loop", "call"]);
    expect(steps[0]).toMatchObject({ kind: "call", label: "prep" });
    expect(steps[2]).toMatchObject({ kind: "call", label: "done" });
    const loop = steps[1];
    expect(loop.kind).toBe("loop");
    if (loop.kind === "loop") {
      expect(loop.label).toBe("for each x");
      expect(loop.body.map((step) => step.kind)).toEqual(["call", "branch"]);
      expect(callLabels(loop.body)).toEqual(["seen"]);
      const branch = loop.body[1];
      if (branch.kind === "branch") {
        expect(branch.label).toBe("if x");
        expect(callLabels(branch.paths[0].body)).toEqual(["mark"]);
      }
    }
  });

  it("keeps a non-inline (named) iteration callback as a plain call, not a loop (iterateNamed)", () => {
    const steps = stepsFor("iterateNamed") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call"]);
    expect(steps[0]).toMatchObject({ kind: "call", label: "items.forEach" });
  });

  it("emits receiver calls before the iteration loop (iterateFrom)", () => {
    const steps = stepsFor("iterateFrom") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call", "loop"]);
    expect(steps[0]).toMatchObject({ kind: "call", label: "getItems" });
    const loop = steps[1];
    expect(loop.kind).toBe("loop");
    if (loop.kind === "loop") {
      expect(loop.label).toBe("for each x");
      expect(callLabels(loop.body)).toEqual(["use"]);
    }
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
