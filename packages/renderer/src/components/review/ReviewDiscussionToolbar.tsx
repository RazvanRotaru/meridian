import { ChatBubbleIcon, ChevronDownIcon, Cross1Icon, EyeClosedIcon, EyeOpenIcon } from "@radix-ui/react-icons";
import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_REVIEW_COMMENT_FILTER,
  filterReviewComments,
  reviewCommentAuthors,
} from "../../derive/reviewCommentFilter";
import { reviewDraftIsVisible, reviewPathIsVisible } from "../../derive/reviewSubmit";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type {
  PrGitHubComment,
  ReviewCommentFilter,
  ReviewCommentFilterMode,
  ReviewCommentFilterSubject,
} from "../../state/prTypes";
import { NO_FOCUS_RING } from "./reviewPanelKit";

const NO_EXISTING_COMMENTS: readonly PrGitHubComment[] = [];
const ALL_SUBJECT_VALUE = "all";
const VIEWER_SUBJECT_VALUE = "viewer";
const AUTHOR_SUBJECT_PREFIX = "author:";

/** A compact discussion control above Files changed. One popover contains the two independent
 * dimensions: whose comments to focus and whether to show only their prose or full threads they
 * joined. Pending drafts remain a separate, always-visible queue. */
export function ReviewDiscussionToolbar() {
  const dialogId = useId();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const personSelectId = useId();
  const modeGroupName = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const personSelectRef = useRef<HTMLSelectElement | null>(null);
  const [open, setOpen] = useState(false);
  const [triggerFocusVisible, setTriggerFocusVisible] = useState(false);
  const filter = useBlueprint((state) => state.reviewCommentFilter ?? DEFAULT_REVIEW_COMMENT_FILTER);
  const commentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const comments = useBlueprint((state) => state.prDiscussion?.comments ?? NO_EXISTING_COMMENTS);
  const pendingDrafts = useBlueprint((state) => state.reviewComments);
  const reviewContext = useBlueprint((state) => state.review?.context ?? null);
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const { setReviewCommentFilter, toggleReviewCommentsVisible } = useBlueprintActions();

  const visibleExistingCount = (candidate: readonly PrGitHubComment[]) => reviewContext === null
    ? candidate.length
    : candidate.filter((comment) => reviewPathIsVisible(comment.path, reviewFiles, reviewContext)).length;
  // Participation is derived from the complete loaded discussion before the visible file
  // projection is applied. This keeps the toolbar aligned with source, rail, and graph consumers.
  const totalExisting = visibleExistingCount(comments);
  const filteredExisting = visibleExistingCount(filterReviewComments(comments, filter));
  const authoredExisting = visibleExistingCount(filterReviewComments(comments, {
    subject: filter.subject,
    mode: "authored",
  }));
  const participatedExisting = visibleExistingCount(filterReviewComments(comments, {
    subject: filter.subject,
    mode: "participated",
  }));
  const pending = reviewContext === null
    ? pendingDrafts.length
    : pendingDrafts.filter((comment) => reviewDraftIsVisible(comment, reviewFiles, reviewContext)).length;
  const authors = reviewCommentAuthors(comments);
  const selectedSubjectValue = subjectSelectValue(filter.subject);
  const selectedAuthorLogin = filter.subject.kind === "author" ? filter.subject.login : null;
  const selectedExplicitAuthorPresent = selectedAuthorLogin === null
    || authors.some((author) => normalizeLogin(author.login) === normalizeLogin(selectedAuthorLogin));

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => personSelectRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", closeFromEscape, true);
    return () => document.removeEventListener("keydown", closeFromEscape, true);
  }, [open]);

  if (totalExisting === 0 && pending === 0) return null;

  const pendingLabel = pending === 0
    ? "No pending comments"
    : `${pending} pending ${pending === 1 ? "comment" : "comments"}`;
  const existingLabel = `${totalExisting} existing ${totalExisting === 1 ? "comment" : "comments"}`;
  const activeLabel = reviewCommentFilterLabel(filter);
  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const selectSubject = (value: string) => {
    setReviewCommentFilter({ ...filter, subject: subjectFromSelectValue(value) });
  };
  const selectMode = (mode: ReviewCommentFilterMode) => {
    setReviewCommentFilter({ ...filter, mode });
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
        <div ref={wrapRef} style={FILTER_WRAP}>
          <button
            ref={triggerRef}
            type="button"
            style={triggerFocusVisible ? TRIGGER_FOCUS_VISIBLE : TRIGGER}
            aria-label={`Comment focus: ${activeLabel}, showing ${filteredExisting} of ${totalExisting} comments`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={dialogId}
            onClick={() => setOpen((value) => !value)}
            onFocus={(event) => setTriggerFocusVisible(event.currentTarget.matches(":focus-visible"))}
            onBlur={() => setTriggerFocusVisible(false)}
          >
            <span style={FILTER_SUMMARY}>{activeLabel} · {filteredExisting} of {totalExisting}</span>
            <ChevronDownIcon width={15} height={15} aria-hidden="true" />
          </button>
          {open ? (
            <div
              id={dialogId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={dialogTitleId}
              aria-describedby={dialogDescriptionId}
              style={DIALOG}
            >
              <div style={DIALOG_HEADER}>
                <span id={dialogTitleId} style={DIALOG_TITLE}>Comment filters</span>
                <button
                  type="button"
                  style={CLOSE_BUTTON}
                  aria-label="Close comment filters"
                  onClick={closeAndRestoreFocus}
                >
                  <Cross1Icon width={13} height={13} aria-hidden="true" />
                </button>
              </div>

              <label htmlFor={personSelectId} style={FIELD_LABEL}>Person</label>
              <select
                ref={personSelectRef}
                id={personSelectId}
                style={SELECT}
                value={selectedSubjectValue}
                onChange={(event) => selectSubject(event.currentTarget.value)}
              >
                <option value={ALL_SUBJECT_VALUE}>All users</option>
                <option value={VIEWER_SUBJECT_VALUE}>Me</option>
                {authors.filter((author) => !author.isViewer).map((author) => (
                  <option key={normalizeLogin(author.login)} value={authorSelectValue(author.login)}>
                    @{author.login}
                  </option>
                ))}
                {!selectedExplicitAuthorPresent && filter.subject.kind === "author" ? (
                  <option value={selectedSubjectValue}>@{filter.subject.login} (no comments)</option>
                ) : null}
              </select>

              <fieldset style={MODE_FIELDSET} disabled={filter.subject.kind === "all"}>
                <legend style={FIELD_LABEL}>Show</legend>
                <label style={modeOptionStyle(filter.mode === "authored")}>
                  <input
                    type="radio"
                    name={modeGroupName}
                    value="authored"
                    checked={filter.mode === "authored"}
                    onChange={() => selectMode("authored")}
                  />
                  <span style={MODE_COPY}>
                    <span>Comments authored</span>
                    <span style={MODE_COUNT}>{authoredExisting}</span>
                  </span>
                </label>
                <label style={modeOptionStyle(filter.mode === "participated")}>
                  <input
                    type="radio"
                    name={modeGroupName}
                    value="participated"
                    checked={filter.mode === "participated"}
                    onChange={() => selectMode("participated")}
                  />
                  <span style={MODE_COPY}>
                    <span>Participated threads</span>
                    <span style={MODE_COUNT}>
                      {participatedExisting} {participatedExisting === 1 ? "comment" : "comments"}
                    </span>
                  </span>
                </label>
              </fieldset>

              <span id={dialogDescriptionId} style={HELP}>
                Participated includes the complete thread. Pending drafts are always shown.
              </span>
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

export function reviewCommentFilterLabel(filter: ReviewCommentFilter): string {
  if (filter.subject.kind === "all") return "All comments";
  const person = filter.subject.kind === "viewer" ? "Me" : `@${filter.subject.login}`;
  return `${person} · ${filter.mode === "authored" ? "Comments" : "Threads"}`;
}

function subjectSelectValue(subject: ReviewCommentFilterSubject): string {
  if (subject.kind === "all") return ALL_SUBJECT_VALUE;
  return subject.kind === "viewer" ? VIEWER_SUBJECT_VALUE : authorSelectValue(subject.login);
}

function subjectFromSelectValue(value: string): ReviewCommentFilterSubject {
  if (value === ALL_SUBJECT_VALUE) return { kind: "all" };
  if (value === VIEWER_SUBJECT_VALUE) return { kind: "viewer" };
  return { kind: "author", login: value.slice(AUTHOR_SUBJECT_PREFIX.length) };
}

function authorSelectValue(login: string): string {
  return `${AUTHOR_SUBJECT_PREFIX}${normalizeLogin(login)}`;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function modeOptionStyle(selected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 32,
    padding: "0 8px",
    borderRadius: 6,
    background: selected ? "#222B38" : "transparent",
    color: selected ? "#E6EDF3" : "#B0BAC6",
    cursor: "pointer",
  };
}

const TOOLBAR: React.CSSProperties = { position: "relative", zIndex: 4, display: "flex", alignItems: "center", gap: 8, minHeight: 42, margin: "0 6px 5px", padding: "0 2px 5px", borderBottom: "1px solid #222936" };
const TITLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "#C9D1D9", fontSize: 11.5, fontWeight: 650, whiteSpace: "nowrap" };
const PENDING_CHIP: React.CSSProperties = { border: "1px solid rgba(210,153,34,0.55)", borderRadius: 6, background: "rgba(210,153,34,0.11)", color: "#E3B341", padding: "3px 7px", fontSize: 10.5, fontWeight: 650, whiteSpace: "nowrap" };
const FILTER_WRAP: React.CSSProperties = { position: "static", minWidth: 0, maxWidth: 210, flex: "0 1 210px" };
const TRIGGER: React.CSSProperties = { width: "100%", minWidth: 0, maxWidth: 210, minHeight: 29, boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8, border: "1px solid #303844", borderRadius: 6, background: "#111820", color: "#C9D1D9", padding: "0 8px 0 10px", font: "inherit", fontSize: 10.5, cursor: "pointer", whiteSpace: "nowrap", ...NO_FOCUS_RING };
const TRIGGER_FOCUS_VISIBLE: React.CSSProperties = { ...TRIGGER, borderColor: "#58A6FF", boxShadow: "0 0 0 2px rgba(56,139,253,0.28)" };
const FILTER_SUMMARY: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const DIALOG: React.CSSProperties = { position: "absolute", top: "calc(100% + 5px)", left: 0, right: 0, zIndex: 50, width: "auto", maxWidth: 276, boxSizing: "border-box", marginLeft: "auto", padding: 10, border: "1px solid #354052", borderRadius: 8, background: "#151B23", boxShadow: "0 14px 32px rgba(0,0,0,0.48)", color: "#C9D1D9" };
const DIALOG_HEADER: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 25, marginBottom: 8 };
const DIALOG_TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
const CLOSE_BUTTON: React.CSSProperties = { width: 25, height: 25, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 5, background: "transparent", color: "#8B949E", cursor: "pointer" };
const FIELD_LABEL: React.CSSProperties = { display: "block", margin: "0 0 5px", color: "#8B949E", fontSize: 10.5, fontWeight: 650 };
const SELECT: React.CSSProperties = { width: "100%", minHeight: 32, boxSizing: "border-box", marginBottom: 10, padding: "0 8px", border: "1px solid #354052", borderRadius: 6, background: "#10151C", color: "#E6EDF3", font: "inherit", fontSize: 11.5, cursor: "pointer" };
const MODE_FIELDSET: React.CSSProperties = { display: "grid", gap: 3, minWidth: 0, margin: 0, padding: 0, border: 0 };
const MODE_COPY: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", fontSize: 11.5 };
const MODE_COUNT: React.CSSProperties = { color: "#7B8695", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5, fontVariantNumeric: "tabular-nums" };
const HELP: React.CSSProperties = { display: "block", marginTop: 9, color: "#7B8695", fontSize: 10.5, lineHeight: 1.4 };
const VISIBILITY: React.CSSProperties = { width: 29, height: 29, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid #303844", borderRadius: 6, background: "transparent", color: "#7B8695", cursor: "pointer", ...NO_FOCUS_RING };
const VISIBILITY_ACTIVE: React.CSSProperties = { ...VISIBILITY, borderColor: "rgba(125,211,252,0.42)", background: "rgba(56,139,253,0.10)", color: "#7DD3FC" };
