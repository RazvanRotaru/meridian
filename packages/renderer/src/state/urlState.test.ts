import { describe, expect, it } from "vitest";
import { DEFAULT_NAV, decodeNav, decodeNavState, encodeNav, isNavigationChange, mergeNavIntoSearch, navFrom, type NavState } from "./urlState";

/** A NavState at every default — the empty starting point the app boots into. */
function emptyNav(): NavState {
  return {
    viewMode: "call",
    focusId: null,
    compRoot: null,
    selectedId: null,
    compSelectedId: null,
    logicSelected: null,
    flowRootId: null,
    flowDepth: null,
    logicRoot: null,
    logicStack: [],
    expanded: [],
    environment: null,
  };
}

/** Round-trip a NavState through the query string and read back only the keys it carried. */
function roundTrip(nav: NavState): Partial<NavState> {
  return decodeNav(new URLSearchParams(mergeNavIntoSearch("", nav)));
}

describe("urlState", () => {
  it("encodes nothing for the default state", () => {
    expect(encodeNav(emptyNav()).size).toBe(0);
    expect(mergeNavIntoSearch("", emptyNav())).toBe("");
  });

  it("round-trips a ui-graph view (focus, selection, expansion)", () => {
    const nav: NavState = {
      ...emptyNav(),
      viewMode: "ui",
      focusId: "ts:packages/orders/src/foo.ts#Bar.baz",
      selectedId: "ts:packages/orders/src/foo.ts#Bar.qux",
      expanded: ["ts:a#x", "ts:b#y"],
    };
    expect(roundTrip(nav)).toEqual({
      viewMode: "ui",
      focusId: "ts:packages/orders/src/foo.ts#Bar.baz",
      selectedId: "ts:packages/orders/src/foo.ts#Bar.qux",
      expanded: ["ts:a#x", "ts:b#y"],
    });
  });

  it("round-trips a logic view (root, drill stack, selection)", () => {
    const nav: NavState = {
      ...emptyNav(),
      viewMode: "logic",
      logicRoot: "ts:m.ts#A.run",
      logicStack: ["ts:m.ts#A.run", "ts:m.ts#B.step"],
      logicSelected: "ts:m.ts#C.leaf",
    };
    expect(roundTrip(nav)).toEqual({
      viewMode: "logic",
      logicRoot: "ts:m.ts#A.run",
      logicStack: ["ts:m.ts#A.run", "ts:m.ts#B.step"],
      logicSelected: "ts:m.ts#C.leaf",
    });
  });

  it("round-trips flow isolation with a depth", () => {
    const nav: NavState = { ...emptyNav(), flowRootId: "ts:m.ts#entry", flowDepth: 3 };
    expect(roundTrip(nav)).toEqual({ flowRootId: "ts:m.ts#entry", flowDepth: 3 });
  });

  it("round-trips a selected environment", () => {
    expect(roundTrip({ ...emptyNav(), environment: "staging" })).toEqual({ environment: "staging" });
  });

  it("preserves foreign params (web-mode id) while owning its own keys", () => {
    const search = mergeNavIntoSearch("id=abc123", { ...emptyNav(), focusId: "ts:m.ts#f" });
    const params = new URLSearchParams(search);
    expect(params.get("id")).toBe("abc123");
    expect(params.get("focus")).toBe("ts:m.ts#f");
  });

  it("survives a node id with every special character intact", () => {
    const id = "ts:packages/a/b.ts#Outer.inner~2";
    const nav: NavState = { ...emptyNav(), focusId: id, logicStack: [id] };
    const search = mergeNavIntoSearch("", nav);
    const decoded = decodeNav(new URLSearchParams(search));
    expect(decoded.focusId).toBe(id);
    expect(decoded.logicStack).toEqual([id]);
  });

  describe("decodeNavState (complete state for back/forward resets)", () => {
    it("returns the full defaults for an empty query", () => {
      expect(decodeNavState(new URLSearchParams(""))).toEqual(DEFAULT_NAV);
    });

    it("resets an absent key to default (a dive undoes on back)", () => {
      expect(decodeNavState(new URLSearchParams("focus=ts:a%23b")).focusId).toBe("ts:a#b");
      // Navigating back to a URL with no focus must null focusId, not leave the stale dive.
      expect(decodeNavState(new URLSearchParams("")).focusId).toBeNull();
    });

    it("merges present keys over defaults for a mixed URL", () => {
      const nav = decodeNavState(new URLSearchParams("view=ui&sel=ts:m.ts%23f"));
      expect(nav.viewMode).toBe("ui");
      expect(nav.selectedId).toBe("ts:m.ts#f");
      // Untouched fields stay at their defaults.
      expect(nav.focusId).toBeNull();
      expect(nav.logicStack).toEqual([]);
      expect(nav.expanded).toEqual([]);
    });
  });

  describe("isNavigationChange", () => {
    const base = emptyNav();

    it("is true when the focus changes", () => {
      expect(isNavigationChange(base, { ...base, focusId: "ts:m.ts#f" })).toBe(true);
    });

    it("is true when the view mode changes", () => {
      expect(isNavigationChange(base, { ...base, viewMode: "logic" })).toBe(true);
    });

    it("is true when the logic stack is pushed", () => {
      expect(isNavigationChange(base, { ...base, logicStack: ["ts:m.ts#f"] })).toBe(true);
    });

    it("is false for a selection-only change", () => {
      expect(isNavigationChange(base, { ...base, selectedId: "ts:m.ts#f" })).toBe(false);
    });

    it("is false for an expansion-only change", () => {
      expect(isNavigationChange(base, { ...base, expanded: ["ts:m.ts#f"] })).toBe(false);
    });
  });

  it("sorts expanded ids so the URL is deterministic regardless of Set order", () => {
    const nav = navFrom({ ...storeShape(), expanded: new Set(["ts:z#1", "ts:a#1", "ts:m#1"]) });
    expect(nav.expanded).toEqual(["ts:a#1", "ts:m#1", "ts:z#1"]);
  });
});

/** The store-like shape navFrom reads — all defaults, callers override the field under test. */
function storeShape() {
  return {
    viewMode: "call" as const,
    focusId: null,
    compRoot: null,
    selectedId: null,
    compSelectedId: null,
    logicSelected: null,
    flowRootId: null,
    flowDepth: null,
    logicRoot: null,
    logicStack: [] as string[],
    expanded: new Set<string>(),
    environment: null,
  };
}
