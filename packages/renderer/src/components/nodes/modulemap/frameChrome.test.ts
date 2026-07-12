import { describe, expect, it, vi } from "vitest";
import { resolveSurfaceExpandAction } from "./frameChrome";

describe("surface expansion action", () => {
  it("keeps a fully frozen read-only surface without disclosure", () => {
    expect(resolveSurfaceExpandAction(true, null, vi.fn())).toBeNull();
  });

  it("lets a read-only surface expose its own presentation-local disclosure", () => {
    const local = vi.fn();
    const store = vi.fn();
    const action = resolveSurfaceExpandAction(true, local, store);

    action?.("package");

    expect(action).toBe(local);
    expect(local).toHaveBeenCalledWith("package");
    expect(store).not.toHaveBeenCalled();
  });

  it("retains the shared store action on an ordinary interactive surface", () => {
    const store = vi.fn();
    expect(resolveSurfaceExpandAction(false, null, store)).toBe(store);
  });
});
