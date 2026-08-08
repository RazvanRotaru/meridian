import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CanvasActionButton } from "./canvasActionBarKit";
import { MoreActionsIcon } from "./icons";
import { TOKENS } from "./panelKit";

const POPOVER_WIDTH = 322;
const VIEWPORT_GAP = 12;

export interface CanvasActionOverflowSection {
  label: string;
  children: React.ReactNode;
}

interface OverflowPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Keeps compacted canvas actions reachable without allowing the bar to leave its bottom lane. */
export function CanvasActionOverflow({
  enabled,
  fallbackFocusRef,
  triggerRef,
  sections,
}: {
  enabled: boolean;
  fallbackFocusRef: RefObject<HTMLButtonElement | null>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  sections: readonly CanvasActionOverflowSection[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<OverflowPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusedForOpen = useRef(false);
  const popoverId = useId();

  useEffect(() => {
    if (!open || !enabled) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const bounds = buttonRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const halfWidth = Math.min(POPOVER_WIDTH / 2, Math.max(0, (window.innerWidth - VIEWPORT_GAP * 2) / 2));
      const spaceAbove = bounds.top - VIEWPORT_GAP - POPOVER_OFFSET;
      const spaceBelow = window.innerHeight - bounds.bottom - VIEWPORT_GAP - POPOVER_OFFSET;
      const viewportHeight = Math.max(0, window.innerHeight - VIEWPORT_GAP * 2);
      const useViewportHeight = Math.max(spaceAbove, spaceBelow) < MIN_POPOVER_HEIGHT;
      const placeAbove = !useViewportHeight
        && (spaceAbove >= Math.min(PREFERRED_POPOVER_HEIGHT, viewportHeight) || spaceAbove >= spaceBelow);
      const verticalPosition = useViewportHeight
        ? { top: VIEWPORT_GAP, maxHeight: viewportHeight }
        : placeAbove
          ? {
              bottom: window.innerHeight - bounds.top + POPOVER_OFFSET,
              maxHeight: Math.min(PREFERRED_POPOVER_HEIGHT, spaceAbove),
            }
          : {
              top: bounds.bottom + POPOVER_OFFSET,
              maxHeight: Math.min(PREFERRED_POPOVER_HEIGHT, spaceBelow),
            };
      setPosition({
        left: Math.min(
          window.innerWidth - VIEWPORT_GAP - halfWidth,
          Math.max(VIEWPORT_GAP + halfWidth, bounds.left + bounds.width / 2),
        ),
        ...verticalPosition,
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const elementTarget = target instanceof Element ? target : target.parentElement;
      if (buttonRef.current?.contains(target)
          || popoverRef.current?.contains(target)
          || elementTarget?.closest("[data-canvas-action-popover]") !== null) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus({ preventScroll: true });
    };
    updatePosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [enabled, open]);

  useEffect(() => {
    if (!open) {
      focusedForOpen.current = false;
      return;
    }
    if (position === null || focusedForOpen.current) return;
    focusedForOpen.current = true;
    const frame = window.requestAnimationFrame(() => popoverRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [open, position]);

  useEffect(() => {
    if (enabled || !open) return;
    fallbackFocusRef.current?.focus({ preventScroll: true });
    setOpen(false);
  }, [enabled, fallbackFocusRef, open]);

  return (
    <>
      <span aria-hidden={enabled ? undefined : true} style={{ display: enabled ? "contents" : "none" }}>
        <CanvasActionButton
          ariaLabel="More canvas actions"
          title="Show secondary canvas actions"
          icon={<MoreActionsIcon size={18} />}
          onClick={() => setOpen((current) => !current)}
          active={open}
          expanded={open}
          controls={popoverId}
          hasPopup="dialog"
          buttonRef={(element) => {
            buttonRef.current = element;
            if (triggerRef !== undefined) triggerRef.current = element;
          }}
        />
      </span>
      {enabled && open && position !== null && typeof document !== "undefined" ? createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label="More canvas actions"
          tabIndex={-1}
          data-canvas-action-popover
          className="mrd-scroll"
          style={{ ...POPOVER_STYLE, ...position }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {sections.map((section) => (
            <section key={section.label} role="group" aria-label={section.label} style={SECTION_STYLE}>
              <strong style={SECTION_LABEL_STYLE}>{section.label}</strong>
              <div style={ACTION_GRID_STYLE}>{section.children}</div>
            </section>
          ))}
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
  gap: 12,
  width: POPOVER_WIDTH,
  maxWidth: `calc(100vw - ${VIEWPORT_GAP * 2}px)`,
  overflowY: "auto",
  boxSizing: "border-box",
  padding: 12,
  transform: "translateX(-50%)",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 12,
  outline: "none",
  background: "rgba(10,13,18,0.98)",
  boxShadow: "0 14px 38px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.4)",
  backdropFilter: "blur(10px)",
};
const SECTION_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const SECTION_LABEL_STYLE: React.CSSProperties = {
  color: TOKENS.textMuted,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: "uppercase",
};
const ACTION_GRID_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 3 };
const POPOVER_OFFSET = 9;
const PREFERRED_POPOVER_HEIGHT = 520;
const MIN_POPOVER_HEIGHT = 160;
