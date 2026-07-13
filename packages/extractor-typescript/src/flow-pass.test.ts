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
import type { ExtractionResult, FlowSourceAnchor, FlowStep } from "@meridian/core";
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

export async function launchThenAwait() {
  const pending = firstTask();
  await pending;
}

export async function awaitDirectly() {
  await firstTask();
}

export async function awaitStoredBarrier() {
  const first = firstTask();
  const second = secondTask();
  await Promise.all([first, second]);
}

export async function awaitInlineBarrier() {
  await Promise.all([firstTask(), secondTask()]);
}

export async function awaitInlineSettledBarrier() {
  await Promise.allSettled([firstTask(), secondTask()]);
}

declare const taskTable: Record<string, (value?: unknown) => Promise<void>>;
export async function awaitComputedCall(key: string) {
  await taskTable[key]();
}

export async function awaitComputedCallWithAwaitedArgument(key: string) {
  await taskTable[key](await firstTask());
}

export async function awaitDynamicImport() {
  await import("./lazy.js");
}

async function firstTask() { return 1; }
async function secondTask() { return 2; }
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

// Same basename in two directories, with two branches sharing one line in the first file. These
// are deliberately awkward coverage joins: line-only/basename-only anchors cannot distinguish
// either the file or the branch site.
const ALPHA_SHARED_SOURCE = `export function compact(a: boolean, b: boolean) { if (a) yes(); if (b) no(); }
function yes() {}
function no() {}
`;

const BETA_SHARED_SOURCE = `export function alternate(flag: boolean) { if (flag) on(); }
function on() {}
`;

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-flow-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "alpha"));
  mkdirSync(join(root, "src", "beta"));
  writeFileSync(join(root, "src", "specimens.ts"), SOURCE);
  writeFileSync(join(root, "src", "boot.ts"), MODULE_SOURCE);
  writeFileSync(join(root, "src", "alpha", "shared.ts"), ALPHA_SHARED_SOURCE);
  writeFileSync(join(root, "src", "beta", "shared.ts"), BETA_SHARED_SOURCE);
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

function allSources(steps: FlowStep[]): Array<FlowSourceAnchor | undefined> {
  return steps.flatMap((step) => {
    if (step.kind === "loop" || step.kind === "callback") {
      return [step.source, ...allSources(step.body)];
    }
    if (step.kind === "branch") {
      return [
        step.source,
        ...step.paths.flatMap((path) => [path.source, ...allSources(path.body)]),
      ];
    }
    return [step.source];
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
      expect(branch.source).toMatchObject({ file: "src/specimens.ts", line: expect.any(Number) });
      expect(branch.paths.map((path) => path.pathId)).toEqual(["then", "else"]);
      expect(callLabels(branch.paths[0].body)).toEqual(["emptyState"]);
      expect(callLabels(branch.paths[1].body)).toEqual(["list"]);
    }
  });

  it("uses root-relative paths and columns to distinguish duplicate basenames and same-line branches", () => {
    const branches = (stepsFor("compact") ?? []).filter((step) => step.kind === "branch");
    expect(branches).toHaveLength(2);

    const firstText = "if (a) yes();";
    const secondText = "if (b) no();";
    const firstCol = ALPHA_SHARED_SOURCE.indexOf(firstText);
    const secondCol = ALPHA_SHARED_SOURCE.indexOf(secondText);
    expect(branches[0]?.source).toEqual({
      file: "src/alpha/shared.ts",
      line: 1,
      col: firstCol,
      endLine: 1,
      endCol: firstCol + firstText.length,
    });
    expect(branches[1]?.source).toEqual({
      file: "src/alpha/shared.ts",
      line: 1,
      col: secondCol,
      endLine: 1,
      endCol: secondCol + secondText.length,
    });

    const alternate = (stepsFor("alternate") ?? [])[0];
    expect(alternate?.source).toMatchObject({ file: "src/beta/shared.ts", line: 1 });
  });

  it("gives every emitted step and path a precise portable source range", () => {
    const sources = Object.values(result.flows ?? {}).flatMap(allSources);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toEqual({
        file: expect.stringMatching(/^(?!\/)(?!.*\\).+/),
        line: expect.any(Number),
        col: expect.any(Number),
        endLine: expect.any(Number),
        endCol: expect.any(Number),
      });
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
        expect(branch.paths[0].body).toEqual([
          expect.objectContaining({ kind: "exit", variant: "return", label: "res", source: expect.objectContaining({ file: "src/specimens.ts" }) }),
        ]);
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
      expect(guard.paths[0].body[2]).toMatchObject({ kind: "exit", variant: "return", label: "reject()", source: { file: "src/specimens.ts", line: expect.any(Number) } });
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
    expect(steps[6]).toMatchObject({ kind: "exit", variant: "return", label: "data", source: { file: "src/specimens.ts", line: expect.any(Number) } });
  });

  it("leaves plain synchronous calls unflagged (checkout)", () => {
    const first = (stepsFor("checkout") ?? [])[0];
    expect(first).not.toHaveProperty("awaited");
    expect(first).not.toHaveProperty("detached");
    expect(first).not.toHaveProperty("async");
  });

  it("links a stored Promise launch to a later single await (launchThenAwait)", () => {
    const steps = stepsFor("launchThenAwait") ?? [];
    expect(steps.map((step) => step.kind)).toEqual(["call", "await"]);
    const launch = steps[0];
    const join = steps[1];
    expect(launch).toMatchObject({
      kind: "call",
      label: "firstTask",
      async: { kind: "launch", binding: "pending", taskId: expect.any(String) },
    });
    expect(launch).not.toHaveProperty("awaited");
    if (launch.kind === "call" && launch.async?.kind === "launch" && join.kind === "await") {
      expect(join).toEqual({
        kind: "await",
        label: "await pending",
        mode: "single",
        inputs: [{ label: "pending", taskId: launch.async.taskId }],
        source: expect.objectContaining({ file: "src/specimens.ts", line: expect.any(Number) }),
      });
    }
  });

  it("keeps a direct call await on the existing call step (awaitDirectly)", () => {
    const steps = stepsFor("awaitDirectly") ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "call",
      label: "firstTask",
      awaited: true,
      async: { kind: "direct-await", taskId: expect.any(String) },
    });
    expect(steps[0].kind).not.toBe("await");
  });

  it("keeps a structural await gate for direct calls whose callee cannot be charted", () => {
    expect(stepsFor("awaitComputedCall")).toEqual([
      {
        kind: "await",
        label: "await taskTable[key]()",
        mode: "single",
        inputs: [{ label: "taskTable[key]()" }],
        source: expect.objectContaining({ file: "src/specimens.ts", line: expect.any(Number) }),
      },
    ]);
    expect(stepsFor("awaitDynamicImport")).toEqual([
      {
        kind: "await",
        label: 'await import("./lazy.js")',
        mode: "single",
        inputs: [{ label: 'import("./lazy.js")' }],
        source: expect.objectContaining({ file: "src/specimens.ts", line: expect.any(Number) }),
      },
    ]);

    const nested = stepsFor("awaitComputedCallWithAwaitedArgument") ?? [];
    expect(nested).toHaveLength(2);
    expect(nested[0]).toMatchObject({
      kind: "call",
      label: "firstTask",
      awaited: true,
      async: { kind: "direct-await" },
    });
    expect(nested[1]).toEqual({
      kind: "await",
      label: "await taskTable[key](await firstTask())",
      mode: "single",
      inputs: [{ label: "taskTable[key](await firstTask())" }],
      source: expect.objectContaining({ file: "src/specimens.ts", line: expect.any(Number) }),
    });
  });

  it("links stored Promise launches into an all barrier (awaitStoredBarrier)", () => {
    const steps = stepsFor("awaitStoredBarrier") ?? [];
    expect(callLabels(steps)).toEqual(["firstTask", "secondTask", "Promise.all"]);
    const [first, second, barrier] = steps;
    expect(first).toMatchObject({ kind: "call", async: { kind: "launch", binding: "first" } });
    expect(second).toMatchObject({ kind: "call", async: { kind: "launch", binding: "second" } });
    expect(barrier).toMatchObject({ kind: "call", awaited: true, async: { kind: "barrier", mode: "all" } });
    if (
      first.kind === "call" && first.async?.kind === "launch" &&
      second.kind === "call" && second.async?.kind === "launch" &&
      barrier.kind === "call"
    ) {
      expect(first.async.binding).toBe("first");
      expect(second.async.binding).toBe("second");
      expect(barrier).toMatchObject({ awaited: true });
      expect(barrier.async).toEqual({
        kind: "barrier",
        mode: "all",
        inputs: [
          { label: "first", taskId: first.async.taskId },
          { label: "second", taskId: second.async.taskId },
        ],
      });
    }
  });

  it("links inline Promise launches into an all barrier (awaitInlineBarrier)", () => {
    const steps = stepsFor("awaitInlineBarrier") ?? [];
    expect(callLabels(steps)).toEqual(["firstTask", "secondTask", "Promise.all"]);
    const [first, second, barrier] = steps;
    expect(first).toMatchObject({ kind: "call", async: { kind: "launch" } });
    expect(second).toMatchObject({ kind: "call", async: { kind: "launch" } });
    expect(barrier).toMatchObject({ kind: "call", awaited: true, async: { kind: "barrier", mode: "all" } });
    if (
      first.kind === "call" && first.async?.kind === "launch" &&
      second.kind === "call" && second.async?.kind === "launch" &&
      barrier.kind === "call"
    ) {
      expect(first.async).not.toHaveProperty("binding");
      expect(second.async).not.toHaveProperty("binding");
      expect(barrier.async).toEqual({
        kind: "barrier",
        mode: "all",
        inputs: [
          { label: "firstTask", taskId: first.async.taskId },
          { label: "secondTask", taskId: second.async.taskId },
        ],
      });
    }
  });

  it("distinguishes an allSettled barrier while retaining awaited compatibility", () => {
    const steps = stepsFor("awaitInlineSettledBarrier") ?? [];
    expect(callLabels(steps)).toEqual(["firstTask", "secondTask", "Promise.allSettled"]);
    const [first, second, barrier] = steps;
    expect(first).toMatchObject({ kind: "call", async: { kind: "launch" } });
    expect(second).toMatchObject({ kind: "call", async: { kind: "launch" } });
    expect(barrier).toMatchObject({ kind: "call", awaited: true, async: { kind: "barrier", mode: "allSettled" } });
    if (
      first.kind === "call" && first.async?.kind === "launch" &&
      second.kind === "call" && second.async?.kind === "launch" &&
      barrier.kind === "call"
    ) {
      expect(barrier.awaited).toBe(true);
      expect(barrier.async).toEqual({
        kind: "barrier",
        mode: "allSettled",
        inputs: [
          { label: "firstTask", taskId: first.async.taskId },
          { label: "secondTask", taskId: second.async.taskId },
        ],
      });
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
