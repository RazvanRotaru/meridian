/**
 * The collapsible top-left control panel: its project identity, mandatory environment gate (when
 * the artifact ships an overlay), and PR review remain visible while the detailed lens / overlay /
 * filter controls fold away. Canvas-wide actions live in the separate bottom action bar. Categories,
 * relationships and the module-only dials show on the module surface (Map + Service); the
 * composition worklist rides along on the Service lens.
 */

import { useState, type ReactNode } from "react";
import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EnvSelector } from "./EnvSelector";
import { ViewModeToggle } from "./ViewModeToggle";
import { SelectionPanel } from "./SelectionPanel";
import { CompositionPanel } from "./composition/CompositionPanel";
import { DepthSlider } from "./DepthSlider";
import { ModuleCategoryToggles } from "./ModuleCategoryToggles";
import { RelationshipToggles } from "./RelationshipToggles";
import { ControlPanelHeader } from "./controlpanel/ControlPanelHeader";
import { PrReviewSection } from "./controlpanel/PrReviewSection";
import { OverlaysSection } from "./controlpanel/OverlaysSection";
import { CONTROL_PANEL_WIDTH, Divider, SectionLabel, TOKENS } from "./controlpanel/panelKit";
import { ChevronDownIcon } from "./controlpanel/icons";

const CONTROL_PANEL_ID = "meridian-control-panel";
const CONTROL_PANEL_CONTROLS_ID = "meridian-control-panel-controls";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const viewMode = useBlueprint((state) => state.viewMode);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  const { resetCategoryFilter, resetRelationshipFilter } = useBlueprintActions();

  const isComposition = viewMode === "call";
  // Every module-family lens (Map / Service / UI — unified in phase C) wears the same dials.
  const onModuleSurface = viewMode === "modules" || viewMode === "ui" || isComposition;
  return (
    <Panel position="top-left">
      <div id={CONTROL_PANEL_ID} style={PANEL_STYLE}>
        <ControlPanelHeader />

        {hasOverlay ? (
          <>
            <Divider />
            <EnvSelector preselectedEnv={props.preselectedEnv} />
          </>
        ) : null}

        <Divider />
        <div style={PR_CONTROLS_STYLE}>
          <PrReviewSection />
          <ControlsDisclosure collapsed={controlsCollapsed} onToggle={() => setControlsCollapsed((collapsed) => !collapsed)} />
          <div
            id={CONTROL_PANEL_CONTROLS_ID}
            hidden={controlsCollapsed}
            style={controlsCollapsed ? HIDDEN_CONTROLS_STYLE : CONTROLS_STYLE}
          >
            <Group label="Lens">
              <ViewModeToggle />
            </Group>
            <SelectionPanel />

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
            ) : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function ControlsDisclosure(props: { collapsed: boolean; onToggle: () => void }) {
  const label = props.collapsed ? "Show detailed controls" : "Hide detailed controls";
  return (
    <button
      type="button"
      style={DISCLOSURE_STYLE}
      title={label}
      aria-label={label}
      aria-controls={CONTROL_PANEL_CONTROLS_ID}
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
    >
      <span style={DISCLOSURE_LINE_STYLE} />
      <span style={DISCLOSURE_HANDLE_STYLE}>
        <span style={disclosureChevronStyle(props.collapsed)}>
          <ChevronDownIcon size={17} />
        </span>
      </span>
      <span style={DISCLOSURE_LINE_STYLE} />
    </button>
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
  width: CONTROL_PANEL_WIDTH,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  overflowX: "hidden",
  boxSizing: "border-box",
  borderRadius: 14,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(10,13,18,0.94)",
  backdropFilter: "blur(8px)",
};
const PR_CONTROLS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column" };
const CONTROLS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 11 };
const HIDDEN_CONTROLS_STYLE: React.CSSProperties = { ...CONTROLS_STYLE, display: "none" };
const GROUP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 9 };
const DISCLOSURE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  height: 32,
  padding: 0,
  border: "none",
  background: "transparent",
  color: TOKENS.textMuted,
  cursor: "pointer",
  font: "inherit",
};
const DISCLOSURE_LINE_STYLE: React.CSSProperties = { flex: 1, height: 1, background: TOKENS.divider };
const DISCLOSURE_HANDLE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 36,
  height: 24,
  boxSizing: "border-box",
  borderRadius: 8,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: TOKENS.surface,
  boxShadow: "0 1px 2px rgba(0,0,0,0.28)",
};

function disclosureChevronStyle(collapsed: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    flexShrink: 0,
    transform: collapsed ? "none" : "rotate(180deg)",
    transition: "transform 140ms ease",
  };
}
