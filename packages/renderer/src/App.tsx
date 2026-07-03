/** The app shell: store provider + React Flow provider around the blueprint canvas. */

import { ReactFlowProvider } from "@xyflow/react";
import type { BootConfig } from "./boot/bootConfig";
import { StoreProvider } from "./state/StoreContext";
import type { BlueprintStore } from "./state/store";
import { BlueprintCanvas } from "./components/BlueprintCanvas";
import { DiffDrawer } from "./components/DiffDrawer";

export function App(props: { store: BlueprintStore; boot: BootConfig }) {
  return (
    <StoreProvider store={props.store}>
      <ReactFlowProvider>
        <div style={{ height: "100%" }}>
          <BlueprintCanvas preselectedEnv={props.boot.preselectedEnv} />
          <DiffDrawer />
        </div>
      </ReactFlowProvider>
    </StoreProvider>
  );
}
