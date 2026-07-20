import { ChatBubbleIcon, CheckIcon, ChevronDownIcon, EyeClosedIcon, EyeOpenIcon } from "@radix-ui/react-icons";
import { useEffect, useId, useRef, useState } from "react";
import { filterReviewComments } from "../../derive/reviewCommentFilter";
import { isReviewTestPath } from "../../derive/reviewFiles";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { ReviewCommentFilter } from "../../state/prTypes";
import { NO_FOCUS_RING } from "./reviewPanelKit";

const FILTER_OPTIONS: readonly { value: ReviewCommentFilter; label: string }[] = [
  { value: "all", label: "All comments" },
  { value: "mine", label: "Mine" },
  { value: "participated", label: "Participated" },
];

/** A compact discussion control above Files changed. It deliberately mirrors the command
 * palette's scope dropdown: one trigger, checked menu rows, right-aligned counts, and full
 * keyboard/outside-click behavior. Pending drafts remain a separate, always-visible queue. */
export function ReviewDiscussionToolbar() {
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const filter = useBlueprint((state) => state.reviewCommentFilter ?? "all");
  const commentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const totalExisting = useBlueprint((state) => {
    const comments = state.prDiscussion?.comments ?? [];
    return state.showTests
      ? comments.length
      : comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)).length;
  });
  const filteredExisting = useBlueprint((state) => {
    const comments = state.showTests
      ? state.prDiscussion?.comments ?? []
      : state.prDiscussion?.comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)) ?? [];
    return filterReviewComments(comments, state.reviewCommentFilter).length;
  });
  const pending = useBlueprint((state) => {
    return state.showTests
      ? state.reviewComments.length
      : state.reviewComments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)).length;
  });
  const allCount = useBlueprint((state) => {
    const comments = state.showTests
      ? state.prDiscussion?.comments ?? []
      : state.prDiscussion?.comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)) ?? [];
    return filterReviewComments(comments, "all").length;
  });
  const mineCount = useBlueprint((state) => {
    const comments = state.showTests
      ? state.prDiscussion?.comments ?? []
      : state.prDiscussion?.comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)) ?? [];
    return filterReviewComments(comments, "mine").length;
  });
  const participatedCount = useBlueprint((state) => {
    const comments = state.showTests
      ? state.prDiscussion?.comments ?? []
      : state.prDiscussion?.comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)) ?? [];
    return filterReviewComments(comments, "participated").length;
  });
  const { setReviewCommentFilter, toggleReviewCommentsVisible } = useBlueprintActions();
  const selectedIndex = Math.max(0, FILTER_OPTIONS.findIndex((option) => option.value === filter));
  const counts = [allCount, mineCount, participatedCount];
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [open]);

  if (totalExisting === 0 && pending === 0) return null;

  const pendingLabel = pending === 0
    ? "No pending comments"
    : `${pending} pending ${pending === 1 ? "comment" : "comments"}`;
  const existingLabel = `${totalExisting} existing ${totalExisting === 1 ? "comment" : "comments"}`;
  const activeLabel = FILTER_OPTIONS[selectedIndex]?.label ?? "All comments";
  const focusOption = (index: number) => {
    const next = (index + FILTER_OPTIONS.length) % FILTER_OPTIONS.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };
  const selectFilter = (next: ReviewCommentFilter) => {
    setReviewCommentFilter(next);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div style={TOOLBAR} aria-label={`Discussion: ${pendingLabel}; ${existingLabel}`}>
      <div style={TITLE}>
        <ChatBubbleIcon width={15} height={15} aria-hidden="true" />
        <span>Discussion</span>
      </div>
      {pending > 0 ? <span style={PENDING_CHIP}>{pending} pending</span> : null}
      <span style={{ flex: 1 }} />
      {totalExisting > 0 ? (
        <div ref={wrapRef} style={MENU_WRAP}>
          <button
            ref={triggerRef}
            type="button"
            style={TRIGGER}
            aria-label={`Comment focus: ${activeLabel}, ${filteredExisting} of ${totalExisting}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
          >
            <span>{activeLabel} · {filteredExisting} of {totalExisting}</span>
            <ChevronDownIcon width={15} height={15} aria-hidden="true" />
          </button>
          {open ? (
            <div id={menuId} role="menu" aria-label="Comment focus" style={MENU}>
              {FILTER_OPTIONS.map((option, index) => {
                const selected = option.value === filter;
                return (
                  <button
                    key={option.value}
                    ref={(node) => { optionRefs.current[index] = node; }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    tabIndex={activeIndex === index ? 0 : -1}
                    style={menuItemStyle(activeIndex === index, selected)}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => selectFilter(option.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusOption(activeIndex + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        focusOption(activeIndex - 1);
                      } else if (event.key === "Home") {
                        event.preventDefault();
                        focusOption(0);
                      } else if (event.key === "End") {
                        event.preventDefault();
                        focusOption(FILTER_OPTIONS.length - 1);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setOpen(false);
                        requestAnimationFrame(() => triggerRef.current?.focus());
                      } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectFilter(option.value);
                      }
                    }}
                  >
                    <span style={CHECK}>{selected ? <CheckIcon width={14} height={14} aria-hidden="true" /> : null}</span>
                    <span style={OPTION_LABEL}>{option.label}</span>
                    <span style={COUNT}>{counts[index] ?? 0}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {totalExisting > 0 ? (
        <button
          type="button"
          style={commentsVisible ? VISIBILITY_ACTIVE : VISIBILITY}
          aria-label={commentsVisible ? "Hide comments on canvas" : "Show comments on canvas"}
          aria-pressed={commentsVisible}
          title={commentsVisible ? "Hide comments on canvas" : "Show comments on canvas"}
          onClick={toggleReviewCommentsVisible}
        >
          {commentsVisible ? <EyeOpenIcon width={15} height={15} aria-hidden="true" /> : <EyeClosedIcon width={15} height={15} aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  );
}

function menuItemStyle(active: boolean, selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 34,
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "0 9px",
    border: "none",
    borderRadius: 6,
    background: active || selected ? "#222B38" : "transparent",
    color: selected || active ? "#E6EDF3" : "#B0BAC6",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
    ...NO_FOCUS_RING,
  };
}

const TOOLBAR: React.CSSProperties = { position: "relative", zIndex: 4, display: "flex", alignItems: "center", gap: 8, minHeight: 42, margin: "0 6px 5px", padding: "0 2px 5px", borderBottom: "1px solid #222936" };
const TITLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "#C9D1D9", fontSize: 11.5, fontWeight: 650, whiteSpace: "nowrap" };
const PENDING_CHIP: React.CSSProperties = { border: "1px solid rgba(210,153,34,0.55)", borderRadius: 6, background: "rgba(210,153,34,0.11)", color: "#E3B341", padding: "3px 7px", fontSize: 10.5, fontWeight: 650, whiteSpace: "nowrap" };
const MENU_WRAP: React.CSSProperties = { position: "relative", flexShrink: 0 };
const TRIGGER: React.CSSProperties = { minHeight: 29, display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8, border: "1px solid #303844", borderRadius: 6, background: "#111820", color: "#C9D1D9", padding: "0 8px 0 10px", font: "inherit", fontSize: 10.5, cursor: "pointer", whiteSpace: "nowrap", ...NO_FOCUS_RING };
const MENU: React.CSSProperties = { position: "absolute", top: "calc(100% + 5px)", right: 0, zIndex: 50, width: 190, padding: 5, border: "1px solid #354052", borderRadius: 8, background: "#151B23", boxShadow: "0 14px 32px rgba(0,0,0,0.48)" };
const CHECK: React.CSSProperties = { width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#7DD3FC", flexShrink: 0 };
const OPTION_LABEL: React.CSSProperties = { flex: 1, textAlign: "left" };
const COUNT: React.CSSProperties = { color: "#7B8695", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5, fontVariantNumeric: "tabular-nums" };
const VISIBILITY: React.CSSProperties = { width: 29, height: 29, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid #303844", borderRadius: 6, background: "transparent", color: "#7B8695", cursor: "pointer", ...NO_FOCUS_RING };
const VISIBILITY_ACTIVE: React.CSSProperties = { ...VISIBILITY, borderColor: "rgba(125,211,252,0.42)", background: "rgba(56,139,253,0.10)", color: "#7DD3FC" };
