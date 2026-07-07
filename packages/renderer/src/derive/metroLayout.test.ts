import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows, NodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { layoutMetro } from "./metroLayout";
import { BASE_Y } from "./metroSpec";

// callDisplay only touches nodesById.get + parseNodeId(target); an empty map is enough for layout.
const INDEX = { nodesById: new Map() } as unknown as GraphIndex;
const FLOWS: LogicFlows = {};

const id = (name: string): NodeId => `ts:mod/${name}.ts#${name}` as NodeId;

function call(label: string, extra: Partial<Extract<FlowStep, { kind: "call" }>> = {}): FlowStep {
  return { kind: "call", label, target: id(label), resolution: "resolved", ...extra };
}
const ret = (label: string | null = null): FlowStep => ({ kind: "exit", variant: "return", label });

const run = (steps: FlowStep[]) => layoutMetro(steps, FLOWS, INDEX, "placeOrder");
/** Curves that land back on the main exec thread — a fall-through path rejoining, never a terminus. */
const rejoinsToBase = (spec: ReturnType<typeof run>) =>
  spec.lines.filter((l) => l.d.includes(" C ") && l.d.endsWith(` ${BASE_Y}`));

describe("layoutMetro", () => {
  it("caps the flow with an entry terminus and a synthetic EXIT when nothing returns", () => {
    const spec = run([call("validate")]);
    const first = spec.stations[0];
    expect(first).toMatchObject({ kind: "terminus", x: 60 });
    expect(first.name?.startsWith("▶")).toBe(true);
    expect(spec.stations.some((s) => s.kind === "terminus" && s.name === "EXIT")).toBe(true);
    expect(spec.height).toBeGreaterThanOrEqual(620);
  });

  it("draws an awaited call as an interchange and a plain call as a station", () => {
    const spec = run([call("plain"), call("save", { awaited: true })]);
    const kinds = spec.stations.filter((s) => s.name === "plain" || s.name === "save");
    expect(kinds.find((s) => s.name === "plain")?.kind).toBe("station");
    expect(kinds.find((s) => s.name === "save")?.kind).toBe("interchange");
  });

  it("keeps a detached call on the main line and sends a dashed arrowed lane to the edge", () => {
    const spec = run([call("track", { detached: true })]);
    const station = spec.stations.find((s) => s.name === "track");
    expect(station).toMatchObject({ kind: "station", y: BASE_Y });
    const departure = spec.lines.find((l) => l.dash && l.arrow);
    expect(departure).toBeTruthy();
    expect(spec.labels.some((l) => l.text.includes("still running"))).toBe(true);
  });

  it("ends a guard's returning then-path in a terminus and continues the main line", () => {
    const spec = run([
      { kind: "branch", label: "empty?", paths: [{ label: "then", body: [call("count"), ret("rejectEmpty")] }] },
      call("assemble"),
    ]);
    const terminus = spec.stations.find((s) => s.kind === "terminus" && s.name?.includes("rejectEmpty"));
    expect(terminus).toBeTruthy();
    expect(terminus!.y).not.toBe(BASE_Y); // it dead-ends on the elevated then-lane
    expect(spec.labels.some((l) => l.text === "else · synthesized")).toBe(true);
    expect(spec.stations.some((s) => s.kind === "junction")).toBe(true);
    // The returning path must NOT rejoin; only the fall-through main line carries on to `assemble`.
    expect(rejoinsToBase(spec)).toHaveLength(0);
    expect(spec.stations.some((s) => s.name === "assemble" && s.y === BASE_Y)).toBe(true);
  });

  it("rejoins a fall-through arm but not a returning arm in a then/else pair", () => {
    const spec = run([
      {
        kind: "branch",
        label: "over limit?",
        paths: [
          { label: "then", body: [ret("blocked")] },
          { label: "else", body: [call("flag")] },
        ],
      },
    ]);
    expect(rejoinsToBase(spec)).toHaveLength(1); // only the else arm returns to the trunk
    expect(spec.stations.some((s) => s.kind === "terminus" && s.name?.includes("blocked"))).toBe(true);
  });

  it("splits a try/catch as a dashed lane that rejoins, with both bodies charted", () => {
    const spec = run([
      {
        kind: "branch",
        label: "try/catch",
        paths: [
          { label: "try", body: [call("price")] },
          { label: "catch e", body: [call("fallback")] },
        ],
      },
    ]);
    expect(spec.labels.some((l) => l.text.includes("on throw"))).toBe(true);
    expect(rejoinsToBase(spec)).toHaveLength(1);
    expect(spec.stations.some((s) => s.name === "price")).toBe(true);
    expect(spec.stations.some((s) => s.name === "fallback")).toBe(true);
  });

  it("charts a loop as a contained lane — body off the trunk, rejoining where iteration ends", () => {
    const spec = run([{ kind: "loop", label: "× lines", body: [call("reserve")] }, call("save")]);
    const ring = spec.stations.find((s) => s.kind === "loop");
    expect(ring).toBeTruthy();
    expect(ring!.y).toBeLessThan(BASE_Y); // tangent above the main line
    const body = spec.stations.find((s) => s.name === "reserve");
    expect(body).toBeTruthy();
    expect(body!.y).not.toBe(BASE_Y); // the body lives on the loop lane, NOT the trunk
    expect(rejoinsToBase(spec)).toHaveLength(1); // the lane hands control back when iteration ends
    const after = spec.stations.find((s) => s.name === "save");
    expect(after).toMatchObject({ y: BASE_Y }); // the trunk resumes past the loop…
    expect(after!.x).toBeGreaterThan(body!.x); // …to the RIGHT of the body, never under it
  });

  it("dead-ends a loop lane at a body return but still lets the trunk carry on (zero iterations)", () => {
    const spec = run([{ kind: "loop", label: "× lines", body: [ret("firstBad")] }, call("save")]);
    expect(rejoinsToBase(spec)).toHaveLength(0); // a returning body never rejoins the trunk
    expect(spec.stations.some((s) => s.kind === "terminus" && s.name?.includes("firstBad"))).toBe(true);
    expect(spec.stations.some((s) => s.name === "save" && s.y === BASE_Y)).toBe(true); // 0-iteration path
  });

  it("draws no throw lane for try/finally without catch and charts finally exactly once", () => {
    const spec = run([
      {
        kind: "branch",
        label: "try/catch",
        branchKind: "try",
        paths: [
          { label: "try", role: "try", body: [call("price")] },
          { label: "finally", role: "finally", body: [call("cleanup")] },
        ],
      },
    ]);
    expect(spec.labels.some((l) => l.text.includes("on throw"))).toBe(false);
    expect(spec.lines.some((l) => l.dash)).toBe(false); // no dashed throw split/rejoin at all
    const cleanups = spec.stations.filter((s) => s.name === "cleanup");
    expect(cleanups).toHaveLength(1); // finally always runs: once, inline
    expect(cleanups[0].y).toBe(BASE_Y);
  });

  it("captions switch arms with their case labels and synthesizes a 'no match' fall-through", () => {
    const spec = run([
      {
        kind: "branch",
        label: "switch (status)",
        branchKind: "switch",
        paths: [
          { label: 'case "paid"', role: "case", body: [call("ship")] },
          { label: 'case "void"', role: "case", body: [call("cancel")] },
        ],
      },
    ]);
    expect(spec.labels.some((l) => l.text === 'case "paid"')).toBe(true);
    expect(spec.labels.some((l) => l.text === 'case "void"')).toBe(true);
    expect(spec.labels.some((l) => l.text === "no match · synthesized")).toBe(true);
    expect(spec.labels.some((l) => l.text.includes("false"))).toBe(false); // arm names, never booleans
  });

  it("places the synthetic EXIT terminus past the last station, never on top of it", () => {
    const spec = run([call("validate"), call("assemble")]);
    const lastStationX = Math.max(...spec.stations.filter((s) => s.kind === "station").map((s) => s.x));
    const exit = spec.stations.find((s) => s.name === "EXIT");
    expect(exit).toBeTruthy();
    expect(exit!.x).toBeGreaterThan(lastStationX);
  });

  it("stops the main line at a top-level return (no synthetic EXIT after it)", () => {
    const spec = run([call("validate"), ret("order")]);
    expect(spec.stations.some((s) => s.name === "EXIT")).toBe(false);
    expect(spec.stations.some((s) => s.kind === "terminus" && s.name?.includes("order"))).toBe(true);
  });

  it("never crashes on empty paths, deep nesting, or an exit mid-list", () => {
    const deep = (n: number): FlowStep =>
      n === 0 ? call("leaf") : { kind: "branch", label: `d${n}`, paths: [{ label: "then", body: [deep(n - 1)] }] };
    const spec = run([
      { kind: "branch", label: "empty", paths: [{ label: "then", body: [] }] },
      deep(20),
      ret("done"),
      call("dead"),
    ]);
    expect(spec.stations.length).toBeGreaterThan(0);
    expect(spec.stations.some((s) => s.name === "dead")).toBe(false); // dead code after the return
  });
});
