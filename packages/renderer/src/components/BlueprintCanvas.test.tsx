import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";

vi.mock("./CodePanel", () => ({
  CodePanel: () => <div data-source-code-backdrop="true">source modal</div>,
}));

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./Toolbar", () => ({ Toolbar: () => null }));
vi.mock("./LogicFlowView", () => ({ LogicFlowView: () => <div>logic graph</div> }));
vi.mock("./ModuleMapView", () => ({ ModuleMapView: () => <div>module graph</div> }));
vi.mock("./prs/PrsView", () => ({ PrsView: () => <div>PR graph</div> }));
vi.mock("./flowexplorer/FlowExplorerPanel", () => ({ FlowExplorerPanel: () => null }));
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

describe("BlueprintCanvas source modal host", () => {
  it("keeps the modal outside both resizable panes so minimizing either pane cannot hide it", () => {
    const markup = renderToStaticMarkup(
      <StoreProvider store={freshStore()}>
        <BlueprintCanvas preselectedEnv={null} />
      </StoreProvider>,
    );

    const splitEndsAt = markup.indexOf("</main>");
    const sourceModalStartsAt = markup.indexOf('data-source-code-backdrop="true"');
    expect(splitEndsAt).toBeGreaterThan(-1);
    expect(sourceModalStartsAt).toBeGreaterThan(splitEndsAt);
  });
});
