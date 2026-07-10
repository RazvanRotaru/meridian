import { useEffect } from "react";
import { PRS_UNAVAILABLE_ERROR, type PrSummary, type PrsTab } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { PrDetailPanel } from "./PrDetailPanel";

export function PrsView() {
  const tab = useBlueprint((state) => state.prsTab);
  const prs = useBlueprint((state) => state.prsList[state.prsTab]);
  const hasMore = useBlueprint((state) => state.prsHasMore[state.prsTab]);
  const loading = useBlueprint((state) => state.prsLoading);
  const error = useBlueprint((state) => state.prsError);
  const selected = useBlueprint((state) => state.prSelected);
  const { setPrsTab, loadPrs, selectPr } = useBlueprintActions();

  useEffect(() => {
    if (prs === null && !loading && error === null) {
      void loadPrs(1);
    }
  }, [error, loadPrs, loading, prs]);

  if (error === PRS_UNAVAILABLE_ERROR && prs === null) {
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
                onClick={() => setPrsTab(state)}
              >
                {state === "open" ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        </header>
        <div style={BODY_STYLE}>
          <div style={LIST_STYLE} className="mrd-scroll">
            {prs === null && loading ? <SkeletonList /> : null}
            {prs !== null && prs.length === 0 ? <div style={EMPTY_STYLE}>No {tab} pull requests.</div> : null}
            {prs?.map((pr) => (
              <PrCard key={pr.number} pr={pr} active={selected === pr.number} onSelect={() => void selectPr(pr.number)} />
            ))}
            {error && error !== PRS_UNAVAILABLE_ERROR ? <div style={ERROR_STYLE}>{error}</div> : null}
            {prs !== null && hasMore ? (
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

function PrCard(props: { pr: PrSummary; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" style={cardStyle(props.active)} onClick={props.onSelect}>
      <div style={CARD_TOP_STYLE}>
        <span style={NUMBER_STYLE}>#{props.pr.number}</span>
        <span style={dotStyle(props.pr.state)} />
        {props.pr.draft ? <span style={DRAFT_STYLE}>Draft</span> : null}
      </div>
      <div style={CARD_TITLE_STYLE}>{props.pr.title}</div>
      <div style={META_STYLE}>
        <span>{props.pr.author}</span>
        <span>{props.pr.headRef}</span>
        <span>{relativeUpdatedAt(props.pr.updatedAt)}</span>
      </div>
    </button>
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

function relativeUpdatedAt(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return "Updated recently";
  }
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "Updated now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

const PAGE_STYLE: React.CSSProperties = { width: "100%", height: "100%", background: "#080B10", color: "#E6EDF3" };
const CONTENT_STYLE: React.CSSProperties = { height: "100%", padding: "28px 28px 28px 340px", boxSizing: "border-box" };
const CENTER_STYLE: React.CSSProperties = { height: "100%", display: "grid", placeItems: "center", paddingLeft: 300 };
const HINT_CARD_STYLE: React.CSSProperties = { maxWidth: 440, border: "1px solid #2A2F37", borderRadius: 8, padding: 18, background: "#0E1116", color: "#C9D1D9", fontSize: 14 };
const HEADER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 };
const TITLE_STYLE: React.CSSProperties = { margin: 0, fontSize: 22, lineHeight: "28px", color: "#F0F6FC" };
const SUBTITLE_STYLE: React.CSSProperties = { marginTop: 4, fontSize: 13, color: "#8B949E" };
const SEGMENT_STYLE: React.CSSProperties = { display: "flex", gap: 2, padding: 2, border: "1px solid #2A2F37", borderRadius: 8, background: "#0E1116" };
const BODY_STYLE: React.CSSProperties = { minHeight: 0, height: "calc(100% - 56px)", display: "grid", gridTemplateColumns: "minmax(320px, 0.95fr) minmax(360px, 1.05fr)", gap: 18 };
const LIST_STYLE: React.CSSProperties = { minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 };
const CARD_TOP_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const NUMBER_STYLE: React.CSSProperties = { color: "#7DD3FC", fontSize: 12, fontWeight: 700 };
const DRAFT_STYLE: React.CSSProperties = { color: "#C084FC", border: "1px solid #6B21A8", borderRadius: 999, padding: "1px 7px", fontSize: 11 };
const CARD_TITLE_STYLE: React.CSSProperties = { marginTop: 8, color: "#F0F6FC", fontSize: 14, lineHeight: "19px", fontWeight: 650 };
const META_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10, color: "#8B949E", fontSize: 12 };
const EMPTY_STYLE: React.CSSProperties = { border: "1px dashed #2A2F37", borderRadius: 8, padding: 18, color: "#8B949E", background: "#0E1116" };
const ERROR_STYLE: React.CSSProperties = { border: "1px solid #7F1D1D", borderRadius: 8, padding: 12, color: "#FCA5A5", background: "#1A0E12" };
const LOAD_MORE_STYLE: React.CSSProperties = { border: "1px solid #2A2F37", borderRadius: 8, background: "#161B22", color: "#E6EDF3", padding: "10px 12px", cursor: "pointer" };
const SKELETON_STYLE: React.CSSProperties = { height: 108, borderRadius: 8, border: "1px solid #1F2530", background: "#11161D" };

function tabButtonStyle(active: boolean): React.CSSProperties {
  return { border: "none", borderRadius: 6, padding: "6px 12px", background: active ? "#1F2530" : "transparent", color: active ? "#E6EDF3" : "#8B949E", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: active ? 700 : 500 };
}

function cardStyle(active: boolean): React.CSSProperties {
  return { width: "100%", textAlign: "left", border: `1px solid ${active ? "#56C271" : "#2A2F37"}`, borderRadius: 8, padding: 14, background: active ? "#101A15" : "#0E1116", cursor: "pointer", boxShadow: active ? "0 0 0 1px rgba(86,194,113,0.35)" : "none" };
}

function dotStyle(state: PrsTab): React.CSSProperties {
  return { width: 8, height: 8, borderRadius: 999, background: state === "open" ? "#56C271" : "#8B949E" };
}
