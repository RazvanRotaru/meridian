import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import {
  collectSymbols,
  countSearchScopes,
  SearchScopeControl,
  selectResults,
  type SearchScope,
} from "./CommandPalette";

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
    { mode: "map" as const },
    { mode: "logic" as const },
  ])("classifies only leading-double-underscore methods as private in $mode mode", ({ mode }) => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), mode);
    const privateNames = symbols.filter((symbol) => symbol.isPrivateMethod).map((symbol) => symbol.displayName);

    expect(privateNames).toEqual(expect.arrayContaining(["__iter__", "__private"]));
    expect(privateNames).toHaveLength(2);
    expect(symbols.find((symbol) => symbol.displayName === "_helper")?.isPrivateMethod).toBe(false);
    expect(symbols.find((symbol) => symbol.displayName === "run__internal")?.isPrivateMethod).toBe(false);
    expect(symbols.find((symbol) => symbol.displayName === "__bootstrap__")?.isPrivateMethod).toBe(false);
    if (mode === "map") {
      expect(symbols.find((symbol) => symbol.displayName === "__Private")?.isPrivateMethod).toBe(false);
    }
  });

  it.each([
    { mode: "map" as const },
    { mode: "logic" as const },
  ])("supports public, all-symbol, and private-only search scopes in $mode mode", ({ mode }) => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), mode);

    expect(selectResults(symbols, "__iter__", mode, "public")).toEqual([]);
    expect(selectResults(symbols, "__iter__", mode, "all").map((symbol) => symbol.displayName)).toEqual(["__iter__"]);
    expect(selectResults(symbols, "__iter__", mode, "private").map((symbol) => symbol.displayName)).toEqual(["__iter__"]);
    expect(selectResults(symbols, "run", mode, "private")).toEqual([]);
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
      "map",
    );

    expect(selectResults(symbols, "", "map", "public").map((symbol) => symbol.displayName)).toEqual(["run"]);
    expect(selectResults(symbols, "", "map", "all")).toHaveLength(40);
    expect(selectResults(symbols, "", "map", "private")).toHaveLength(40);
    expect(selectResults(symbols, "", "map", "private").every((symbol) => symbol.isPrivateMethod)).toBe(true);
  });

  it("counts every searchable symbol in exactly one base scope", () => {
    const symbols = collectSymbols(ARTIFACT, new Map(NODES.map((candidate) => [candidate.id, candidate])), "map");

    expect(countSearchScopes(symbols)).toEqual({ public: 5, all: 7, private: 2 });
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
