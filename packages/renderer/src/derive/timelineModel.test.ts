import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { buildTimeline } from "./timelineModel";

// callDisplay only ever reads `index.nodesById`; a bare map is a faithful-enough stub for ordering.
const INDEX = { nodesById: new Map() } as unknown as GraphIndex;
const FLOWS: LogicFlows = {};

function call(label: string, extra: Partial<Extract<FlowStep, { kind: "call" }>> = {}): FlowStep {
  return { kind: "call", label, target: null, resolution: "unresolved", ...extra };
}

// A placeOrder-shaped flow: guard-return, awaited price, a loop, a detached call, a callback, a return.
const PLACE_ORDER: FlowStep[] = [
  { kind: "branch", label: "if", paths: [{ label: "lines empty", body: [call("count"), { kind: "exit", variant: "return", label: "0" }] }] },
  call("pricing.price", { awaited: true }),
  { kind: "loop", label: "reserve × lines", body: [call("reserve")] },
  call("audit.track", { detached: true }),
  { kind: "callback", label: "email.send", body: [call("log")] },
  { kind: "exit", variant: "return", label: "order" },
];

describe("buildTimeline", () => {
  const spec = buildTimeline(PLACE_ORDER, FLOWS, INDEX);

  it("aligns the main suspend segment with its awaited-task bar", () => {
    const suspend = spec.mainRow.find((i) => i.kind === "suspend");
    const task = spec.taskRow[0];
    expect(suspend).toBeDefined();
    expect(task).toBeDefined();
    expect(suspend?.t0).toBe(task.t0);
    expect(suspend?.t1).toBe(task.t1);
  });

  it("runs the detached background bar past the return line", () => {
    expect(spec.returnsAt).not.toBeNull();
    const detached = spec.bgRows.find((row) => row[0]?.text.includes("audit.track"));
    expect(detached).toBeDefined();
    expect(detached![0].t1).toBeGreaterThan(spec.returnsAt!);
  });

  it("keeps the terminated guard path as a ghosted alt row", () => {
    expect(spec.altRows).toHaveLength(1);
    expect(spec.altRows[0].text).toContain("⏎ return");
  });

  it("marks the guard's continuation as a synthesized else", () => {
    expect(spec.elseTicks.length).toBeGreaterThan(0);
  });

  it("sets returnsAt at the final exit chip", () => {
    const cap = spec.mainRow.find((i) => i.glyph === "⏎");
    expect(cap).toBeDefined();
    expect(spec.returnsAt).toBe(cap?.t0);
  });

  it("orders main-lane items by ascending t", () => {
    const ts = spec.mainRow.map((i) => i.t0);
    for (let k = 1; k < ts.length; k++) {
      expect(ts[k]).toBeGreaterThanOrEqual(ts[k - 1]);
    }
  });

  it("gives each fire-and-forget handoff its own background lane with a drop connector", () => {
    expect(spec.bgRows).toHaveLength(2); // detached audit.track + email.send callback
    expect(spec.connectors.filter((c) => c.kind === "detach")).toHaveLength(2);
    expect(spec.connectors.filter((c) => c.kind === "await")).toHaveLength(2); // drop + rise
  });

  it("keeps every alt bar inside the axis (t1 <= ticks)", () => {
    const longArm: FlowStep[] = [call("a"), call("b"), call("c"), call("d"), call("e"), { kind: "exit", variant: "return", label: null }];
    const s = buildTimeline(
      [call("f"), { kind: "branch", label: "if", branchKind: "if", paths: [{ label: "big guard", role: "then", body: longArm }] }, { kind: "exit", variant: "return", label: null }],
      FLOWS, INDEX,
    );
    expect(s.altRows.length).toBeGreaterThan(0);
    for (const alt of s.altRows) expect(alt.t1).toBeLessThanOrEqual(s.ticks);
  });

  it("labels a throwing guard's alt row as a throw, not a return", () => {
    const s = buildTimeline(
      [{ kind: "branch", label: "if", branchKind: "if", paths: [{ label: "bad input", role: "then", body: [{ kind: "exit", variant: "throw", label: "new Error()" }] }] }, call("work")],
      FLOWS, INDEX,
    );
    expect(s.altRows[0].text).toContain("⚡ throw");
    expect(s.altRows[0].text).not.toContain("return");
  });
});

describe("buildTimeline · try/catch", () => {
  // `try { return risky() } catch { log() } cleanup()` — the catch RECOVERS, so cleanup is reachable.
  const RECOVERING: FlowStep[] = [
    {
      kind: "branch", label: "try/catch", branchKind: "try",
      paths: [
        { label: "try", role: "try", body: [call("risky"), { kind: "exit", variant: "return", label: "res" }] },
        { label: "catch e", role: "catch", body: [call("log")] },
      ],
    },
    call("cleanup"),
  ];

  it("keeps the continuation after a try whose catch recovers, and restores returnsAt", () => {
    const s = buildTimeline(RECOVERING, FLOWS, INDEX);
    expect(s.mainRow.some((i) => i.text === "cleanup")).toBe(true);
    expect(s.returnsAt).toBeNull(); // the in-try return is not the flow's end
    expect(s.mainRow.some((i) => i.glyph === "⏎")).toBe(true); // …but its chip stays on the lane
  });

  it("still seals the flow when EVERY try arm terminates", () => {
    const sealed: FlowStep[] = [
      {
        kind: "branch", label: "try/catch", branchKind: "try",
        paths: [
          { label: "try", role: "try", body: [{ kind: "exit", variant: "return", label: null }] },
          { label: "catch e", role: "catch", body: [{ kind: "exit", variant: "throw", label: "e" }] },
        ],
      },
      call("unreachable"),
    ];
    const s = buildTimeline(sealed, FLOWS, INDEX);
    expect(s.returnsAt).not.toBeNull();
    expect(s.mainRow.some((i) => i.text === "unreachable")).toBe(false);
  });
});
