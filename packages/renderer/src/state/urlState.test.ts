import { describe, expect, it } from "vitest";
import { DEFAULT_NAV, decodeNav, decodeNavState, encodeNav, isNavigationChange, mergeNavIntoSearch, navFrom, type NavState } from "./urlState";

/** A NavState at every default — the empty starting point the app boots into. */
function emptyNav(): NavState {
  return {
    viewMode: "modules",
    compRoot: null,
    compSelectedId: null,
    logicSelected: null,
    flowExplorerOpen: false,
    flowSelection: null,
    logicRoot: null,
    logicView: "graph",
    logicStack: [],
    moduleFocus: null,
    minimalSeedIds: [],
    moduleExpanded: [],
    moduleRadius: 1,
    highlightMode: "node",
    hiddenCategories: [],
    prsTab: "open",
    prSelected: null,
    reviewPr: null,
    reviewActive: false,
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

  it("encodes the non-default composition lens explicitly (view=call)", () => {
    expect(encodeNav({ ...emptyNav(), viewMode: "call" }).get("view")).toBe("call");
  });

  it("round-trips the logic sub-view, omitting the default and rejecting junk", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "logic", logicRoot: "ts:src/a.ts#f", logicView: "metro" };
    expect(roundTrip(nav).logicView).toBe("metro");
    expect(encodeNav(emptyNav()).has("lview")).toBe(false);
    expect(decodeNav(new URLSearchParams("lview=bogus")).logicView).toBeUndefined();
  });

  it("round-trips a ui-graph view over the SHARED module keys (mfocus + mexp)", () => {
    const nav: NavState = {
      ...emptyNav(),
      viewMode: "ui",
      moduleFocus: "ts:packages/orders/src",
      moduleExpanded: ["ts:a", "ts:b"],
    };
    expect(roundTrip(nav)).toEqual({
      viewMode: "ui",
      moduleFocus: "ts:packages/orders/src",
      moduleExpanded: ["ts:a", "ts:b"],
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

  it("round-trips the flow explorer open state and selected block ref", () => {
    const nav: NavState = {
      ...emptyNav(),
      flowExplorerOpen: true,
      flowSelection: { rootId: "ts:src/a.ts#run", blockPath: [{ step: 3 }, { step: 4, path: 1 }] },
    };
    expect(encodeNav(nav).get("fexp")).toBe("1");
    expect(encodeNav(nav).get("fsel")).toBe("ts%3Asrc%2Fa.ts%23run@3.4-1");
    expect(roundTrip(nav)).toEqual({
      flowExplorerOpen: true,
      flowSelection: { rootId: "ts:src/a.ts#run", blockPath: [{ step: 3 }, { step: 4, path: 1 }] },
    });
  });

  it("ignores invalid flow explorer selection refs", () => {
    expect(decodeNav(new URLSearchParams("fsel=missing-at")).flowSelection).toBeUndefined();
    expect(decodeNav(new URLSearchParams("fsel=ts%253Am%2523f@1-nope")).flowSelection).toBeUndefined();
  });

  it("round-trips a selected environment", () => {
    expect(roundTrip({ ...emptyNav(), environment: "staging" })).toEqual({ environment: "staging" });
  });

  it("round-trips a module-map view (focus + hidden categories)", () => {
    const nav: NavState = {
      ...emptyNav(),
      viewMode: "modules",
      moduleFocus: "ts:packages/autopilot-studioweb",
      hiddenCategories: ["config", "util"],
    };
    // "modules" is now the default lens, so it is omitted from the URL (and not decoded back).
    expect(roundTrip(nav)).toEqual({
      moduleFocus: "ts:packages/autopilot-studioweb",
      hiddenCategories: ["config", "util"],
    });
  });

  it("omits module-map keys at their defaults (radius 1, no focus, no hidden categories)", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "modules", moduleRadius: 1, hiddenCategories: [] };
    expect(encodeNav(nav).has("mfocus")).toBe(false);
    expect(encodeNav(nav).has("mdepth")).toBe(false);
    expect(encodeNav(nav).has("mhide")).toBe(false);
  });

  it("round-trips the inline-expanded group ids (mexp)", () => {
    const nav: NavState = {
      ...emptyNav(),
      viewMode: "modules",
      moduleExpanded: ["ts:pkgA", "ts:pkgA/src"],
    };
    expect(encodeNav(nav).get("mexp")).toBe("ts:pkgA,ts:pkgA/src");
    expect(roundTrip(nav)).toEqual({ moduleExpanded: ["ts:pkgA", "ts:pkgA/src"] });
  });

  it("round-trips the selection highlight radius (mdepth)", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "modules", moduleRadius: 3 };
    expect(encodeNav(nav).get("mdepth")).toBe("3");
    expect(roundTrip(nav)).toEqual({ moduleRadius: 3 });
  });

  it("round-trips the open minimal-graph overlay seeds (mgraph)", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "modules", minimalSeedIds: ["ts:src/a.ts", "ts:src/b.ts"] };
    expect(encodeNav(nav).get("mgraph")).toBe("ts:src/a.ts,ts:src/b.ts");
    expect(roundTrip(nav)).toEqual({ minimalSeedIds: ["ts:src/a.ts", "ts:src/b.ts"] });
  });

  it("omits the minimal-graph seed key when the overlay is closed", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "modules", minimalSeedIds: [] };
    expect(encodeNav(nav).has("mgraph")).toBe(false);
  });

  it("round-trips the Service lens's cluster focus (mfocus with a svc: id under view=call)", () => {
    const frameId = "svc:ts:app/a.ts#AlphaService";
    const nav: NavState = { ...emptyNav(), viewMode: "call", moduleFocus: frameId };
    expect(encodeNav(nav).get("mfocus")).toBe(frameId);
    expect(roundTrip(nav)).toEqual({ viewMode: "call", moduleFocus: frameId });
  });

  it("round-trips the non-default highlight mode (hmode)", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "modules", highlightMode: "reach" };
    expect(encodeNav(nav).get("hmode")).toBe("reach");
    expect(roundTrip(nav)).toEqual({ highlightMode: "reach" });
    expect(decodeNav(new URLSearchParams("hmode=bogus")).highlightMode).toBeUndefined();
  });

  it("round-trips the PR browser view, tab, and selected PR number", () => {
    const nav: NavState = { ...emptyNav(), viewMode: "prs", prsTab: "closed", prSelected: 76 };
    expect(encodeNav(nav).get("view")).toBe("prs");
    expect(encodeNav(nav).get("prstate")).toBe("closed");
    expect(encodeNav(nav).get("prn")).toBe("76");
    expect(roundTrip(nav)).toEqual({ viewMode: "prs", prsTab: "closed", prSelected: 76 });
  });

  it("round-trips an active modules review with an explicit lens, PR number, and review flag", () => {
    const nav: NavState = { ...emptyNav(), reviewPr: 76, reviewActive: true };
    const encoded = encodeNav(nav);
    expect(Object.fromEntries(encoded)).toMatchObject({ view: "modules", prn: "76", rev: "1" });
    expect(roundTrip(nav)).toEqual({ viewMode: "modules", reviewPr: 76, reviewActive: true });
  });

  it("rejects invalid PR URL params", () => {
    expect(decodeNav(new URLSearchParams("prstate=merged")).prsTab).toBeUndefined();
    expect(decodeNav(new URLSearchParams("prn=0")).prSelected).toBeUndefined();
    expect(decodeNav(new URLSearchParams("prn=abc")).prSelected).toBeUndefined();
  });

  it("preserves foreign params (web-mode id) while owning its own keys", () => {
    const search = mergeNavIntoSearch("id=abc123", { ...emptyNav(), viewMode: "ui", moduleFocus: "ts:pkg/src" });
    const params = new URLSearchParams(search);
    expect(params.get("id")).toBe("abc123");
    expect(params.get("mfocus")).toBe("ts:pkg/src");
  });

  it("survives a node id with every special character intact (scalar + list)", () => {
    const id = "ts:packages/a/b.ts#Outer.inner~2";
    const nav: NavState = { ...emptyNav(), viewMode: "logic", logicRoot: id, logicStack: [id] };
    const search = mergeNavIntoSearch("", nav);
    const decoded = decodeNav(new URLSearchParams(search));
    expect(decoded.logicRoot).toBe(id);
    expect(decoded.logicStack).toEqual([id]);
  });

  describe("scopes the URL to the active lens (no cross-lens leakage)", () => {
    // A store that has visited every lens still holds each lens's nav state; the URL must reflect
    // only the lens on screen, never the union — this is the accumulating-URL fix.
    function everyLensVisited(viewMode: NavState["viewMode"]): NavState {
      return {
        ...emptyNav(),
        viewMode,
        compRoot: "ts:pkg",
        compSelectedId: "ts:pkg#Unit",
        logicRoot: "ts:m.ts#run",
        logicStack: ["ts:m.ts#run"],
        logicSelected: "ts:m.ts#leaf",
        moduleFocus: "ts:pkg/src",
        moduleExpanded: ["ts:pkg/src/a.ts"],
        prSelected: 42,
      };
    }

    it("on the Map, drops ui / call / logic / prs keys", () => {
      const keys = [...encodeNav(everyLensVisited("modules")).keys()].sort();
      expect(keys).toEqual(["mexp", "mfocus"]);
    });

    it("on the Service lens, keeps its root/selection AND the shared moduleFocus (the cluster zoom)", () => {
      const keys = [...encodeNav(everyLensVisited("call")).keys()].sort();
      expect(keys).toEqual(["csel", "mfocus", "root", "view"]);
    });

    it("on the Map, does not leak a retained PR-browser selection", () => {
      expect(encodeNav({ ...emptyNav(), prSelected: 42 }).has("prn")).toBe(false);
    });

    it("on Logic, drops Map / ui / call / prs keys", () => {
      const keys = [...encodeNav(everyLensVisited("logic")).keys()].sort();
      expect(keys).toEqual(["lroot", "lsel", "lstack", "view"]);
    });

    it("on the ui graph, keeps the SHARED module keys and drops logic / call / prs keys", () => {
      const keys = [...encodeNav(everyLensVisited("ui")).keys()].sort();
      expect(keys).toEqual(["mexp", "mfocus", "view"]);
    });

    it("on the PR browser, drops every graph-lens key", () => {
      const keys = [...encodeNav(everyLensVisited("prs")).keys()].sort();
      expect(keys).toEqual(["prn", "view"]);
    });

    it("keeps cross-cutting flow-explorer + env keys in any lens", () => {
      const nav: NavState = {
        ...emptyNav(),
        viewMode: "modules",
        environment: "staging",
        flowExplorerOpen: true,
      };
      const keys = [...encodeNav(nav).keys()].sort();
      expect(keys).toEqual(["env", "fexp"]);
    });
  });

  describe("decodeNavState (complete state for back/forward resets)", () => {
    it("returns the full defaults for an empty query", () => {
      expect(decodeNavState(new URLSearchParams(""))).toEqual(DEFAULT_NAV);
    });

    it("resets an absent key to default (a dive undoes on back)", () => {
      expect(decodeNavState(new URLSearchParams("mfocus=ts:a")).moduleFocus).toBe("ts:a");
      // Navigating back to a URL with no focus must null moduleFocus, not leave the stale dive.
      expect(decodeNavState(new URLSearchParams("")).moduleFocus).toBeNull();
      // A LEGACY pre-unification ui deep link's `focus` still lands on the shared module focus.
      expect(decodeNavState(new URLSearchParams("view=ui&focus=ts:a%23b")).moduleFocus).toBe("ts:a#b");
    });

    it("merges present keys over defaults for a mixed URL", () => {
      const nav = decodeNavState(new URLSearchParams("view=ui&mfocus=ts:pkg%2Fsrc"));
      expect(nav.viewMode).toBe("ui");
      expect(nav.moduleFocus).toBe("ts:pkg/src");
      // Untouched fields stay at their defaults.
      expect(nav.logicStack).toEqual([]);
      expect(nav.moduleExpanded).toEqual([]);
    });
  });

  describe("isNavigationChange", () => {
    const base = emptyNav();

    it("is true when the module focus changes", () => {
      expect(isNavigationChange(base, { ...base, moduleFocus: "ts:pkg/src" })).toBe(true);
    });

    it("is true when the view mode changes", () => {
      expect(isNavigationChange(base, { ...base, viewMode: "logic" })).toBe(true);
    });

    it("is true when the logic stack is pushed", () => {
      expect(isNavigationChange(base, { ...base, logicStack: ["ts:m.ts#f"] })).toBe(true);
    });

    it("is true when the minimal-graph overlay opens (so Back returns to the level)", () => {
      expect(isNavigationChange(base, { ...base, minimalSeedIds: ["ts:src/a.ts"] })).toBe(true);
    });

    it("is true when the overlay closes (seeds go back to empty)", () => {
      const open = { ...base, minimalSeedIds: ["ts:src/a.ts"] };
      expect(isNavigationChange(open, base)).toBe(true);
    });

    it("is true when a review starts even when it has no graph seeds", () => {
      expect(isNavigationChange(base, { ...base, reviewPr: 76, reviewActive: true })).toBe(true);
    });

    it("is false for a selection-only change", () => {
      expect(isNavigationChange(base, { ...base, compSelectedId: "ts:m.ts#f" })).toBe(false);
    });

    it("is false for an expansion-only change", () => {
      expect(isNavigationChange(base, { ...base, moduleExpanded: ["ts:m.ts#f"] })).toBe(false);
    });
  });

  it("sorts expanded ids so the URL is deterministic regardless of Set order", () => {
    const nav = navFrom({ ...storeShape(), moduleExpanded: new Set(["ts:z#1", "ts:a#1", "ts:m#1"]) });
    expect(nav.moduleExpanded).toEqual(["ts:a#1", "ts:m#1", "ts:z#1"]);
  });
});

/** The store-like shape navFrom reads — all defaults, callers override the field under test. */
function storeShape() {
  return {
    viewMode: "modules" as const,
    compRoot: null,
    compSelectedId: null,
    logicSelected: null,
    flowExplorerOpen: false,
    flowSelection: null,
    logicRoot: null,
    logicView: "graph" as const,
    logicStack: [] as string[],
    moduleFocus: null,
    minimalSeedIds: [] as string[],
    moduleExpanded: new Set<string>(),
    moduleRadius: 1,
    highlightMode: "node" as const,
    hiddenCategories: new Set<string>(),
    prsTab: "open" as const,
    prSelected: null,
    prReviewed: null,
    environment: null,
  };
}
