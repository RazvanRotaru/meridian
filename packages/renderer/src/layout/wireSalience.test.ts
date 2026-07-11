/**
 * The weight floor: on a DENSE level (more wires than the threshold), unlit weight-1 dep/import
 * strands fade toward the canvas; lit wires, hidden (opacity 0) commons strands, heavier wires,
 * and flow/IPC wires are untouched. Sparse levels pass through unchanged.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { fadeFaintWires } from "./wireSalience";

const wire = (id: string, opts: { weight?: number; opacity?: number; category?: string } = {}): Edge => ({
  id,
  source: `s${id}`,
  target: `t${id}`,
  data: { weight: opts.weight ?? 1, category: opts.category ?? "import" },
  style: { opacity: opts.opacity ?? 0.4 },
});

const opacityOf = (edge: Edge): number | undefined => (edge.style as { opacity?: number }).opacity;

describe("fadeFaintWires", () => {
  it("fades unlit weight-1 strands on a dense level; heavier, lit, hidden, and flow wires keep their paint", () => {
    const dense = [
      ...Array.from({ length: 40 }, (_, i) => wire(`w${i}`)),
      wire("heavy", { weight: 6 }),
      wire("lit", { opacity: 1 }),
      wire("hiddenCommons", { opacity: 0 }),
      wire("flow", { category: "flow", opacity: 0.55 }),
    ];
    const faded = fadeFaintWires(dense);
    expect(opacityOf(faded[0])).toBeLessThan(0.4);
    expect(opacityOf(faded.find((edge) => edge.id === "heavy")!)).toBe(0.4);
    expect(opacityOf(faded.find((edge) => edge.id === "lit")!)).toBe(1);
    expect(opacityOf(faded.find((edge) => edge.id === "hiddenCommons")!)).toBe(0);
    expect(opacityOf(faded.find((edge) => edge.id === "flow")!)).toBe(0.55);
  });

  it("a sparse level passes through unchanged (every strand earns its ink)", () => {
    const sparse = Array.from({ length: 10 }, (_, i) => wire(`w${i}`));
    expect(fadeFaintWires(sparse)).toBe(sparse);
  });
});
