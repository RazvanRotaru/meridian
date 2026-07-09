/**
 * The top-left control panel: project identity + expand/collapse, the mandatory environment gate
 * (only when the artifact ships an overlay), and the lens / overlay / category / relationship
 * controls. Categories, relationships and the module-only dials show on the module surface
 * (Map + Service); the composition worklist rides along on the Service lens.
 */

import type { ReactNode } from "react";
import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EnvSelector } from "./EnvSelector";
import { Breadcrumb } from "./Breadcrumb";
import { ViewModeToggle } from "./ViewModeToggle";
import { FlowSelector } from "./FlowSelector";
import { CompositionPanel } from "./composition/CompositionPanel";
import { DepthSlider } from "./DepthSlider";
import { ModuleCategoryToggles } from "./ModuleCategoryToggles";
import { RelationshipToggles } from "./RelationshipToggles";
import { ControlPanelHeader } from "./controlpanel/ControlPanelHeader";
import { OverlaysSection } from "./controlpanel/OverlaysSection";
import { Divider, SectionLabel, TOKENS } from "./controlpanel/panelKit";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  const focusId = useBlueprint((state) => state.focusId);
  const { resetCategoryFilter, resetRelationshipFilter } = useBlueprintActions();

  const isComposition = viewMode === "call";
  const onModuleSurface = viewMode === "modules" || isComposition;
  const showExpandControls = viewMode !== "logic" && viewMode !== "prs";

  return (
    <Panel position="top-left">
      <div style={PANEL_STYLE}>
        <ControlPanelHeader showExpandControls={showExpandControls} />

        {hasOverlay ? (
          <>
            <Divider />
            <EnvSelector preselectedEnv={props.preselectedEnv} />
          </>
        ) : null}

        <Divider />
        <Group label="Lens">
          <ViewModeToggle />
          {focusId !== null ? <Breadcrumb /> : null}
        </Group>

        <Divider />
        <Group label="Overlays">
          <OverlaysSection />
        </Group>

        {onModuleSurface ? (
          <>
            <Divider />
            <Group label="Categories" action={{ label: "Clear", onClick: resetCategoryFilter, title: "Show all categories" }}>
              <ModuleCategoryToggles />
            </Group>

            <Divider />
            <Group label="Relationships" action={{ label: "All", onClick: resetRelationshipFilter, title: "Show all relationships" }}>
              <RelationshipToggles />
            </Group>

            <DepthSlider />
            {isComposition ? <CompositionPanel /> : null}
          </>
        ) : viewMode === "ui" || viewMode === "logic" ? (
          <>
            <Divider />
            <FlowSelector />
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function Group(props: { label: string; action?: { label: string; onClick: () => void; title?: string }; children: ReactNode }) {
  return (
    <section style={GROUP_STYLE}>
      <SectionLabel action={props.action}>{props.label}</SectionLabel>
      {props.children}
    </section>
  );
}

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 11,
  padding: 16,
  width: 296,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  overflowX: "hidden",
  boxSizing: "border-box",
  borderRadius: 14,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(10,13,18,0.94)",
  backdropFilter: "blur(8px)",
};
const GROUP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 9 };
