import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshStore } from "../../parity/surfaceFixture";
import { StoreProvider } from "../../state/StoreContext";

const flowHooks = vi.hoisted(() => ({
  useFlowTree: vi.fn(() => []),
  useLogicFlows: vi.fn(() => ({})),
}));

vi.mock("./useFlowTree", () => flowHooks);

import { FlowExplorerPanel } from "./FlowExplorerPanel";

beforeEach(() => {
  flowHooks.useFlowTree.mockClear();
  flowHooks.useLogicFlows.mockClear();
});

describe("FlowExplorerPanel derivation lifetime", () => {
  it("does not build global flow collections while the explorer is closed", () => {
    const store = freshStore();
    store.setState({ flowExplorerOpen: false, viewMode: "modules" });
    store.getInitialState = store.getState;

    const markup = renderToStaticMarkup(<StoreProvider store={store}><FlowExplorerPanel /></StoreProvider>);

    expect(markup).toBe("");
    expect(flowHooks.useFlowTree).not.toHaveBeenCalled();
    expect(flowHooks.useLogicFlows).not.toHaveBeenCalled();
  });

  it("does not build global flow collections in a mode where the explorer cannot render", () => {
    const store = freshStore();
    store.setState({ flowExplorerOpen: true, viewMode: "logic" });
    store.getInitialState = store.getState;

    renderToStaticMarkup(<StoreProvider store={store}><FlowExplorerPanel /></StoreProvider>);

    expect(flowHooks.useFlowTree).not.toHaveBeenCalled();
    expect(flowHooks.useLogicFlows).not.toHaveBeenCalled();
  });

  it("derives the flow collections only for the visible explorer body", () => {
    const store = freshStore();
    store.setState({ flowExplorerOpen: true, viewMode: "modules" });
    store.getInitialState = store.getState;

    const markup = renderToStaticMarkup(<StoreProvider store={store}><FlowExplorerPanel /></StoreProvider>);

    expect(markup).toContain("Code flows");
    expect(flowHooks.useFlowTree).toHaveBeenCalledOnce();
    expect(flowHooks.useLogicFlows).toHaveBeenCalledOnce();
  });
});
