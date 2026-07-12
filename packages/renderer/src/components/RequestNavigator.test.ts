import { describe, expect, it } from "vitest";
import { cyclicRequestId } from "./RequestNavigator";

const TRACES = [{ traceId: "newest" }, { traceId: "middle" }, { traceId: "oldest" }];

describe("cyclicRequestId", () => {
  it("moves in the caller-provided display order", () => {
    expect(cyclicRequestId(TRACES, "middle", -1)).toBe("newest");
    expect(cyclicRequestId(TRACES, "middle", 1)).toBe("oldest");
  });

  it("wraps clearly at both ends", () => {
    expect(cyclicRequestId(TRACES, "newest", -1)).toBe("oldest");
    expect(cyclicRequestId(TRACES, "oldest", 1)).toBe("newest");
  });

  it("returns null for an empty request list", () => {
    expect(cyclicRequestId([], "missing", 1)).toBeNull();
  });
});
