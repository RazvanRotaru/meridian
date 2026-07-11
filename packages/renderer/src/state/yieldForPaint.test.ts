import { afterEach, describe, expect, it, vi } from "vitest";
import { yieldForPaint } from "./yieldForPaint";

describe("yieldForPaint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves immediately outside a browser animation-frame environment", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    await expect(yieldForPaint()).resolves.toBeUndefined();
  });

  it("hands work from the next animation frame to a later task", async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    }));
    let resolved = false;
    const pending = yieldForPaint().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.runAllTimersAsync();
    await pending;
    expect(resolved).toBe(true);
  });

  it("falls back when animation frames are suspended", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    let resolved = false;
    const pending = yieldForPaint().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
