import { describe, expect, it } from "vitest";
import type { UnitMetrics } from "./composition";
import { diagnoseUnit, SCORE_GLOSSARY } from "./compositionAdvice";

function unit(overrides: Partial<UnitMetrics>): UnitMetrics {
  return {
    id: "ts:m#U",
    kind: "class",
    displayName: "U",
    moduleFile: "m.ts",
    members: 3,
    cohesion: 1,
    lcomComponents: 1,
    ce: 1,
    ca: 1,
    instability: 0.5,
    abstractness: 0.5,
    distance: 0,
    externalFanout: 0,
    smells: [],
    ...overrides,
  };
}

describe("diagnoseUnit", () => {
  it("calls a clean, balanced unit healthy (good tone, no action)", () => {
    const d = diagnoseUnit(unit({ smells: [], distance: 0 }));
    expect(d.tone).toBe("good");
    expect(d.headline).toMatch(/main sequence/i);
    expect(d.suggestions.join(" ")).toMatch(/no action/i);
  });

  it("flags a god-module as bad with a coupling-reduction suggestion", () => {
    const d = diagnoseUnit(unit({ smells: ["god-module"], ca: 6, ce: 7 }));
    expect(d.tone).toBe("bad");
    expect(d.headline).toMatch(/hub/i);
    expect(d.findings.join(" ")).toContain("6");
    expect(d.suggestions.join(" ")).toMatch(/interface|fan-/i);
  });

  it("suggests splitting a low-cohesion unit along its clusters", () => {
    const d = diagnoseUnit(unit({ smells: ["low-cohesion"], members: 8, lcomComponents: 3, cohesion: 0.2 }));
    expect(d.tone).toBe("warn");
    expect(d.suggestions.join(" ")).toMatch(/split into 3/i);
  });

  it("orders the worst (bad) smell first when several apply", () => {
    const d = diagnoseUnit(unit({ smells: ["low-cohesion", "god-module"], ca: 6, ce: 6, members: 8, lcomComponents: 3 }));
    expect(d.tone).toBe("bad");
    expect(d.headline).toMatch(/hub/i);
    expect(d.findings.length).toBe(2);
  });
});

describe("SCORE_GLOSSARY", () => {
  it("documents the headline scores", () => {
    const keys = SCORE_GLOSSARY.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(["cohesion", "Ce", "Ca", "I", "A", "D"]));
  });
});
