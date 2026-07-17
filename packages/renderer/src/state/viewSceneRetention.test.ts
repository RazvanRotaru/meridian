import { describe, expect, it, vi } from "vitest";
import { ALPHA_RUN, freshStore } from "../parity/surfaceFixture";
import type { BlueprintState } from "./store";

const node = { id: "scene-node", position: { x: 0, y: 0 }, data: {} };
const edge = { id: "scene-edge", source: "scene-node", target: "scene-node", data: {} };
const logicNode = node as unknown as BlueprintState["logicRfNodes"][number];
const logicEdge = edge as unknown as BlueprintState["logicRfEdges"][number];

describe("inactive React Flow scene retention", () => {
  it("releases the module scene synchronously when entering the Logic view", () => {
    const store = freshStore();
    store.setState({
      moduleRfNodes: [node],
      moduleRfEdges: [edge],
      moduleLayoutStatus: "ready",
    });

    store.getState().setViewMode("logic");

    expect(store.getState()).toMatchObject({
      viewMode: "logic",
      moduleRfNodes: [],
      moduleRfEdges: [],
      moduleSemanticLayers: [],
      moduleLayoutStatus: "idle",
      moduleLayoutActivity: null,
    });
  });

  it("releases the logic scene when entering a module-family view", () => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      viewMode: "logic",
      logicRoot: ALPHA_RUN,
      logicRfNodes: [logicNode],
      logicRfEdges: [logicEdge],
      logicLayoutStatus: "ready",
      moduleRelayout,
    });

    store.getState().setViewMode("modules");

    expect(store.getState()).toMatchObject({
      viewMode: "modules",
      logicRfNodes: [],
      logicRfEdges: [],
      logicLayoutStatus: "idle",
      logicLayoutActivity: null,
    });
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });

  it("keeps navigation state but releases both scenes while browsing PRs", () => {
    const store = freshStore();
    store.setState({
      githubSource: true,
      prsList: { open: [], closed: null },
      viewMode: "logic",
      logicRoot: ALPHA_RUN,
      logicStack: [ALPHA_RUN],
      logicRfNodes: [logicNode],
      logicRfEdges: [logicEdge],
      moduleRfNodes: [node],
      moduleRfEdges: [edge],
    });

    store.getState().setViewMode("prs");

    expect(store.getState()).toMatchObject({
      viewMode: "prs",
      logicRoot: ALPHA_RUN,
      logicStack: [ALPHA_RUN],
      logicRfNodes: [],
      logicRfEdges: [],
      moduleRfNodes: [],
      moduleRfEdges: [],
    });
  });

  it("rebuilds only the prior active scene when returning from PR navigation", () => {
    const store = freshStore();
    const logicRelayout = vi.fn(async () => {});
    store.setState({
      githubSource: true,
      prsList: { open: [], closed: null },
      viewMode: "logic",
      logicRoot: ALPHA_RUN,
      logicRfNodes: [logicNode],
      logicRfEdges: [logicEdge],
      logicRelayout,
    });
    store.getState().togglePrsView();
    expect(store.getState().logicRfNodes).toEqual([]);

    store.getState().togglePrsView();

    expect(store.getState().viewMode).toBe("logic");
    expect(logicRelayout).toHaveBeenCalledWith({ label: "Restoring logic flow…" });
  });
});
