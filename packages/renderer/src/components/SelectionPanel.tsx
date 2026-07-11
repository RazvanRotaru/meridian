/**
 * The SELECTION section under the Lens switcher. With something selected in the active lens it
 * names the selection and offers "Scope Service view", gated by the same Service placeability the
 * carry uses (scopeTarget → serviceRevealStateForMany). When the lens can't honor it the button
 * renders disabled with the reason as its tooltip, so the reader learns WHY the selection has no
 * service home instead of watching a click fall to the lens top. Cross-lens reveal itself is
 * implicit: switching lenses carries the selection, so no per-lens buttons here.
 */

import { useMemo } from "react";
import { parseNodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { scopeTarget } from "../state/selectionReveal";
import { selectedAnchorIds } from "../state/lensPath";
import { baseName } from "../derive/flowViewModel";
import type { GraphIndex } from "../graph/graphIndex";
import { CountBadge, Divider, Pill, SectionLabel, TOKENS } from "./controlpanel/panelKit";

export function SelectionPanel() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const moduleSelected = useBlueprint((state) => state.moduleSelected);
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const index = useBlueprint((state) => state.index);
  const { openServiceScope } = useBlueprintActions();

  // The active lens's OWN explicit picks (never its focus), svc:-frames normalized to their lead
  // units — the exact anchors `openServiceScope` will carry, via the same code path.
  const anchors = useMemo(() => selectedAnchorIds({ viewMode, moduleSelected }), [viewMode, moduleSelected]);
  const scope = useMemo(() => scopeTarget(anchors, index), [anchors, index]);

  if (anchors.length === 0) {
    return null;
  }
  // Already inside a scoped Service view: the breadcrumb owns the exit, so re-scoping is hidden.
  const showScope = !(viewMode === "call" && serviceScope !== null);

  return (
    <>
      <Divider />
      <section style={SECTION_STYLE}>
        <SectionLabel>Selection</SectionLabel>
        <div style={HEADER_STYLE}>
          <span style={NAME_STYLE}>{shortName(anchors[0], index)}</span>
          {anchors.length > 1 ? <CountBadge>+{anchors.length - 1}</CountBadge> : null}
        </div>
        {showScope ? (
          <div style={ROW_STYLE} role="group" aria-label="Scope selection">
            <Pill
              active={false}
              indicator="none"
              disabled={!scope.enabled}
              title={scope.reason ?? "Show only the owning service cluster and its neighbours"}
              onClick={openServiceScope}
            >
              Scope Service view
            </Pill>
          </div>
        ) : null}
      </section>
    </>
  );
}

/** The node's display name; falls back to the id's qualname (or its module's basename) for ids the
 * graph no longer holds — parsed through core's id grammar, which also strips `~n` ordinals. */
function shortName(nodeId: string, index: GraphIndex): string {
  const display = index.nodesById.get(nodeId)?.displayName;
  if (display !== undefined && display !== "") {
    return display;
  }
  const parts = parseNodeId(nodeId);
  return parts.qualname ?? baseName(parts.modulePath);
}

const SECTION_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 9 };
const HEADER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, minWidth: 0 };
const NAME_STYLE: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: TOKENS.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
