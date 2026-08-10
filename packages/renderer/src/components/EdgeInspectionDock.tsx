/**
 * One graph-local home for a clicked wire's two kinds of evidence: contextual source on the left
 * and the aggregate relationship trail on the right. The dock owns the sole Escape/close layer so
 * neither half can outlive the other. It is intentionally non-modal: the graph remains usable and
 * clicking another wire replaces this inspection in place.
 */

import type { Edge } from "@xyflow/react";
import { MoveIcon, ResetIcon } from "@radix-ui/react-icons";
import { EdgeSourcePane } from "./CodePanel";
import { WireInspector } from "./WireInspector";
import { useBlueprint } from "../state/StoreContext";
import { useReviewLineComposerGuard } from "./review/useReviewLineComposerGuard";
import {
  FLOATING_SOURCE_WINDOW_PORTAL_HOST_ID,
  FloatingSourceWindow,
  type FloatingSourceWindowControls,
} from "./source/FloatingSourceWindow";

interface EdgeInspectionDockProps {
  pair: Edge[];
  labelOf: (id: string) => string | undefined;
  onClose: () => void;
  onDrill: (edge: Edge) => void;
}

export function EdgeInspectionDock({ pair, labelOf, onClose, onDrill }: EdgeInspectionDockProps) {
  const sourcePath = useBlueprint((state) => state.codeView?.edgeEvidence === undefined
    ? null
    : state.codeView.node.location.file);
  const requestClose = useReviewLineComposerGuard(onClose, sourcePath);
  return (
    <FloatingSourceWindow
      ariaLabel="Edge inspection"
      closeLabel={sourcePath === null ? "Close edge inspection" : "Close source"}
      onClose={requestClose}
      defaultRegionElementId="meridian-review-graph-pane"
      portalElementId={FLOATING_SOURCE_WINDOW_PORTAL_HOST_ID}
      railLabel="Related edge evidence"
      railCount={sourcePath === null ? undefined : pair.length}
      main={(windowControls) => (
        <div data-edge-inspection-dock="true" style={SOURCE_HOST_STYLE}>
          {sourcePath === null ? (
            <EdgeMetadataPane
              pair={pair}
              labelOf={labelOf}
              onClose={requestClose}
              onDrill={onDrill}
              windowControls={windowControls}
            />
          ) : (
            <EdgeSourcePane
              windowControls={windowControls}
              relatedCodeCount={pair.length}
              relatedRailLabel="Related edge evidence"
            />
          )}
        </div>
      )}
      rail={sourcePath === null ? undefined : (windowControls) => (
        <WireInspector
          pair={pair}
          labelOf={labelOf}
          onClose={requestClose}
          onDrill={onDrill}
          frameClose={windowControls.sideRailCloseButton}
          showClose={false}
        />
      )}
    />
  );
}

function EdgeMetadataPane(props: {
  pair: Edge[];
  labelOf: (id: string) => string | undefined;
  onClose: () => void;
  onDrill: (edge: Edge) => void;
  windowControls: FloatingSourceWindowControls;
}) {
  return (
    <div style={METADATA_PANEL_STYLE} data-edge-metadata-only="true">
      <header
        style={METADATA_HEADER_STYLE}
        data-source-window-frame-close-reserved="true"
        {...props.windowControls.headerDragProps}
      >
        <h2 style={METADATA_TITLE_STYLE}>Edge inspection</h2>
        <div style={METADATA_ACTIONS_STYLE} data-source-header-actions="true">
          <button {...props.windowControls.moveHandleProps} style={METADATA_ACTION_STYLE}>
            <MoveIcon />
          </button>
          <button
            type="button"
            style={METADATA_ACTION_STYLE}
            aria-label="Reset source window position and size"
            title="Reset source window position and size"
            data-source-window-reset="true"
            onClick={props.windowControls.resetGeometry}
          >
            <ResetIcon />
          </button>
        </div>
      </header>
      <div style={METADATA_BODY_STYLE}>
        <WireInspector
          pair={props.pair}
          labelOf={props.labelOf}
          onClose={props.onClose}
          onDrill={props.onDrill}
          showClose={false}
        />
      </div>
    </div>
  );
}

const SOURCE_HOST_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  overflow: "hidden",
};

const METADATA_PANEL_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  overflow: "hidden",
};

const METADATA_HEADER_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 48px 10px 12px",
  borderBottom: "1px solid #2A2F37",
  background: "#161B22",
};

const METADATA_TITLE_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#E6EDF3",
  fontSize: 14,
  fontWeight: 600,
};

const METADATA_ACTIONS_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const METADATA_ACTION_STYLE: React.CSSProperties = {
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "#1A1F27",
  color: "#9AA4B2",
  cursor: "pointer",
};

const METADATA_BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};
