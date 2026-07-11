import type { PrSummary, RelatedPr, PrsTab } from "../../state/prTypes";

type CardPr = PrSummary | RelatedPr;

export function PrCard(props: { pr: CardPr; active: boolean; onSelect: () => void; matchCount?: number }) {
  const state: PrsTab = "state" in props.pr ? props.pr.state : "open";
  return (
    <button type="button" style={cardStyle(props.active)} onClick={props.onSelect}>
      <div style={CARD_TOP_STYLE}>
        <span style={NUMBER_STYLE}>#{props.pr.number}</span>
        <span style={dotStyle(state)} />
        {props.pr.draft ? <span style={DRAFT_STYLE}>Draft</span> : null}
        {props.matchCount !== undefined ? <span style={MATCH_STYLE}>{props.matchCount} files match</span> : null}
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

const CARD_TOP_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const NUMBER_STYLE: React.CSSProperties = { color: "#7DD3FC", fontSize: 12, fontWeight: 700 };
const DRAFT_STYLE: React.CSSProperties = { color: "#C084FC", border: "1px solid #6B21A8", borderRadius: 999, padding: "1px 7px", fontSize: 11 };
const MATCH_STYLE: React.CSSProperties = { marginLeft: "auto", color: "#FBBF24", border: "1px solid #92400E", borderRadius: 999, padding: "1px 7px", fontSize: 11, whiteSpace: "nowrap" };
const CARD_TITLE_STYLE: React.CSSProperties = { marginTop: 8, color: "#F0F6FC", fontSize: 14, lineHeight: "19px", fontWeight: 650 };
const META_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10, color: "#8B949E", fontSize: 12 };

function cardStyle(active: boolean): React.CSSProperties {
  return { width: "100%", textAlign: "left", border: `1px solid ${active ? "#56C271" : "#2A2F37"}`, borderRadius: 8, padding: 14, background: active ? "#101A15" : "#0E1116", cursor: "pointer", boxShadow: active ? "0 0 0 1px rgba(86,194,113,0.35)" : "none" };
}

function dotStyle(state: PrsTab): React.CSSProperties {
  return { width: 8, height: 8, borderRadius: 999, background: state === "open" ? "#56C271" : "#8B949E" };
}
