import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("caps in-flight work while retaining Promise.all result order", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const result = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      active += 1;
      peak = Math.max(peak, active);
      await gates[item].promise;
      active -= 1;
      return `result-${item}`;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[2].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    gates[3].resolve();
    gates[0].resolve();

    await expect(result).resolves.toEqual(["result-0", "result-1", "result-2", "result-3"]);
    expect(peak).toBe(2);
  });

  it("rejects invalid limits instead of silently leaving work unscheduled", async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(RangeError);
  });
});
