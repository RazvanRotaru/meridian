import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompactGraphSymbolEntry, GraphArtifact, GraphNode } from "@meridian/core";
import {
  awaitLatestPaletteReadiness,
  collectSymbols,
  CommandPaletteOption,
  commandPaletteLookupRequestToHandle,
  countSearchScopes,
  createCommandPaletteBackdropRef,
  createPaletteActionGate,
  commandPaletteOpenSeed,
  commandPaletteResultStatus,
  derivePaletteSymbols,
  inertCommandPaletteSiblings,
  mergeSearchSymbols,
  paletteKeyboardActivation,
  paletteVisibleResults,
  ResultRow,
  runPaletteAction,
  SearchScopeControl,
  selectResults,
  shouldCloseCommandPaletteFromBackdrop,
  shouldRestoreCommandPaletteOpener,
  symbolRowReadiness,
  shouldClosePaletteFromWindow,
  type SearchScope,
  type SymbolEntry,
} from "./CommandPalette";

describe("command palette open seed", () => {
  it("keeps the shortcut empty/public and seeds source lookup exactly in its requested scope", () => {
    expect(commandPaletteOpenSeed(null)).toEqual({ query: "", scope: "public", lookupMode: false });
    expect(commandPaletteOpenSeed({ id: 7, query: "$selected.symbol", scope: "all" })).toEqual({
      query: "$selected.symbol",
      scope: "all",
      lookupMode: true,
    });
  });

  it("ignores a replayed acknowledgement but accepts a new id as an in-place reseed", () => {
    const first = { id: 7, query: "first", scope: "all" } as const;
    const reseed = { id: 8, query: "second", scope: "public" } as const;

    expect(commandPaletteLookupRequestToHandle(null, first)).toBe(first);
    expect(commandPaletteLookupRequestToHandle(7, first)).toBeNull();
    expect(commandPaletteLookupRequestToHandle(7, { ...first, id: 6 })).toBeNull();
    expect(commandPaletteLookupRequestToHandle(7, reseed)).toBe(reseed);
    expect(commandPaletteLookupRequestToHandle(8, null)).toBeNull();
    expect(commandPaletteLookupRequestToHandle(8, undefined)).toBeNull();
  });
});

describe("command palette modal shell", () => {
  it("closes only for the backdrop's own click target", () => {
    const backdrop = {} as HTMLDivElement;
    const child = {} as EventTarget;

    expect(shouldCloseCommandPaletteFromBackdrop({ currentTarget: backdrop, target: backdrop })).toBe(true);
    expect(shouldCloseCommandPaletteFromBackdrop({ currentTarget: backdrop, target: child })).toBe(false);
  });

  it("inerts every sibling and restores each exact prior inert attribute", () => {
    const root = fakeAttributeElement();
    const interactive = fakeAttributeElement();
    const alreadyInert = fakeAttributeElement({ inert: "preserved-value" });
    const parent = { children: [interactive, root, alreadyInert] };
    root.parentElement = parent;

    const restore = inertCommandPaletteSiblings(root as unknown as HTMLElement);

    expect(interactive.getAttribute("inert")).toBe("");
    expect(alreadyInert.getAttribute("inert")).toBe("");
    expect(root.hasAttribute("inert")).toBe(false);

    restore();
    restore();
    expect(interactive.hasAttribute("inert")).toBe(false);
    expect(alreadyInert.getAttribute("inert")).toBe("preserved-value");
  });

  it("restores inert siblings when React detaches the backdrop callback ref", () => {
    const root = fakeAttributeElement();
    const shell = fakeAttributeElement();
    const parent = { children: [shell, root] };
    root.parentElement = parent;
    const backdropRef = createCommandPaletteBackdropRef();

    backdropRef(root as unknown as HTMLDivElement);
    expect(shell.getAttribute("inert")).toBe("");

    backdropRef(null);
    expect(shell.hasAttribute("inert")).toBe(false);
  });

  it("restores the opener only while focus is unclaimed and never steals prompt focus", () => {
    const body = fakeFocusElement();
    const opener = fakeFocusElement();
    const prompt = fakeFocusElement();

    expect(shouldRestoreCommandPaletteOpener(body, body, opener)).toBe(true);
    expect(shouldRestoreCommandPaletteOpener(null, body, opener)).toBe(true);
    expect(shouldRestoreCommandPaletteOpener(prompt, body, opener)).toBe(false);
    expect(shouldRestoreCommandPaletteOpener({ ...prompt, isConnected: false }, body, opener)).toBe(true);
    expect(shouldRestoreCommandPaletteOpener(body, body, { ...opener, closest: () => opener })).toBe(false);
  });
});

describe("command palette assistive result status", () => {
  it("announces asynchronous repository states and empty results politely", () => {
    expect(commandPaletteResultStatus({
      query: "alpha",
      resultCount: 0,
      workerSearchPending: true,
      indexing: null,
      indexError: false,
    })).toBe("Searching repository symbols.");
    expect(commandPaletteResultStatus({
      query: "missing",
      resultCount: 0,
      workerSearchPending: false,
      indexing: null,
      indexError: false,
    })).toBe("No symbols match missing.");
  });

  it("announces indexing progress without duplicating active-option speech", () => {
    expect(commandPaletteResultStatus({
      query: "",
      resultCount: 2,
      workerSearchPending: false,
      indexing: { indexed: 12, total: 40 },
      indexError: false,
    })).toBe("Indexing repository symbols, 12 of 40. 2 repository symbols available.");
  });
});

interface FakeAttributeElement {
  parentElement: { children: FakeAttributeElement[] } | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function fakeAttributeElement(initial: Record<string, string> = {}): FakeAttributeElement {
  const attributes = new Map(Object.entries(initial));
  return {
    parentElement: null,
    hasAttribute: (name) => attributes.has(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => { attributes.set(name, value); },
    removeAttribute: (name) => { attributes.delete(name); },
  };
}

function fakeFocusElement(): HTMLElement {
  return {
    isConnected: true,
    closest: () => null,
  } as unknown as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function node(id: string, kind: GraphNode["kind"], displayName: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: `Example.${displayName}`,
    displayName,
    location: { file: "example.py", startLine: 1 },
  };
}

const NODES = [
  node("py:example#Example.__iter__", "method", "__iter__"),
  node("py:example#Example.__private", "method", "__private"),
  node("py:example#Example._helper", "method", "_helper"),
  node("py:example#Example.run__internal", "method", "run__internal"),
  node("py:example#__bootstrap__", "function", "__bootstrap__"),
  node("py:example#Example.__Private", "class", "__Private"),
  node("py:example#Example.run", "method", "run"),
];

const ARTIFACT = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-15T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "python" },
  nodes: NODES,
  edges: [],
  extensions: {
    logicFlow: {
      "py:example#Example.__iter__": [],
      "py:example#Example.run": [],
    },
  },
} as GraphArtifact;

describe("collectSymbols", () => {
  it.each([
    { mode: "map", isMap: true },
    { mode: "logic", isMap: false },
  ])("classifies only leading-double-underscore methods as private in $mode mode", ({ isMap }) => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), isMap);
    const privateNames = symbols.filter((symbol) => symbol.isPrivateMethod).map((symbol) => symbol.displayName);

    expect(privateNames).toEqual(expect.arrayContaining(["__iter__", "__private"]));
    expect(privateNames).toHaveLength(2);
    expect(symbols.find((symbol) => symbol.displayName === "_helper")?.isPrivateMethod).toBe(false);
    expect(symbols.find((symbol) => symbol.displayName === "run__internal")?.isPrivateMethod).toBe(false);
    expect(symbols.find((symbol) => symbol.displayName === "__bootstrap__")?.isPrivateMethod).toBe(false);
    if (isMap) {
      expect(symbols.find((symbol) => symbol.displayName === "__Private")?.isPrivateMethod).toBe(false);
    }
  });

  it.each([
    { mode: "map", isMap: true },
    { mode: "logic", isMap: false },
  ])("supports public, all-symbol, and private-only search scopes in $mode mode", ({ isMap }) => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), isMap);

    expect(selectResults(symbols, "__iter__", isMap)).toEqual([]);
    expect(selectResults(symbols, "__iter__", isMap, "all").map((symbol) => symbol.displayName)).toEqual(["__iter__"]);
    expect(selectResults(symbols, "__iter__", isMap, "private").map((symbol) => symbol.displayName)).toEqual(["__iter__"]);
    expect(selectResults(symbols, "run", isMap, "private")).toEqual([]);
  });

  it("filters private methods before applying the 40-row cap", () => {
    const crowdedNodes = [
      ...Array.from({ length: 45 }, (_, index) => node(`py:example#Example.__private${index}`, "method", `__private${index}`)),
      node("py:example#Example.run", "method", "run"),
    ];
    const crowdedArtifact = { ...ARTIFACT, nodes: crowdedNodes } as GraphArtifact;
    const symbols = collectSymbols(
      crowdedArtifact,
      new Map(crowdedNodes.map((candidate) => [candidate.id, candidate])),
      true,
    );

    expect(selectResults(symbols, "", true).map((symbol) => symbol.displayName)).toEqual(["run"]);
    expect(selectResults(symbols, "", true, "all")).toHaveLength(40);
    expect(selectResults(symbols, "", true, "private")).toHaveLength(40);
    expect(selectResults(symbols, "", true, "private").every((symbol) => symbol.isPrivateMethod)).toBe(true);
  });

  it("counts every searchable symbol in exactly one base scope", () => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), true);

    expect(countSearchScopes(symbols)).toEqual({ public: 5, all: 7, private: 2 });
  });

  it("collects loaded type aliases for Map search but not Logic search", () => {
    const typeAlias = node(
      "ts:example.ts#ToolExecutionTargetAuthorizer",
      "typeAlias",
      "ToolExecutionTargetAuthorizer",
    );
    const artifact = { ...ARTIFACT, nodes: [typeAlias] } as GraphArtifact;
    const nodesById = new Map([[typeAlias.id, typeAlias]]);

    const mapSymbols = collectSymbols(artifact, nodesById, true);
    expect(selectResults(mapSymbols, "ToolExecutionTargetAuthorizer", true, "public"))
      .toMatchObject([{ id: typeAlias.id, kind: "typeAlias", isLoaded: true }]);
    expect(collectSymbols(artifact, nodesById, false)).toEqual([]);
  });

  it("adds repository-indexed symbols while loaded artifact rows remain authoritative", () => {
    const loaded = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), true);
    const merged = mergeSearchSymbols(loaded, [{
      id: "ts:other.ts#searchTarget",
      fileId: "ts:other.ts",
      displayName: "searchTarget",
      qualifiedName: "Other.searchTarget",
      kind: "function",
      file: "other.ts",
      isPrivateMethod: false,
      stepCount: 3,
    }, {
      id: NODES.at(-1)!.id,
      fileId: "ts:wrong.ts",
      displayName: "wrong",
      qualifiedName: "wrong",
      kind: "method",
      file: "wrong.ts",
      isPrivateMethod: false,
      stepCount: 99,
    }], new Map(NODES.map((candidate) => [candidate.id, candidate])), true);

    expect(merged.find((entry) => entry.id === "ts:other.ts#searchTarget")).toMatchObject({
      fileId: "ts:other.ts",
      isLoaded: false,
    });
    expect(merged.find((entry) => entry.id === NODES.at(-1)!.id)).toMatchObject({
      displayName: "run",
      isLoaded: true,
    });
  });

  it("uses a Python package initializer as the hydratable file root for its loaded symbols", () => {
    const packageNode: GraphNode = {
      id: "py:pkg",
      kind: "package",
      qualifiedName: "pkg",
      displayName: "pkg",
      location: { file: "pkg/__init__.py", startLine: 1 },
    };
    const functionNode: GraphNode = {
      id: "py:pkg#load",
      parentId: packageNode.id,
      kind: "function",
      qualifiedName: "load",
      displayName: "load",
      location: { file: "pkg/__init__.py", startLine: 2 },
    };
    const artifact = { ...ARTIFACT, nodes: [packageNode, functionNode] } as GraphArtifact;
    const nodesById = new Map([packageNode, functionNode].map((candidate) => [candidate.id, candidate]));

    expect(collectSymbols(artifact, nodesById, true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: functionNode.id, fileId: packageNode.id }),
    ]));
  });

  it("does not scan or clone a completed repository index while the palette is closed", () => {
    const unreadableNodes = {
      values() {
        throw new Error("closed palette scanned loaded graph nodes");
      },
    } as unknown as ReadonlyMap<string, GraphNode>;
    const unreadableIndex = new Proxy([] as unknown as CompactGraphSymbolEntry[], {
      get() {
        throw new Error("closed palette cloned the repository symbol index");
      },
    });
    const unreadableArtifact = new Proxy(ARTIFACT, {
      get() {
        throw new Error("closed palette inspected the loaded artifact");
      },
    });

    expect(derivePaletteSymbols(
      false,
      unreadableArtifact,
      unreadableIndex,
      unreadableNodes,
      true,
    )).toEqual([]);
  });

  it("does not inspect a Worker-backed repository index when the palette opens or queries", () => {
    const unreadableIndex = new Proxy([] as unknown as CompactGraphSymbolEntry[], {
      get() {
        throw new Error("UI thread inspected the repository symbol index");
      },
    });

    const loadedOnly = derivePaletteSymbols(
      true,
      ARTIFACT,
      unreadableIndex,
      new Map(NODES.map((candidate) => [candidate.id, candidate])),
      true,
      null,
      true,
    );

    expect(selectResults(loadedOnly, "run", true)).toMatchObject([
      { id: "py:example#Example.run" },
      { id: "py:example#Example.run__internal" },
    ]);
  });

  it("keeps local-only rows non-actionable until the authoritative worker result resolves", () => {
    const local = collectSymbols(
      ARTIFACT,
      new Map(NODES.map((candidate) => [candidate.id, candidate])),
      true,
    );

    expect(paletteVisibleResults(true, null, local)).toEqual([]);
    expect(paletteVisibleResults(true, [local[0]!], local)).toEqual([local[0]]);
    expect(paletteVisibleResults(false, null, local)).toEqual(local);
  });
});

describe("SearchScopeControl", () => {
  it.each([
    { scope: "public", label: "Public" },
    { scope: "all", label: "All symbols" },
    { scope: "private", label: "Private only" },
  ] as const)("renders the compact $label scope button", ({ scope, label }) => {
    const markup = renderToStaticMarkup(createElement(SearchScopeControl, {
      scope,
      counts: { public: 5, all: 7, private: 2 },
      open: false,
      onOpenChange: () => undefined,
      onScopeChange: () => undefined,
      onReturnToInput: () => undefined,
    }));

    expect(markup).toContain(`aria-label="Search scope: ${label}"`);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-keyshortcuts="Alt+P"');
    expect(markup).toContain(label);
    expect(markup).toContain("⌥P");
  });

  it("renders an accessible three-option menu with accurate counts", () => {
    const selected: SearchScope = "all";
    const markup = renderToStaticMarkup(createElement(SearchScopeControl, {
      scope: selected,
      counts: { public: 5, all: 7, private: 2 },
      open: true,
      onOpenChange: () => undefined,
      onScopeChange: () => undefined,
      onReturnToInput: () => undefined,
    }));

    expect(markup).toContain('role="menu"');
    expect(markup).toContain('aria-label="Search scope"');
    expect(markup.match(/role="menuitemradio"/g)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain("Public");
    expect(markup).toContain("All symbols");
    expect(markup).toContain("Private only");
    expect(markup).toContain(">5</span>");
    expect(markup).toContain(">7</span>");
    expect(markup).toContain(">2</span>");
  });

  it("omits the scope control when the current graph has no private methods", () => {
    const markup = renderToStaticMarkup(createElement(SearchScopeControl, {
      scope: "public",
      counts: { public: 5, all: 5, private: 0 },
      open: false,
      onOpenChange: () => undefined,
      onScopeChange: () => undefined,
      onReturnToInput: () => undefined,
    }));

    expect(markup).toBe("");
  });
});

describe("async palette action ownership", () => {
  it("lets a fast B pick act and fences a slower stale A completion", async () => {
    const gate = createPaletteActionGate();
    const slowA = deferred<boolean>();
    const acted: string[] = [];
    const run = async (id: string, ready: Promise<boolean>) => {
      const readiness = await awaitLatestPaletteReadiness(gate, () => ready);
      if (readiness) acted.push(id);
    };

    const pendingA = run("A", slowA.promise);
    await run("B", Promise.resolve(true));
    slowA.resolve(true);
    await pendingA;

    expect(acted).toEqual(["B"]);
  });

  it("fences a pick which finishes after Escape or backdrop close invalidates the palette", async () => {
    const gate = createPaletteActionGate();
    const loading = deferred<boolean>();
    const acted: string[] = [];
    const pending = awaitLatestPaletteReadiness(gate, () => loading.promise).then((ready) => {
      if (ready) acted.push("late");
    });

    gate.invalidate();
    loading.resolve(true);
    await pending;

    expect(acted).toEqual([]);
  });

  it("hydrates a nonresident row without revealing or adding until a later ready-row intent", async () => {
    const gate = createPaletteActionGate();
    const action = vi.fn();

    await expect(runPaletteAction(gate, false, () => Promise.resolve(true), action))
      .resolves.toBe("loaded");
    expect(action).not.toHaveBeenCalled();

    await expect(runPaletteAction(gate, true, () => Promise.resolve(true), action))
      .resolves.toBe("acted");
    expect(action).toHaveBeenCalledOnce();
  });

  it("keeps a failed load non-actionable so an explicit retry must become ready first", async () => {
    const gate = createPaletteActionGate();
    const action = vi.fn();

    await expect(runPaletteAction(gate, false, () => Promise.resolve(false), action))
      .resolves.toBe("failed");
    await expect(runPaletteAction(gate, false, () => Promise.resolve(true), action))
      .resolves.toBe("loaded");
    expect(action).not.toHaveBeenCalled();
  });
});

describe("progressive symbol row readiness", () => {
  const entry: SymbolEntry = {
    id: "ts:other.ts#searchTarget",
    fileId: "ts:other.ts",
    displayName: "searchTarget",
    qualifiedName: "Other.searchTarget",
    kind: "function",
    file: "other.ts",
    isPrivateMethod: false,
    stepCount: null,
    isLoaded: false,
  };
  const renderRow = (options: {
    loaded?: boolean;
    progressive?: boolean;
    resident?: boolean;
    focusable?: boolean;
    busy?: boolean;
    failed?: boolean;
    active?: boolean;
  } = {}) => renderToStaticMarkup(createElement(ResultRow, {
    entry: { ...entry, isLoaded: options.loaded ?? false },
    active: options.active ?? false,
    canAdd: true,
    canFocus: options.focusable ?? false,
    progressive: options.progressive ?? true,
    resident: options.resident ?? false,
    busy: options.busy ?? false,
    failed: options.failed ?? false,
    onHover: () => undefined,
    onOpen: () => undefined,
    onLoad: () => undefined,
    onFocusNode: () => undefined,
    onAdd: () => undefined,
  }));

  it("offers only a load action for a nonresident progressive row", () => {
    const markup = renderRow();

    expect(symbolRowReadiness(entry, true, false, false)).toBe("loadable");
    expect(markup).toContain('data-symbol-readiness="loadable"');
    expect(markup).toContain('data-symbol-resident="false"');
    expect(markup).toContain('aria-label="Load nearby graph for searchTarget"');
    expect(markup).toContain("Load nearby graph");
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
    expect(markup).not.toContain(" ready</span>");
  });

  it("keeps listbox options control-free while exposing every visible row action as a button", () => {
    const option = renderToStaticMarkup(createElement(CommandPaletteOption, {
      optionId: "palette-option-search-target",
      entry,
      active: true,
      readiness: "loadable",
    }));
    const row = renderRow({ loaded: true, resident: true, focusable: true, active: true });

    expect(option).toContain('id="palette-option-search-target"');
    expect(option).toContain('role="option"');
    expect(option).toContain('aria-selected="true"');
    expect(option).toContain('aria-label="searchTarget, Other.searchTarget, function, load nearby graph"');
    expect(option).not.toContain("<button");
    expect(row).not.toContain('role="option"');
    expect(row).toContain('aria-label="Open searchTarget"');
    expect(row).toContain('aria-label="Focus searchTarget in the current graph"');
    expect(row).toContain('aria-label="Add searchTarget to the current view"');
  });

  it("reports graph residency independently from progressive readiness", () => {
    const markup = renderRow({ resident: true });

    expect(markup).toContain('data-symbol-readiness="loadable"');
    expect(markup).toContain('data-symbol-resident="true"');
    expect(markup).toContain('aria-label="Load nearby graph for searchTarget"');
    expect(markup).not.toContain('aria-label="Focus searchTarget in the current graph"');
  });

  it("offers an accessible magnifier only when the exact node is drawn on the active canvas", () => {
    const focusable = renderRow({ loaded: true, resident: true, focusable: true });
    const residentOnly = renderRow({ loaded: true, resident: true });

    expect(focusable).toContain('aria-label="Focus searchTarget in the current graph"');
    expect(focusable).toContain('title="Focus this node in the current graph"');
    expect(residentOnly).not.toContain('aria-label="Focus searchTarget in the current graph"');
  });

  it("disables the row while hydration is in flight", () => {
    const markup = renderRow({ busy: true });

    expect(markup).toContain('data-symbol-readiness="hydrating"');
    expect(markup).toContain("loading nearby graph…");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("blocks keyboard reveal and add while the row is hydrating, even if it became resident", () => {
    const loaded = { ...entry, isLoaded: true };

    expect(paletteKeyboardActivation(loaded, {
      progressive: true,
      busy: true,
      failed: false,
      canAdd: true,
      addModifier: false,
    })).toBeNull();
    expect(paletteKeyboardActivation(loaded, {
      progressive: true,
      busy: true,
      failed: false,
      canAdd: true,
      addModifier: true,
    })).toBeNull();
  });

  it("keeps canonical keyboard actions available after stale progressive busy or failure state", () => {
    expect(paletteKeyboardActivation(entry, {
      progressive: false,
      busy: true,
      failed: true,
      canAdd: true,
      addModifier: false,
    })).toBe("open");
    expect(paletteKeyboardActivation(entry, {
      progressive: false,
      busy: true,
      failed: true,
      canAdd: true,
      addModifier: true,
    })).toBe("add");
  });

  it("returns a failed row to an explicit retry-load state", () => {
    const markup = renderRow({ failed: true });

    expect(markup).toContain('data-symbol-readiness="retry"');
    expect(markup).toContain('aria-label="Retry loading nearby graph for searchTarget"');
    expect(markup).toContain("Retry load");
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("visibly marks a ready row and enables both open and add", () => {
    const markup = renderRow({ loaded: true, resident: true });

    expect(markup).toContain('data-symbol-readiness="ready"');
    expect(markup).toContain('data-symbol-resident="true"');
    expect(markup).toContain(" ready</span>");
    expect(markup).not.toContain('disabled=""');
  });

  it("preserves canonical full-graph rows without progressive readiness chrome", () => {
    const markup = renderRow({ progressive: false, resident: true });

    expect(symbolRowReadiness(entry, false, false, true)).toBe("canonical");
    expect(markup).toContain('data-symbol-readiness="canonical"');
    expect(markup).not.toContain("Load nearby graph");
    expect(markup).not.toContain("Retry load");
    expect(markup).not.toContain(" ready</span>");
    expect(markup).not.toContain('disabled=""');
  });
});

describe("global palette dismissal", () => {
  it("owns an unhandled Escape while the palette is open, regardless of focused child", () => {
    expect(shouldClosePaletteFromWindow({ key: "Escape", defaultPrevented: false }, true)).toBe(true);
  });

  it("preserves a focused child's narrower Escape behavior and ignores closed palettes", () => {
    expect(shouldClosePaletteFromWindow({ key: "Escape", defaultPrevented: true }, true)).toBe(false);
    expect(shouldClosePaletteFromWindow({ key: "Escape", defaultPrevented: false }, false)).toBe(false);
    expect(shouldClosePaletteFromWindow({ key: "Enter", defaultPrevented: false }, true)).toBe(false);
  });
});
