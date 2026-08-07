import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";

vi.mock("./CodePanel", () => ({
  CodePanel: () => <div data-source-code-dock-layer="true">source dock</div>,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => <div data-command-palette-host="true">palette</div>,
}));
vi.mock("./Toolbar", () => ({ Toolbar: () => null }));
vi.mock("./LogicFlowView", () => ({ LogicFlowView: () => <div>logic graph</div> }));
vi.mock("./ModuleMapView", () => ({ ModuleMapView: () => <div>module graph</div> }));
vi.mock("./prs/PrsView", () => ({ PrsView: () => <div>PR graph</div> }));
vi.mock("./flowexplorer/FlowExplorerPanel", () => ({
  FlowExplorerPanel: () => <aside data-flow-explorer-panel="true">flow explorer</aside>,
}));
vi.mock("./flowexplorer/FlowPane", () => ({
  FlowPane: () => <div>logic flow</div>,
  flowPaneShouldRender: () => true,
}));
vi.mock("./flowexplorer/FlowSplitView", () => ({
  FlowSplitView: (props: { graph: React.ReactNode; flow: React.ReactNode }) => (
    <main data-flow-split-root="true">
      <section data-resizable-graph-pane="true">{props.graph}</section>
      <section data-resizable-logic-pane="true">{props.flow}</section>
    </main>
  ),
}));

import { BlueprintCanvas } from "./BlueprintCanvas";

describe("BlueprintCanvas source dock host", () => {
  it("keeps global overlays after and outside every resizable pane", () => {
    const markup = renderToStaticMarkup(
      <StoreProvider store={freshStore()}>
        <BlueprintCanvas preselectedEnv={null} />
      </StoreProvider>,
    );

    const splitEndsAt = markup.indexOf("</main>");
    const commandPaletteStartsAt = markup.indexOf('data-command-palette-host="true"');
    const sourceDockStartsAt = markup.indexOf('data-source-code-dock-layer="true"');
    expect(splitEndsAt).toBeGreaterThan(-1);
    expect(commandPaletteStartsAt).toBeGreaterThan(splitEndsAt);
    expect(sourceDockStartsAt).toBeGreaterThan(splitEndsAt);
  });

  it("owns the whole workspace as one inert underlay only while the modal source side-sheet is open", () => {
    const closedMarkup = renderToStaticMarkup(
      <StoreProvider store={freshStore()}>
        <BlueprintCanvas preselectedEnv={null} />
      </StoreProvider>,
    );
    const openStore = freshStore();
    const sourceNode = [...openStore.getState().index.nodesById.values()][0]!;
    openStore.setState({
      codeView: {
        node: sourceNode,
        code: "export const source = true;",
        loading: false,
        error: null,
        mode: "modal",
      },
    });
    const openState = openStore.getState();
    Object.assign(openStore, { getInitialState: () => openState });
    const openMarkup = renderToStaticMarkup(
      <StoreProvider store={openStore}>
        <BlueprintCanvas preselectedEnv={null} />
      </StoreProvider>,
    );

    const closedUnderlay = elementWithDataAttribute(closedMarkup, "data-source-workspace-underlay");
    const openUnderlay = elementWithDataAttribute(openMarkup, "data-source-workspace-underlay");
    expect(closedUnderlay).not.toContain(" inert");
    expect(closedUnderlay).not.toContain("aria-hidden");
    expect(openUnderlay).toContain(" inert");
    expect(openUnderlay).toContain('aria-hidden="true"');

    const openUnderlayStartsAt = openMarkup.indexOf('data-source-workspace-underlay="true"');
    const openUnderlayEndsAt = openMarkup.indexOf("</main>", openUnderlayStartsAt);
    expect(openMarkup.indexOf('data-flow-explorer-panel="true"')).toBeGreaterThan(openUnderlayStartsAt);
    expect(openUnderlayEndsAt).toBeGreaterThan(openUnderlayStartsAt);
    expect(openMarkup.indexOf('data-command-palette-host="true"')).toBeGreaterThan(openUnderlayEndsAt);
    expect(openMarkup.indexOf('data-source-code-dock-layer="true"')).toBeGreaterThan(openUnderlayEndsAt);
  });
});

function elementWithDataAttribute(markup: string, attribute: string): string {
  return markup.match(new RegExp(`<div(?=[^>]*${attribute})[^>]*>`))?.[0] ?? "";
}
