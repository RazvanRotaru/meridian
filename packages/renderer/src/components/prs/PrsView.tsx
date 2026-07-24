import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  matchesPrSearchQuery,
  mergePrSearchResults,
  nextPrSearchResult,
  normalizePrSearchQuery,
} from "../../state/prSearch";
import { PRS_UNAVAILABLE_ERROR, type PrSummary, type PrsTab, type RelatedPrsState } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { PrCard } from "./PrCard";
import { PrDetailPanel } from "./PrDetailPanel";
import { PrsFilterBar } from "./PrsFilterBar";

export function PrsView() {
  const githubSource = useBlueprint((state) => state.githubSource);
  const tab = useBlueprint((state) => state.prsTab);
  const prs = useBlueprint((state) => state.prsList[state.prsTab]);
  const hasMore = useBlueprint((state) => state.prsHasMore[state.prsTab]);
  const loading = useBlueprint((state) => state.prsLoading);
  const error = useBlueprint((state) => state.prsError);
  const searchQuery = useBlueprint((state) => state.prSearchQuery);
  const searchResultNumbers = useBlueprint((state) => state.prSearchResults);
  const searchLoading = useBlueprint((state) => state.prSearchLoading);
  const searchError = useBlueprint((state) => state.prSearchError);
  const extraSummaries = useBlueprint((state) => state.prExtraSummaries);
  const selected = useBlueprint((state) => state.prSelected);
  const related = useBlueprint((state) => state.relatedPrs);
  const { setPrsTab, loadPrs, searchPrs, clearPrSearch, selectPr, clearRelatedPrs } = useBlueprintActions();

  // Query text and author remain view-local; remote result identity/cache lives in the store so a
  // late priority lookup can be stale-guarded independently from ordinary queue pagination.
  const [query, setQuery] = useState("");
  const [author, setAuthor] = useState("");
  const [activeResult, setActiveResult] = useState<number | null>(null);

  // Switching Open/Closed clears both filters — otherwise a stale author pick could silently
  // resurface and re-filter when the user returns to a tab where that author exists again.
  const switchTab = (state: PrsTab) => {
    setQuery("");
    setAuthor("");
    setActiveResult(null);
    setPrsTab(state);
  };

  const authors = useMemo(() => uniqueAuthors(prs), [prs]);
  // Deriving validity (instead of an effect) keeps the select consistent when the tab's authors
  // change: a stale pick that's no longer present silently falls back to "All authors".
  const activeAuthor = authors.includes(author) ? author : "";
  const localMatches = useMemo(() => filterPrs(prs, query, activeAuthor), [prs, query, activeAuthor]);
  const remoteMatches = useMemo(() => {
    if (normalizePrSearchQuery(query) === "" || normalizePrSearchQuery(query) !== searchQuery) {
      return [];
    }
    const summaries = searchResultNumbers
      .map((number) => extraSummaries[number])
      .filter((pr): pr is PrSummary => pr !== undefined);
    return filterPrs(summaries, query, activeAuthor);
  }, [activeAuthor, extraSummaries, query, searchQuery, searchResultNumbers]);
  const filtered = useMemo(
    () => mergePrSearchResults(localMatches, remoteMatches),
    [localMatches, remoteMatches],
  );
  const resultNumbers = useMemo(() => filtered.map((pr) => pr.number), [filtered]);
  const queueComplete = prs !== null && !hasMore;

  useEffect(() => {
    if (githubSource && prs === null && !loading && error === null) {
      void loadPrs(1);
    }
  }, [error, githubSource, loadPrs, loading, prs]);

  useEffect(() => {
    clearPrSearch();
    const trimmed = query.trim();
    if (related !== null || trimmed === "" || queueComplete) {
      return;
    }
    const timer = window.setTimeout(() => void searchPrs(trimmed), 250);
    return () => window.clearTimeout(timer);
  }, [clearPrSearch, query, queueComplete, related, searchPrs, tab]);

  useEffect(() => {
    if (activeResult !== null && !resultNumbers.includes(activeResult)) {
      setActiveResult(null);
    }
  }, [activeResult, resultNumbers]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setActiveResult(null);
  };

  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setActiveResult(null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") {
      return;
    }
    if (event.key === "Enter") {
      if (activeResult === null) {
        return;
      }
      event.preventDefault();
      void selectPr(activeResult);
      return;
    }
    event.preventDefault();
    const next = nextPrSearchResult(resultNumbers, activeResult, event.key === "ArrowDown" ? 1 : -1);
    setActiveResult(next);
    if (next !== null) {
      window.requestAnimationFrame(() => {
        document.getElementById(`pr-search-result-${next}`)?.scrollIntoView({ block: "nearest" });
      });
    }
  };

  if (!githubSource || (error === PRS_UNAVAILABLE_ERROR && prs === null && related === null)) {
    return (
      <div style={PAGE_STYLE}>
        <div style={CENTER_STYLE}>
          <div style={HINT_CARD_STYLE}>{"Pull requests need a GitHub-sourced session - run meridian web <owner/repo>"}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={PAGE_STYLE}>
      <section style={CONTENT_STYLE}>
        <header style={HEADER_STYLE}>
          <div>
            <h1 style={TITLE_STYLE}>Pull requests</h1>
            <div style={SUBTITLE_STYLE}>{tab === "open" ? "Open review queue" : "Closed pull requests"}</div>
          </div>
          <div style={SEGMENT_STYLE} role="group" aria-label="Pull request state">
            {(["open", "closed"] as const).map((state) => (
              <button
                key={state}
                type="button"
                style={tabButtonStyle(tab === state)}
                aria-pressed={tab === state}
                onClick={() => switchTab(state)}
              >
                {state === "open" ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        </header>
        {related !== null ? <RelatedFilterBanner related={related} onClear={clearRelatedPrs} /> : null}
        {related === null ? (
          <PrsFilterBar
            query={query}
            onQueryChange={onQueryChange}
            onQueryKeyDown={onQueryKeyDown}
            activeDescendant={activeResult !== null ? `pr-search-result-${activeResult}` : undefined}
            busy={searchLoading}
            status={prSearchStatus(query, filtered.length, searchLoading, searchError, prs, hasMore)}
            author={activeAuthor}
            onAuthorChange={(value) => {
              setAuthor(value);
              setActiveResult(null);
            }}
            authors={authors}
          />
        ) : null}
        <div style={BODY_STYLE}>
          <div style={LIST_STYLE} className="mrd-scroll">
            {related?.loading ? <SkeletonList /> : null}
            {related !== null && !related.loading && related.error === null && related.results.length === 0 ? (
              <div style={EMPTY_STYLE}>No open pull requests touch these files.</div>
            ) : null}
            {related !== null && !related.loading && related.error === null
              ? related.results.map((pr) => (
                  <PrCard key={pr.number} pr={pr} matchCount={pr.matchCount} active={selected === pr.number} onSelect={() => void selectPr(pr.number)} />
                ))
              : null}
            {related === null || related.error !== null ? (
              <>
                <div
                  id={related === null ? "pr-search-results" : undefined}
                  role={related === null ? "listbox" : undefined}
                  aria-label={related === null ? "Pull requests" : undefined}
                  aria-busy={related === null ? searchLoading : undefined}
                  style={RESULTS_STYLE}
                >
                  {prs === null && loading && filtered.length === 0 ? <SkeletonList /> : null}
                  {related === null && query.trim() !== "" && filtered.length === 0 && searchLoading ? (
                    <div style={EMPTY_STYLE}>Searching GitHub…</div>
                  ) : null}
                  {related === null && query.trim() !== "" && filtered.length === 0 && !searchLoading ? (
                    <div style={EMPTY_STYLE}>{noMatchMessage(query)}</div>
                  ) : null}
                  {related === null && query.trim() === "" && prs !== null && prs.length === 0 ? (
                    <div style={EMPTY_STYLE}>No {tab} pull requests.</div>
                  ) : null}
                  {(related?.error ? prs ?? [] : filtered).map((pr) => (
                    <PrCard
                      key={pr.number}
                      pr={pr}
                      active={selected === pr.number}
                      searchOption={related === null}
                      keyboardActive={related === null && activeResult === pr.number}
                      onPointerMove={related === null ? () => setActiveResult(pr.number) : undefined}
                      onSelect={() => {
                        setActiveResult(pr.number);
                        void selectPr(pr.number);
                      }}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {error && error !== PRS_UNAVAILABLE_ERROR ? <div style={ERROR_STYLE}>{error}</div> : null}
            {prs !== null && hasMore && (related === null || related.error !== null) ? (
              <button type="button" style={LOAD_MORE_STYLE} disabled={loading} onClick={() => void loadPrs()}>
                {loading ? "Loading..." : "Load more"}
              </button>
            ) : null}
          </div>
          <PrDetailPanel />
        </div>
      </section>
    </div>
  );
}

function RelatedFilterBanner(props: {
  related: RelatedPrsState;
  onClear: () => void;
}) {
  const { related } = props;
  return (
    <div style={RELATED_BANNER_STYLE}>
      <div style={RELATED_BANNER_TOP_STYLE}>
        <strong>PRs touching {related.paths.length} files from your view</strong>
        <span style={RELATED_COUNT_STYLE}>{related.scanned} scanned</span>
        {related.hasMore ? <span style={RELATED_MORE_STYLE}>+ more open PRs not scanned</span> : null}
        <button type="button" style={RELATED_CLEAR_STYLE} title="Clear related PR filter" aria-label="Clear related PR filter" onClick={props.onClear}>✕</button>
      </div>
      {related.error ? <div style={RELATED_ERROR_STYLE}>{related.error}</div> : null}
    </div>
  );
}

function SkeletonList() {
  return (
    <>
      {[0, 1, 2].map((key) => (
        <div key={key} style={SKELETON_STYLE} />
      ))}
    </>
  );
}

// The tab's authors, unique and alphabetical, for the filter dropdown. Empty until the list loads.
function uniqueAuthors(prs: PrSummary[] | null): string[] {
  if (prs === null) {
    return [];
  }
  return [...new Set(prs.map((pr) => pr.author))].sort((a, b) => a.localeCompare(b));
}

// AND-compose the shared arbitrary-text vocabulary with the exact author menu.
function filterPrs(prs: PrSummary[] | null, query: string, author: string): PrSummary[] {
  if (prs === null) {
    return [];
  }
  return prs.filter((pr) => matchesPrSearchQuery(pr, query) && (author === "" || pr.author === author));
}

function noMatchMessage(query: string): string {
  const trimmed = query.trim();
  return trimmed ? `No PRs match "${trimmed}"` : "No PRs match the current filters.";
}

function prSearchStatus(
  query: string,
  count: number,
  loading: boolean,
  error: string | null,
  prs: PrSummary[] | null,
  queueHasMore: boolean,
): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    if (prs === null) return "Loading pull requests…";
    const suffix = queueHasMore ? " · more available" : "";
    return `${prs.length} ${prs.length === 1 ? "pull request" : "pull requests"} loaded${suffix}`;
  }
  const matches = `${count} ${count === 1 ? "match" : "matches"}`;
  if (loading) return `${matches} · searching GitHub…`;
  if (error) return `${matches} · GitHub search unavailable: ${error}`;
  return matches;
}

const PAGE_STYLE: React.CSSProperties = { width: "100%", height: "100%", background: "#080B10", color: "#E6EDF3" };
const CONTENT_STYLE: React.CSSProperties = { height: "100%", padding: "28px 28px 28px 340px", boxSizing: "border-box", display: "flex", flexDirection: "column" };
const CENTER_STYLE: React.CSSProperties = { height: "100%", display: "grid", placeItems: "center", paddingLeft: 300 };
const HINT_CARD_STYLE: React.CSSProperties = { maxWidth: 440, border: "1px solid #2A2F37", borderRadius: 8, padding: 18, background: "#0E1116", color: "#C9D1D9", fontSize: 14 };
const HEADER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 };
const TITLE_STYLE: React.CSSProperties = { margin: 0, fontSize: 22, lineHeight: "28px", color: "#F0F6FC" };
const SUBTITLE_STYLE: React.CSSProperties = { marginTop: 4, fontSize: 13, color: "#8B949E" };
const SEGMENT_STYLE: React.CSSProperties = { display: "flex", gap: 2, padding: 2, border: "1px solid #2A2F37", borderRadius: 8, background: "#0E1116" };
const BODY_STYLE: React.CSSProperties = { minHeight: 0, flex: 1, display: "grid", gridTemplateColumns: "minmax(320px, 0.95fr) minmax(360px, 1.05fr)", gap: 18 };
const LIST_STYLE: React.CSSProperties = { minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 };
const RESULTS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };
const EMPTY_STYLE: React.CSSProperties = { border: "1px dashed #2A2F37", borderRadius: 8, padding: 18, color: "#8B949E", background: "#0E1116" };
const ERROR_STYLE: React.CSSProperties = { border: "1px solid #7F1D1D", borderRadius: 8, padding: 12, color: "#FCA5A5", background: "#1A0E12" };
const LOAD_MORE_STYLE: React.CSSProperties = { border: "1px solid #2A2F37", borderRadius: 8, background: "#161B22", color: "#E6EDF3", padding: "10px 12px", cursor: "pointer" };
const SKELETON_STYLE: React.CSSProperties = { height: 108, borderRadius: 8, border: "1px solid #1F2530", background: "#11161D" };
const RELATED_BANNER_STYLE: React.CSSProperties = { border: "1px solid #92400E", borderRadius: 8, padding: "10px 12px", marginBottom: 12, color: "#FDE68A", background: "#1C1409", fontSize: 12 };
const RELATED_BANNER_TOP_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 };
const RELATED_COUNT_STYLE: React.CSSProperties = { color: "#8B949E" };
const RELATED_MORE_STYLE: React.CSSProperties = { color: "#C9A45D" };
const RELATED_CLEAR_STYLE: React.CSSProperties = { marginLeft: "auto", border: "none", background: "transparent", color: "#FDE68A", cursor: "pointer", font: "inherit", padding: 2 };
const RELATED_ERROR_STYLE: React.CSSProperties = { marginTop: 7, color: "#FCA5A5" };

function tabButtonStyle(active: boolean): React.CSSProperties {
  return { border: "none", borderRadius: 6, padding: "6px 12px", background: active ? "#1F2530" : "transparent", color: active ? "#E6EDF3" : "#8B949E", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: active ? 700 : 500 };
}
