import { describe, expect, it } from "vitest";
import type { BranchStep } from "./flowViewModel";
import { branchCompartments } from "./blocksModel";

const exitStep = { kind: "exit", variant: "return", label: "x" } as const;
const callStep = { kind: "call", label: "f", target: null, resolution: "unresolved" } as const;

describe("branchCompartments", () => {
  it("passes real if/else arms through with no synthesized compartment", () => {
    const step: BranchStep = { kind: "branch", label: "if a", paths: [{ label: "then", body: [] }, { label: "else", body: [] }] };
    const comps = branchCompartments(step);
    expect(comps.map((c) => c.caption)).toEqual(["then", "else"]);
    expect(comps.every((c) => !c.synthesized)).toBe(true);
  });

  it("synthesizes an else that IS the rest of the function when the then-arm exits", () => {
    const step: BranchStep = { kind: "branch", label: "if a", paths: [{ label: "then", body: [exitStep] }] };
    const [, synth] = branchCompartments(step);
    expect(synth.synthesized).toBe(true);
    expect(synth.caption).toBe("otherwise — synthesized");
    expect(synth.note).toBe("↓ the rest of the function is the else branch");
  });

  it("synthesizes a skip-ahead else when the then-arm falls through", () => {
    const step: BranchStep = { kind: "branch", label: "if a", paths: [{ label: "then", body: [callStep] }] };
    const [, synth] = branchCompartments(step);
    expect(synth.note).toBe("↓ skips straight ahead");
  });

  it("synthesizes a no-match arm for a default-less switch", () => {
    const step: BranchStep = { kind: "branch", label: "switch x", paths: [{ label: "1", body: [] }, { label: "2", body: [] }] };
    const [, , synth] = branchCompartments(step);
    expect(synth.caption).toBe("no match — synthesized");
    expect(synth.note).toBe("↓ skips straight ahead");
  });

  it("adds nothing when a switch has a default arm", () => {
    const step: BranchStep = { kind: "branch", label: "switch x", paths: [{ label: "1", body: [] }, { label: "default", body: [] }] };
    expect(branchCompartments(step).some((c) => c.synthesized)).toBe(false);
  });

  it("treats try/catch as fully covered (no synthesized arm)", () => {
    const step: BranchStep = { kind: "branch", label: "try/catch", paths: [{ label: "try", body: [] }, { label: "catch (e)", body: [] }] };
    expect(branchCompartments(step).some((c) => c.synthesized)).toBe(false);
  });
});
