/**
 * One graph-local home for a clicked wire's two kinds of evidence: contextual source on the left
 * and the aggregate relationship trail on the right. The dock owns the sole Escape/close layer so
 * neither half can outlive the other. It is intentionally non-modal: the graph remains usable and
 * clicking another wire replaces this inspection in place.
 */

import type { Edge } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { EdgeSourcePane } from "./CodePanel";
import { WireInspector } from "./WireInspector";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { useBlueprint } from "../state/StoreContext";
import { useReviewLineComposerGuard } from "./review/useReviewLineComposerGuard";

interface EdgeInspectionDockProps {
  pair: Edge[];
  labelOf: (id: string) => string | undefined;
  onClose: () => void;
  onDrill: (edge: Edge) => void;
}

export function EdgeInspectionDock({ pair, labelOf, onClose, onDrill }: EdgeInspectionDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const sourcePath = useBlueprint((state) => state.codeView?.edgeEvidence === undefined
    ? null
    : state.codeView.node.location.file);
  const requestClose = useReviewLineComposerGuard(onClose, sourcePath);
  useClearOnEscape(requestClose, true);
  useEffect(() => {
    const previous = document.activeElement;
    dockRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <div
      ref={dockRef}
      tabIndex={-1}
      data-edge-inspection-dock="true"
      role="dialog"
      aria-label="Edge inspection"
      style={DOCK_STYLE}
      onClick={(event) => event.stopPropagation()}
    >
      <EdgeSourcePane />
      <WireInspector pair={pair} labelOf={labelOf} onClose={requestClose} onDrill={onDrill} />
    </div>
  );
}

const DOCK_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 30,
  display: "flex",
  alignItems: "stretch",
  maxWidth: "calc(100% - 24px)",
  maxHeight: "min(72vh, 700px)",
  overflow: "hidden",
  background: "rgba(22, 27, 34, 0.98)",
  border: "1px solid #30363d",
  borderRadius: 10,
  boxShadow: "0 18px 48px rgba(0,0,0,0.48)",
};
