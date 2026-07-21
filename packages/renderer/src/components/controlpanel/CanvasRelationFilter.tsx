/**
 * Compact action-bar access to the module lenses' canonical relationship filters. The popover is
 * only presentation: the existing per-lens overrides feed GraphSurface's paint chain, so hiding a
 * kind never relays out the focused graph or changes its review scope.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { isRelationShown } from "../../graph/relationVisibility";
import { relationshipKindsForPolicy } from "../../theme/relationshipKinds";
import { RelationshipToggles } from "../RelationshipToggles";
import { activeModuleSurfaceSpec } from "../canvas/surfaceSpec";
import { CanvasActionButton } from "./canvasActionBarKit";
import { EdgeFilterIcon } from "./icons";
import { SectionLabel, TOKENS } from "./panelKit";

const POPOVER_WIDTH = 272;
const VIEWPORT_GAP = 12;

export function CanvasRelationFilter({ kinds }: { kinds: readonly string[] }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const overrides = useBlueprint((state) => state.relationVisibilityOverrides);
  const { resetRelationshipFilter } = useBlueprintActions();
  const policy = activeModuleSurfaceSpec(viewMode).relations;
  const availableKeys = useMemo(
    () => new Set(relationshipKindsForPolicy(policy).map((kind) => kind.key)),
    [policy],
  );
  const filterKinds = useMemo(
    () => [...new Set(kinds)].filter((kind) => availableKeys.has(kind)),
    [availableKeys, kinds],
  );
  const hiddenCount = filterKinds.filter((kind) => !isRelationShown(policy, overrides, kind)).length;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const hasKinds = filterKinds.length > 0;

  useEffect(() => {
    if (hasKinds || !open) return;
    setOpen(false);
  }, [hasKinds, open]);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const bounds = buttonRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const halfWidth = Math.min(POPOVER_WIDTH / 2, Math.max(0, (window.innerWidth - VIEWPORT_GAP * 2) / 2));
      setPosition({
        left: Math.min(
          window.innerWidth - VIEWPORT_GAP - halfWidth,
          Math.max(VIEWPORT_GAP + halfWidth, bounds.left + bounds.width / 2),
        ),
        bottom: Math.max(VIEWPORT_GAP, window.innerHeight - bounds.top + 9),
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus({ preventScroll: true });
    };
    updatePosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || position === null) return;
    const frame = window.requestAnimationFrame(() => popoverRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [open, position]);

  const title = !hasKinds
    ? "No filterable edge types in this extracted graph"
    : hiddenCount > 0
      ? `${hiddenCount} edge ${hiddenCount === 1 ? "type is" : "types are"} hidden`
      : "Choose which edge types are shown";

  return (
    <>
      <CanvasActionButton
        ariaLabel="Filter edge types"
        title={title}
        icon={<EdgeFilterIcon size={18} />}
        onClick={() => setOpen((current) => !current)}
        disabled={!hasKinds}
        active={open || hiddenCount > 0}
        expanded={open}
        controls={popoverId}
        hasPopup="dialog"
        buttonRef={buttonRef}
      />
      {open && position !== null && typeof document !== "undefined" ? createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label="Edge type filters"
          tabIndex={-1}
          className="mrd-scroll"
          style={{ ...POPOVER_STYLE, left: position.left, bottom: position.bottom }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <SectionLabel
            action={{
              label: "All",
              title: "Show all relationship kinds",
              onClick: resetRelationshipFilter,
            }}
          >
            Edge types
          </SectionLabel>
          {/* Keep the compact control aligned with the full lens vocabulary. Some relationships
              (notably IPC) may enter the extracted graph through promotion or a later projection,
              so limiting the pills to the currently painted edge set makes those paths impossible
              to discover or preconfigure. */}
          <RelationshipToggles />
        </div>,
        document.body,
      ) : null}
    </>
  );
}

const POPOVER_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: POPOVER_WIDTH,
  maxWidth: `calc(100vw - ${VIEWPORT_GAP * 2}px)`,
  maxHeight: "min(70vh, 520px)",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: 13,
  transform: "translateX(-50%)",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 12,
  outline: "none",
  background: "rgba(10,13,18,0.98)",
  boxShadow: "0 14px 38px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.4)",
  backdropFilter: "blur(10px)",
};
