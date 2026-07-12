/**
 * The zoom-trail breadcrumb, shared by the module-family surfaces. Two gestures per segment:
 *   - clicking the segment TEXT jumps back to that level (zoom out), and
 *   - clicking the `›` icon (Map only) opens a dropdown of the cards ON SCREEN at that level — the
 *     nodes you can go into — so you descend from the end or re-route sideways from a middle segment.
 * The dropdown appears only when `childrenOf` is supplied (the folder Map); the Service/UI lenses
 * pass none and the trail renders as plain text segments with `›` separators. The menu lists exactly
 * what the graph draws (via `childrenOf`), filterable by typing, current-path child marked, and
 * dismisses on click-outside / Esc. Picking a child navigates through the same `onFocus` a card
 * double-click uses.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Crumb } from "./canvas/surfaceSpec";
import type { NavChild } from "../derive/breadcrumbNav";
import { ChevronRightIcon } from "./controlpanel/icons";

interface Level {
  focus: string | null;
  label: string;
  canDescend: boolean;
}

export function LevelBreadcrumb(props: {
  focus: string | null;
  packageCount: number;
  crumbs: Crumb[];
  onFocus: (id: string | null) => void;
  rootLabel?: string;
  rootNoun?: string;
  /** When supplied, each descendable segment gains a `›` dropdown of its on-screen cards. Omitted on
   * lenses whose "level children" aren't the folder frontier (Service/UI) — those stay text-only. */
  childrenOf?: (focus: string | null) => NavChild[];
}) {
  const { focus, packageCount, crumbs, onFocus, childrenOf } = props;
  const rootLabel = props.rootLabel ?? "Repository";
  const rootNoun = props.rootNoun ?? "packages";
  const hasDropdown = childrenOf !== undefined;

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  const levels = useMemo<Level[]>(
    () => [
      { focus: null, label: rootLabel, canDescend: hasDropdown },
      ...crumbs.map((crumb) => ({ focus: crumb.id, label: crumb.label, canDescend: hasDropdown && crumb.kind === "package" })),
    ],
    [crumbs, rootLabel, hasDropdown],
  );
  const currentIndex = levels.length - 1;

  // Computed once per open — the frontier can be heavy on a big repo, so typing only filters it.
  const items = useMemo(() => (openIndex === null ? [] : childrenOf?.(levels[openIndex].focus) ?? []), [openIndex, levels, childrenOf]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
  }, [items, filter]);
  const currentChildId = openIndex === null ? null : levels[openIndex + 1]?.focus ?? null;

  const close = () => {
    setOpenIndex(null);
    setFilter("");
    setActive(0);
  };
  const openMenu = (index: number) => {
    if (openIndex === index) {
      close();
      return;
    }
    setOpenIndex(index);
    setFilter("");
    setActive(0);
  };
  const pick = (child: NavChild) => {
    close();
    onFocus(child.id);
  };

  useEffect(close, [focus]);
  useEffect(() => {
    if (openIndex === null) {
      return;
    }
    // Capture phase + pointerdown: React Flow's pane swallows bubbling mouse events (it can even
    // suppress the compatibility mousedown), so a bubble-phase listener never sees a canvas click.
    const onDown = (event: Event) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [openIndex]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filtered[active]) {
        pick(filtered[active]);
      }
    }
  };

  return (
    <nav ref={navRef} style={NAV_STYLE} aria-label="Containment level">
      {levels.map((level, i) => {
        const isCurrent = i === currentIndex;
        const label = level.focus === null && isCurrent ? `${rootLabel} — ${packageCount} ${rootNoun}` : level.label;
        return (
          <span key={level.focus ?? "__root__"} style={SEG_WRAP}>
            {isCurrent ? (
              <span style={CURRENT_STYLE} aria-current="page" title={level.focus ?? undefined}>{label}</span>
            ) : (
              <button type="button" style={SEG_STYLE} title={level.focus ?? undefined} onClick={() => onFocus(level.focus)}>{label}</button>
            )}
            {level.canDescend ? (
              <button
                type="button"
                style={chevronStyle(openIndex === i || hovered === i)}
                aria-label={`Go into ${level.label}`}
                aria-expanded={openIndex === i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((current) => (current === i ? null : current))}
                onClick={() => openMenu(i)}
              >
                <ChevronRightIcon size={15} />
              </button>
            ) : i < currentIndex ? (
              <span style={SEP_STYLE} aria-hidden>›</span>
            ) : null}
            {openIndex === i ? (
              <div style={MENU_STYLE}>
                <input
                  autoFocus
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="Go to…"
                  spellCheck={false}
                  style={FILTER_STYLE}
                />
                <ul className="mrd-scroll" style={LIST_STYLE}>
                  {filtered.length === 0 ? (
                    <li style={EMPTY_ITEM_STYLE}>Nothing to go into</li>
                  ) : (
                    filtered.map((child, index) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          style={itemStyle(index === active, child.id === currentChildId)}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => pick(child)}
                          title={child.id}
                        >
                          {child.label}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}

const NAV_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 340,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 2,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "3px 6px",
  maxWidth: "60vw",
};
const SEG_WRAP: React.CSSProperties = { position: "relative", display: "inline-flex", alignItems: "center", gap: 1, minWidth: 0 };
const SEG_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "#9AA4B2",
};
const CURRENT_STYLE: React.CSSProperties = { ...SEG_STYLE, color: "#E6EDF3", fontWeight: 600, cursor: "default" };
const SEP_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 13, padding: "0 2px" };
/** A bare icon button — no box: only the chevron itself brightens on hover / while open. */
function chevronStyle(lit: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: lit ? "#E6EDF3" : "#5B6472",
  };
}
const MENU_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 20,
  width: 200,
  padding: 4,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.98)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
};
const FILTER_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A2F37",
  outline: "none",
  background: "#0E1116",
  color: "#E6EDF3",
  font: "inherit",
  fontSize: 12,
  borderRadius: 6,
  padding: "4px 7px",
  marginBottom: 4,
};
const LIST_STYLE: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, maxHeight: 240, overflowY: "auto" };
const EMPTY_ITEM_STYLE: React.CSSProperties = { padding: "6px 8px", fontSize: 12, color: "#6B7480" };
function itemStyle(active: boolean, isCurrent: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "4px 8px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    font: "inherit",
    fontSize: 12.5,
    fontWeight: isCurrent ? 600 : 400,
    color: active || isCurrent ? "#E6EDF3" : "#9AA4B2",
    background: active ? "rgba(91,155,227,0.16)" : "transparent",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}
