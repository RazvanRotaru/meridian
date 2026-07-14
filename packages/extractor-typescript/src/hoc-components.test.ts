/**
 * React-shaped extraction gaps: HOC-wrapped const components (`memo`/`forwardRef`) emit nodes
 * whose flow is the unwrapped callable body, anonymous/HOC default exports emit a "default"
 * node, and inline callback bodies (hooks, `.then`, JSX handlers) chart as flow steps of the
 * enclosing callable — without double-charting a component's body into its module's flow.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, FlowStep, GraphNode } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REACT_LITE = `
export function memo<T>(component: T): T { return component; }
export function forwardRef<T>(render: T): T { return render; }
`;

const COMPONENTS = `
import { memo, forwardRef } from "./react-lite";

export const App = memo(() => {
  boot();
  return <Panel title="home" />;
});

export const Panel = forwardRef((props: { title: string }, ref: unknown) => {
  return <div>{props.title}</div>;
});

export const Wrapped = memo(forwardRef(() => {
  track();
  return null;
}));

function BadgeImpl() {
  return <span />;
}
export const Badge = memo(BadgeImpl);

export const total = compute(helper);
function compute(f: () => number): number { return f(); }
function helper(): number { return 1; }

export function boot() {}
export function track() {}
`;

const DEFAULT_ARROW = `
export default () => {
  boot();
  return <main />;
};
function boot() {}
`;

const DEFAULT_HOC = `
import { memo } from "./react-lite";
export default memo(() => {
  ping();
  return null;
});
function ping() {}
`;

const ASYNC_BINDINGS = `
import { memo } from "./react-lite";

export const load = async () => "loaded";
export const wrapped = memo(async () => "wrapped");
export const contextualLoad: (id: string) => Promise<string> = id => Promise.resolve(id);
export function declaredPromise(): Promise<string> { return Promise.resolve("declared"); }
export function declaredPromiseLike(): PromiseLike<string> { return Promise.resolve("like"); }

export class Worker {
  static readonly read = async () => 1;
  static contextualRead: (id: string) => Promise<number> = id => Promise.resolve(Number(id));
}

export const api = {
  save: async () => true,
};

export async function* stream() {
  yield 1;
}
export const streamBinding = async function* () {
  yield 2;
};

export default async () => "default";
`;

const HOOKS = `
function useEffect(effect: () => void, deps: unknown[]) {}
function useMemo<T>(factory: () => T, deps: unknown[]): T { return factory(); }
function loadData() {}
function computeRows(): string[] { return []; }
function submitOrder() {}

export function Dashboard() {
  useEffect(() => {
    loadData();
  }, []);
  const rows = useMemo(() => computeRows(), []);
  return <button onClick={() => submitOrder()}>{rows.length}</button>;
}

// The loop result is a value, not a callable — no node, and the loop charts once (module flow).
export const doubled = [1, 2, 3].map((x) => x * 2);
`;

// Shapes that MUST NOT mint phantom function/method nodes, and MUST NOT break generation.
const PHANTOMS = `
import { memo } from "./react-lite";

// A call taking an inline callback binds the RESULT, not the callback — no function node "p".
export const p = fetch("/api").then((d) => d.json());

// A non-React wrapper around a callback is a value, not a component — no node "api".
export const api = buildApi(() => go());
function buildApi(f: () => void) { return f; }
function go() {}

// Destructuring an arbitrary call: the name is a pattern, not an Identifier — never emit
// "{ save }" (a malformed id that would fail validation and take the whole extraction down).
export const { save } = buildApi(() => go());
// Even a memo-shaped destructuring nonsense must not emit a node or break generate.
const { widget } = memo(() => run());
function run() {}

// A receiver other than React on a wrapper name is NOT a component wrapper — no alias "cached".
export const cached = lru.memo(loader);
const lru = { memo<T>(x: T): T { return x; } };
function loader() {}

// A class field bound to a non-component call is a value, not a method.
export class Widget {
  subscription = subscribe(() => this.refresh());
  refresh() {}
}
function subscribe(f: () => void) { return f; }
`;

// TS \`export =\` re-exports a declaration; it is NOT a default export — no "default" node.
// (Isolated: \`export =\` cannot coexist with ES exports in one module.)
const EXPORT_EQUALS = `
export = function () { legacy(); };
function legacy() {}
`;

// Wrapper-alias handling must be identical wherever the wrapper sits: object-literal value and
// class static, not just an arrow const.
const ALIASES = `
import { memo } from "./react-lite";
function ChartImpl() { return null; }
function RowImpl() { return null; }

export const widgets = { Chart: memo(ChartImpl) };

export class Registry {
  static Row = memo(RowImpl);
}
`;

// Deferred callbacks must NOT chart as synchronous load-time execution, and a callback body must
// stay distinguishable from sibling statements.
const DEFERRED = `
function openMenu() {}
function cleanup() {}
function doWork() {}
function a() {}
function b() {}

document.addEventListener("click", () => openMenu());

setTimeout(() => cleanup(), 5000);
doWork();

export function handedOff() {
  f(() => a());
  b();
}
export function inlineBoth() {
  f(() => { a(); b(); });
}
function f(cb: () => void) {}
`;

// JSX handlers wrapped in pure expressions (conditional, nullish) must still chart.
const JSX_WRAPPED = `
function save() {}
function discard() {}
function fallback() {}

export function Toolbar(props: { dirty: boolean; onClick?: () => void }) {
  return (
    <div>
      <button onClick={props.dirty ? () => save() : () => discard()} />
      <button onClick={props.onClick ?? (() => fallback())} />
    </div>
  );
}
`;

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-hoc-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "react-lite.ts"), REACT_LITE);
  writeFileSync(join(root, "src", "components.tsx"), COMPONENTS);
  writeFileSync(join(root, "src", "default-arrow.tsx"), DEFAULT_ARROW);
  writeFileSync(join(root, "src", "default-hoc.tsx"), DEFAULT_HOC);
  writeFileSync(join(root, "src", "async-bindings.ts"), ASYNC_BINDINGS);
  writeFileSync(join(root, "src", "hooks.tsx"), HOOKS);
  writeFileSync(join(root, "src", "phantoms.tsx"), PHANTOMS);
  writeFileSync(join(root, "src", "export-equals.ts"), EXPORT_EQUALS);
  writeFileSync(join(root, "src", "aliases.tsx"), ALIASES);
  writeFileSync(join(root, "src", "deferred.ts"), DEFERRED);
  writeFileSync(join(root, "src", "jsx-wrapped.tsx"), JSX_WRAPPED);
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root, include: ["src/**/*.ts", "src/**/*.tsx"] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function nodeIn(file: string, qualname: string): GraphNode | undefined {
  return result.nodes.find((node) => node.location?.file === `src/${file}` && node.qualifiedName === qualname);
}

function flowIn(file: string, qualname: string): FlowStep[] {
  const node = nodeIn(file, qualname);
  return (node && result.flows?.[node.id]) ?? [];
}

// Every call label anywhere in a flow tree, in execution order.
function allCallLabels(steps: FlowStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind === "call") return [step.label];
    if (step.kind === "loop" || step.kind === "callback") return allCallLabels(step.body);
    if (step.kind === "branch") return step.paths.flatMap((path) => allCallLabels(path.body));
    return [];
  });
}

// Every callback-step label anywhere in a flow tree.
function collectCallbackLabels(steps: FlowStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind === "callback") return [step.label, ...collectCallbackLabels(step.body)];
    if (step.kind === "loop") return collectCallbackLabels(step.body);
    if (step.kind === "branch") return step.paths.flatMap((path) => collectCallbackLabels(path.body));
    return [];
  });
}

describe("HOC-wrapped const components (gap A)", () => {
  it("emits a node and body flow for a memo-wrapped arrow const (App)", () => {
    const app = nodeIn("components.tsx", "App");
    expect(app).toMatchObject({ kind: "function", displayName: "App" });
    expect(allCallLabels(flowIn("components.tsx", "App"))).toEqual(["boot"]);
  });

  it("emits a node for a forwardRef-wrapped const (Panel)", () => {
    expect(nodeIn("components.tsx", "Panel")).toMatchObject({ kind: "function", displayName: "Panel" });
  });

  it("unwraps nested wrappers memo(forwardRef(...)) to the inner callable (Wrapped)", () => {
    expect(nodeIn("components.tsx", "Wrapped")).toBeDefined();
    expect(allCallLabels(flowIn("components.tsx", "Wrapped"))).toEqual(["track"]);
  });

  it("sources renders edges from the unwrapped component (App renders Panel)", () => {
    const app = nodeIn("components.tsx", "App");
    const panel = nodeIn("components.tsx", "Panel");
    const edge = result.edges.find((candidate) => candidate.kind === "renders" && candidate.source === app?.id);
    expect(edge).toMatchObject({ target: panel?.id, resolution: "resolved" });
  });

  it("does not re-chart a component body into its module flow", () => {
    const moduleLabels = allCallLabels(flowIn("components.tsx", "src/components.tsx"));
    expect(moduleLabels).toEqual(["memo", "forwardRef", "forwardRef", "memo", "memo", "compute"]);
  });

  it("emits a bodiless alias node for a wrapper around a reference (Badge = memo(BadgeImpl))", () => {
    const badge = nodeIn("components.tsx", "Badge");
    expect(badge).toMatchObject({ kind: "function", displayName: "Badge" });
    expect(result.flows?.[badge?.id ?? ""]).toBeUndefined();
  });

  it("does not mint a node for a non-wrapper call binding a value (total = compute(helper))", () => {
    expect(nodeIn("components.tsx", "total")).toBeUndefined();
  });

  it("does not mint a node for an iteration-result const (doubled)", () => {
    expect(nodeIn("hooks.tsx", "doubled")).toBeUndefined();
  });
});

describe("callable binding semantics", () => {
  it.each([
    { qualname: "load", kind: "function" },
    { qualname: "wrapped", kind: "function" },
    { qualname: "Worker.read", kind: "method" },
    { qualname: "api.save", kind: "method" },
    { qualname: "default", kind: "function" },
  ])("preserves async and inferred Promise tags for $qualname", ({ qualname, kind }) => {
    const node = nodeIn("async-bindings.ts", qualname);
    expect(node).toMatchObject({ kind });
    expect(node?.tags).toEqual(expect.arrayContaining(["async", "returns-promise"]));
  });

  it.each(["stream", "streamBinding"])("keeps async generator %s distinct from Promise-returning callables", (qualname) => {
    const stream = nodeIn("async-bindings.ts", qualname);
    expect(stream?.tags).toEqual(expect.arrayContaining(["async", "generator"]));
    expect(stream?.tags).not.toContain("returns-promise");
  });

  it("merges class-property and callable-expression modifiers", () => {
    expect(nodeIn("async-bindings.ts", "Worker.read")?.tags).toEqual(
      expect.arrayContaining(["static", "readonly", "async", "returns-promise"]),
    );
  });

  it("retains export identity on an anonymous default binding", () => {
    expect(nodeIn("async-bindings.ts", "default")?.tags).toContain("export");
  });

  it.each([
    { qualname: "contextualLoad", signature: "contextualLoad(id: string): Promise<string>" },
    { qualname: "Worker.contextualRead", signature: "contextualRead(id: string): Promise<number>" },
  ])("preserves a direct contextual Promise signature for $qualname", ({ qualname, signature }) => {
    const node = nodeIn("async-bindings.ts", qualname);
    expect(node?.signature).toBe(signature);
    expect(node?.tags).toContain("returns-promise");
  });

  it.each(["declaredPromise", "declaredPromiseLike"])("tags an explicit direct Promise result on %s", (qualname) => {
    expect(nodeIn("async-bindings.ts", qualname)?.tags).toContain("returns-promise");
  });
});

describe("anonymous/HOC default exports (gap B)", () => {
  it("emits a 'default' node with a flow for `export default () => ...`", () => {
    expect(nodeIn("default-arrow.tsx", "default")).toMatchObject({ kind: "function", displayName: "default" });
    expect(allCallLabels(flowIn("default-arrow.tsx", "default"))).toEqual(["boot"]);
  });

  it("emits a 'default' node with a flow for `export default memo(() => ...)`", () => {
    expect(nodeIn("default-hoc.tsx", "default")).toBeDefined();
    expect(allCallLabels(flowIn("default-hoc.tsx", "default"))).toEqual(["ping"]);
  });
});

describe("inline callback bodies (gap C)", () => {
  it("charts hook-callback calls and JSX-handler calls in the component flow (Dashboard)", () => {
    const labels = allCallLabels(flowIn("hooks.tsx", "Dashboard"));
    expect(labels).toEqual(["useEffect", "loadData", "useMemo", "computeRows", "submitOrder"]);
  });

  it("nests each callback body under a callback step rather than flattening it (Dashboard)", () => {
    const steps = flowIn("hooks.tsx", "Dashboard");
    // A hook call is a top-level `call`; its body is a NESTED `callback` step naming the receiver —
    // never a flat sibling, so a handed-over callback is never mistaken for load-time execution.
    // The trailing `exit` is the component's `return <jsx>`, charted like any other return.
    expect(steps.map((step) => step.kind)).toEqual(["call", "callback", "call", "callback", "callback", "exit"]);
    const useEffectCallback = steps[1];
    expect(useEffectCallback).toMatchObject({ kind: "callback", label: "callback → useEffect" });
    if (useEffectCallback.kind === "callback") {
      expect(useEffectCallback.body.map((step) => step.kind)).toEqual(["call"]);
    }
    // The JSX handler nests under a callback labeled from its attribute name.
    expect(steps[4]).toMatchObject({ kind: "callback", label: "callback → onClick" });
  });

  it("resolves a hook-callback call to its target node (loadData)", () => {
    const steps = flowIn("hooks.tsx", "Dashboard");
    const callback = steps.find((step) => step.kind === "callback" && step.label === "callback → useEffect");
    const load = callback?.kind === "callback" ? callback.body.find((step) => step.kind === "call") : undefined;
    expect(load).toMatchObject({ resolution: "resolved", target: nodeIn("hooks.tsx", "loadData")?.id });
  });
});

describe("no phantom nodes from non-component callback wrappers (fix 1/2/3)", () => {
  it("mints no function node for a call binding a value (const p = fetch().then(...))", () => {
    expect(nodeIn("phantoms.tsx", "p")).toBeUndefined();
    expect(nodeIn("phantoms.tsx", "api")).toBeUndefined();
    expect(nodeIn("phantoms.tsx", "cached")).toBeUndefined();
  });

  it("mints no method node for a class field bound to a non-component call (Widget.subscription)", () => {
    expect(nodeIn("phantoms.tsx", "Widget.subscription")).toBeUndefined();
    expect(nodeIn("phantoms.tsx", "Widget")).toBeDefined(); // the class itself still emits
  });

  it("emits no malformed node for a destructuring declaration, whatever its initializer", () => {
    // The killer bug: `export const { save } = buildApi(() => go())` would emit id `…#{ save }`.
    const malformed = result.nodes.filter((node) => /[{}]/.test(node.qualifiedName ?? ""));
    expect(malformed).toEqual([]);
    expect(nodeIn("phantoms.tsx", "save")).toBeUndefined();
    expect(nodeIn("phantoms.tsx", "widget")).toBeUndefined();
  });

  it("mints no 'default' node for a TS `export =` assignment", () => {
    expect(nodeIn("export-equals.ts", "default")).toBeUndefined();
  });

  it("keeps the non-component callbacks' calls reachable in the enclosing load-flow", () => {
    // The callbacks aren't phantom nodes, but their logic still charts (nested) where handed over.
    expect(allCallLabels(flowIn("phantoms.tsx", "src/phantoms.tsx"))).toContain("go");
  });
});

describe("wrapper-alias handling is position-independent (fix 4)", () => {
  it("aliases a memo(Impl) object-literal value (widgets.Chart)", () => {
    const chart = nodeIn("aliases.tsx", "widgets.Chart");
    expect(chart).toMatchObject({ kind: "method", displayName: "Chart" });
    expect(result.flows?.[chart?.id ?? ""]).toBeUndefined(); // bodiless alias
  });

  it("aliases a memo(Impl) class static (Registry.Row)", () => {
    const row = nodeIn("aliases.tsx", "Registry.Row");
    expect(row).toMatchObject({ kind: "method", displayName: "Row" });
    expect(result.flows?.[row?.id ?? ""]).toBeUndefined();
  });
});

describe("deferred callbacks nest, never flatten (fix 5)", () => {
  it("does not chart a setTimeout body as a flat load-time sibling before doWork", () => {
    const steps = flowIn("deferred.ts", "src/deferred.ts");
    // Top-level module load: addEventListener call (+ nested callback), setTimeout call (+ nested
    // callback), then doWork — the callback bodies (openMenu, cleanup) are NESTED, so they never
    // appear as flat siblings of doWork.
    expect(steps.map((step) => step.kind)).toEqual(["call", "callback", "call", "callback", "call"]);
    expect(steps.filter((step) => step.kind === "call").map((step) => (step as { label: string }).label))
      .toEqual(["document.addEventListener", "setTimeout", "doWork"]);
    const timeoutCallback = steps[3];
    expect(timeoutCallback).toMatchObject({ kind: "callback", label: "callback → setTimeout" });
    if (timeoutCallback.kind === "callback") {
      expect(allCallLabels(timeoutCallback.body)).toEqual(["cleanup"]);
    }
  });

  it("distinguishes f(() => a()); b() from f(() => { a(); b(); })", () => {
    const handedOff = flowIn("deferred.ts", "handedOff");
    // f() call, then a() nested in a callback, then b() as a real sibling.
    expect(handedOff.map((step) => step.kind)).toEqual(["call", "callback", "call"]);
    expect((handedOff[0] as { label: string }).label).toBe("f");
    expect((handedOff[2] as { label: string }).label).toBe("b");

    const inlineBoth = flowIn("deferred.ts", "inlineBoth");
    // f() call, then a callback holding BOTH a() and b() — b is inside, not a sibling.
    expect(inlineBoth.map((step) => step.kind)).toEqual(["call", "callback"]);
    const callback = inlineBoth[1];
    if (callback.kind === "callback") {
      expect(callback.body.map((step) => (step as { label: string }).label)).toEqual(["a", "b"]);
    }
  });
});

describe("JSX handlers wrapped in expressions (fix 6)", () => {
  it("charts a conditional onClick handler's calls (Toolbar)", () => {
    const labels = allCallLabels(flowIn("jsx-wrapped.tsx", "Toolbar"));
    expect(labels).toEqual(expect.arrayContaining(["save", "discard", "fallback"]));
  });

  it("labels the wrapped handler callbacks from the JSX attribute (onClick)", () => {
    const steps = flowIn("jsx-wrapped.tsx", "Toolbar");
    const callbacks = collectCallbackLabels(steps);
    expect(callbacks.filter((label) => label === "callback → onClick").length).toBeGreaterThanOrEqual(2);
  });
});
