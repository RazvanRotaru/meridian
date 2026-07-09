import { useEffect } from "react";
import type { PrChangedFile, PrFileStatus, PrSummary } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";

export function PrDetailPanel() {
  const selected = useBlueprint((state) => state.prSelected);
  const summary = useBlueprint((state) => summaryFor(state.prSelected, state.prsList.open, state.prsList.closed));
  const files = useBlueprint((state) => state.prFiles);
  const truncated = useBlueprint((state) => state.prFilesTruncated);
  const loading = useBlueprint((state) => state.prsLoading);
  const error = useBlueprint((state) => state.prsError);
  const { selectPr, reviewPrInGraph } = useBlueprintActions();

  useEffect(() => {
    if (selected === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void selectPr(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectPr, selected]);

  if (selected === null) {
    return (
      <aside style={PANEL_STYLE}>
        <div style={EMPTY_STYLE}>Select a pull request.</div>
      </aside>
    );
  }

  return (
    <aside style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <button type="button" style={BACK_STYLE} onClick={() => void selectPr(null)}>
          Back
        </button>
        <div style={NUMBER_STYLE}>#{selected}</div>
      </div>
      <h2 style={TITLE_STYLE}>{summary?.title ?? `PR #${selected}`}</h2>
      {summary ? <div style={META_STYLE}>{summary.author} / {summary.headRef}</div> : null}
      <button type="button" style={REVIEW_STYLE} disabled={!files || loading} onClick={reviewPrInGraph}>
        Review in graph
      </button>
      {truncated ? <div style={NOTICE_STYLE}>File list truncated by the server.</div> : null}
      {files === null && loading ? <div style={LOADING_STYLE}>Loading files...</div> : null}
      {files === null && error ? <div style={ERROR_STYLE}>{error}</div> : null}
      {files ? <FileList files={files} /> : null}
    </aside>
  );
}

function FileList(props: { files: readonly PrChangedFile[] }) {
  if (props.files.length === 0) {
    return <div style={EMPTY_STYLE}>No changed files.</div>;
  }
  return (
    <div style={FILES_STYLE}>
      {props.files.map((file) => (
        <div key={`${file.status}:${file.path}`} style={FILE_ROW_STYLE}>
          <span style={chipStyle(file.status)}>{file.status}</span>
          <span style={PATH_STYLE} title={file.path}>{file.path}</span>
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  selected: number | null,
  open: readonly PrSummary[] | null,
  closed: readonly PrSummary[] | null,
): PrSummary | null {
  if (selected === null) {
    return null;
  }
  return [...(open ?? []), ...(closed ?? [])].find((pr) => pr.number === selected) ?? null;
}

const PANEL_STYLE: React.CSSProperties = { minHeight: 0, overflowY: "auto", border: "1px solid #2A2F37", borderRadius: 8, background: "#0E1116", padding: 18 };
const HEADER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 };
const BACK_STYLE: React.CSSProperties = { border: "1px solid #2A2F37", borderRadius: 6, background: "#161B22", color: "#C9D1D9", padding: "5px 10px", cursor: "pointer", fontSize: 12 };
const NUMBER_STYLE: React.CSSProperties = { color: "#7DD3FC", fontWeight: 700, fontSize: 13 };
const TITLE_STYLE: React.CSSProperties = { margin: "0 0 8px", color: "#F0F6FC", fontSize: 18, lineHeight: "24px" };
const META_STYLE: React.CSSProperties = { color: "#8B949E", fontSize: 12, marginBottom: 14 };
const REVIEW_STYLE: React.CSSProperties = { width: "100%", border: "1px solid #56C271", borderRadius: 8, background: "#12301F", color: "#E6F6EA", padding: "10px 12px", cursor: "pointer", fontWeight: 750, marginBottom: 14 };
const NOTICE_STYLE: React.CSSProperties = { border: "1px solid #92400E", borderRadius: 8, padding: 10, color: "#FBBF24", background: "#1C1409", fontSize: 12, marginBottom: 12 };
const LOADING_STYLE: React.CSSProperties = { border: "1px solid #2A2F37", borderRadius: 8, padding: 12, color: "#8B949E", background: "#11161D" };
const ERROR_STYLE: React.CSSProperties = { border: "1px solid #7F1D1D", borderRadius: 8, padding: 12, color: "#FCA5A5", background: "#1A0E12" };
const EMPTY_STYLE: React.CSSProperties = { border: "1px dashed #2A2F37", borderRadius: 8, padding: 14, color: "#8B949E", background: "#0B0F14" };
const FILES_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const FILE_ROW_STYLE: React.CSSProperties = { display: "grid", gridTemplateColumns: "82px minmax(0, 1fr)", gap: 10, alignItems: "center", borderBottom: "1px solid #1F2530", padding: "8px 0" };
const PATH_STYLE: React.CSSProperties = { color: "#C9D1D9", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function chipStyle(status: PrFileStatus): React.CSSProperties {
  const colors: Record<PrFileStatus, { border: string; color: string; background: string }> = {
    added: { border: "#166534", color: "#86EFAC", background: "#0B1F13" },
    modified: { border: "#92400E", color: "#FBBF24", background: "#1C1409" },
    removed: { border: "#7F1D1D", color: "#FCA5A5", background: "#1A0E12" },
    renamed: { border: "#6B21A8", color: "#D8B4FE", background: "#1B1028" },
  };
  const color = colors[status];
  return {
    border: `1px solid ${color.border}`,
    borderRadius: 999,
    color: color.color,
    background: color.background,
    padding: "2px 8px",
    fontSize: 11,
    textTransform: "capitalize",
    textAlign: "center",
  };
}
