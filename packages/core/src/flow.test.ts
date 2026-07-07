import { describe, expect, it } from "vitest";
import type { FlowStep } from "./flow";
import { pathTerminates } from "./flow";

const call = (label: string): FlowStep => ({ kind: "call", label, target: null, resolution: "unresolved" });
const exit = (variant: "return" | "throw" = "return"): FlowStep => ({ kind: "exit", variant, label: null });
const branch = (paths: Array<[string, FlowStep[]]>): FlowStep => ({
  kind: "branch",
  label: "if x",
  paths: paths.map(([label, body]) => ({ label, body })),
});

describe("pathTerminates", () => {
  it("is false for an empty or call-only path", () => {
    expect(pathTerminates([])).toBe(false);
    expect(pathTerminates([call("f")])).toBe(false);
  });

  it("is true when the path ends in a return or throw", () => {
    expect(pathTerminates([call("f"), exit()])).toBe(true);
    expect(pathTerminates([exit("throw")])).toBe(true);
  });

  it("is false when calls trail the exit-bearing branch", () => {
    expect(pathTerminates([exit(), call("f")])).toBe(false);
  });

  it("treats an if WITHOUT an else as fall-through even when the then-path exits", () => {
    expect(pathTerminates([branch([["then", [exit()]]])])).toBe(false);
  });

  it("terminates only when every path of a fully-covering branch exits", () => {
    expect(pathTerminates([branch([["then", [exit()]], ["else", [exit("throw")]]])])).toBe(true);
    expect(pathTerminates([branch([["then", [exit()]], ["else", [call("f")]]])])).toBe(false);
  });

  it("recurses through nested else-if chains", () => {
    const chain = branch([["then", [exit()]], ["else", [branch([["then", [exit()]], ["else", [exit()]]])]]]);
    expect(pathTerminates([chain])).toBe(true);
  });

  it("requires an unconditional arm: an all-case switch may match nothing", () => {
    expect(pathTerminates([branch([["\"a\"", [exit()]], ["\"b\"", [exit()]]])])).toBe(false);
    expect(pathTerminates([branch([["\"a\"", [exit()]], ["default", [exit()]]])])).toBe(true);
  });

  it("covers try+catch (both exiting) but never loops or callbacks", () => {
    expect(pathTerminates([branch([["try", [exit()]], ["catch e", [exit("throw")]]])])).toBe(true);
    expect(pathTerminates([{ kind: "loop", label: "for", body: [exit()] }])).toBe(false);
    expect(pathTerminates([{ kind: "callback", label: "then", body: [exit()] }])).toBe(false);
  });
});
