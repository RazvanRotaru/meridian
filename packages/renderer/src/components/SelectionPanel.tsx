/**
 * The SELECTION section under the Lens switcher — the discoverable face of cross-lens path carry.
 * With something selected in the active lens it names the selection and offers "Reveal in <lens>"
 * per other lens (a plain `setViewMode`; the carry does the placing) plus "Scope Service view",
 * which reads its enablement off the same Service reveal entry the buttons use — one placeability
 * computation per render. Buttons a lens can't honor render disabled with the reason as their
 * tooltip, so the reader learns WHY a node has no home there instead of watching a click fall to
 * the lens top.
 */

import { useMemo } from "react";
import { parseNodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { revealTargets } from "../state/selectionReveal";
import { selectedAnchorIds } from "../state/lensPath";
import { baseName } from "../derive/flowViewModel";
import type { GraphIndex } from "../graph/graphIndex";
import { CountBadge, Divider, Pill, SectionLabel, TOKENS } from "./controlpanel/panelKit";

export function SelectionPanel() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const moduleSelected = useBlueprint((state) => state.moduleSelected);
  const selectedId = useBlueprint((state) => state.selectedId);
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const index = useBlueprint((state) => state.index);
  const { setViewMode, openServiceScope } = useBlueprintActions();

  // The active lens's OWN explicit picks (never its focus), svc:-frames normalized to their lead
  // units — the exact anchors `setViewMode`/`openServiceScope` will carry, via the same code path.
  const anchors = useMemo(() => selectedAnchorIds({ viewMode, moduleSelected, selectedId }), [viewMode, moduleSelected, selectedId]);
  const targets = useMemo(() => revealTargets(anchors, index), [anchors, index]);

  if (anchors.length === 0) {
    return null;
  }
  const serviceTarget = targets.find((target) => target.mode === "call") ?? null;
  // Already inside a scoped Service view: the breadcrumb owns the exit, so re-scoping is hidden.
  const showScope = serviceTarget !== null && !(viewMode === "call" && serviceScope !== null);

  return (
    <>
      <Divider />
      <section style={SECTION_STYLE}>
        <SectionLabel>Selection</SectionLabel>
        <div style={HEADER_STYLE}>
          <span style={NAME_STYLE}>{shortName(anchors[0], index)}</span>
          {anchors.length > 1 ? <CountBadge>+{anchors.length - 1}</CountBadge> : null}
        </div>
        <div style={ROW_STYLE} role="group" aria-label="Reveal selection">
          {targets
            .filter((target) => target.mode !== viewMode)
            .map((target) => (
              <Pill
                key={target.mode}
                active={false}
                indicator="none"
                disabled={!target.enabled}
                title={target.reason ?? `Open the ${target.label} lens on this selection`}
                onClick={() => setViewMode(target.mode)}
              >
                Reveal in {target.label}
              </Pill>
            ))}
          {showScope ? (
            <Pill
              active={false}
              indicator="none"
              disabled={!serviceTarget.enabled}
              title={serviceTarget.reason ?? "Show only the owning service cluster and its neighbours"}
              onClick={openServiceScope}
            >
              Scope Service view
            </Pill>
          ) : null}
        </div>
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
