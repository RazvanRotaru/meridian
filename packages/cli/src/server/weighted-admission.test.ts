import { describe, expect, it } from "vitest";
import { WeightedAdmission } from "./weighted-admission";

describe("WeightedAdmission", () => {
  it("bounds aggregate weight and rejects overload without mutating state", () => {
    const admission = new WeightedAdmission(10);
    const first = admission.tryAcquire(6);

    expect(first).not.toBeNull();
    expect(admission.snapshot).toEqual({ capacity: 10, used: 6, available: 4, active: 1 });
    expect(admission.tryAcquire(5)).toBeNull();
    expect(admission.snapshot).toEqual({ capacity: 10, used: 6, available: 4, active: 1 });

    const second = admission.tryAcquire(4);
    expect(second).not.toBeNull();
    expect(admission.snapshot).toEqual({ capacity: 10, used: 10, available: 0, active: 2 });
  });

  it("releases each lease exactly once", () => {
    const admission = new WeightedAdmission(10);
    const lease = admission.tryAcquire(7)!;

    lease.release();
    lease.release();

    expect(admission.snapshot).toEqual({ capacity: 10, used: 0, available: 10, active: 0 });
    expect(admission.tryAcquire(10)).not.toBeNull();
  });

  it("rejects invalid capacities and weights", () => {
    expect(() => new WeightedAdmission(0)).toThrow(/positive safe integer/);
    const admission = new WeightedAdmission(10);
    expect(() => admission.tryAcquire(0)).toThrow(/positive safe integer/);
    expect(() => admission.tryAcquire(Number.MAX_VALUE)).toThrow(/positive safe integer/);
    expect(admission.snapshot.used).toBe(0);
  });
});
