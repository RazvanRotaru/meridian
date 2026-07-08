/**
 * UI-composition node hiding: IPC channel pseudo-nodes carry only sends/handles wires (the service
 * graph), never `renders`. In UI mode they'd be orphan cards — on a repo with hundreds of channels
 * they stack into one disconnected column that reads as a blank canvas. `withModeHidden` folds them
 * into the hidden set for UI mode only, leaving every other view untouched.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { withModeHidden } from "./deriveLayout";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

// A package with one component module, plus two top-level IPC channel pseudo-nodes.
const NODES: GraphNode[] = [
  node("ts:app", "package", "app"),
  node("ts:app/Button.tsx", "module", "app/Button.tsx", "ts:app"),
  node("ipc:http/GET+%2Fhealth", "channel", ""),
  node("ipc:electron/restart-app", "channel", ""),
];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-07T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: [],
};

const index = buildGraphIndex(ARTIFACT);

describe("withModeHidden", () => {
  it("hides every IPC channel node in UI composition mode", () => {
    const hidden = withModeHidden(index, "ui", new Set());
    expect(hidden.has("ipc:http/GET+%2Fhealth")).toBe(true);
    expect(hidden.has("ipc:electron/restart-app")).toBe(true);
    expect(hidden.has("ts:app")).toBe(false);
    expect(hidden.has("ts:app/Button.tsx")).toBe(false);
  });

  it("preserves the caller's existing hidden set (e.g. hidden tests) in UI mode", () => {
    const hidden = withModeHidden(index, "ui", new Set(["ts:app/Button.tsx"]));
    expect(hidden.has("ts:app/Button.tsx")).toBe(true);
    expect(hidden.has("ipc:http/GET+%2Fhealth")).toBe(true);
  });

  it("leaves the hidden set untouched (same reference) for non-UI modes", () => {
    const original = new Set(["ts:app/Button.tsx"]);
    for (const mode of ["call", "logic", "modules"] as const) {
      expect(withModeHidden(index, mode, original)).toBe(original);
    }
  });
});
