/**
 * The example-PR picker in the review-setup empty state: a short list of canned PRs a reader can load
 * with one click to see the lens work before they have a real diff at hand. Each row loads that PR's
 * changed-file set (paths + per-file status) straight into the review scope via `setAffectedFiles` —
 * the same entry point the paste box uses. Dark-mode only; inline styles, consistent with the card.
 */

import { EXAMPLE_PRS, exampleAffectedInput, exampleSummary, type ExamplePr } from "./examplePrs";
import { useBlueprintActions } from "../state/StoreContext";

export function ExamplePrPicker() {
  const { setAffectedFiles } = useBlueprintActions();
  const load = (pr: ExamplePr) => {
    const { paths, statusByFile } = exampleAffectedInput(pr);
    setAffectedFiles(paths, statusByFile);
  };

  return (
    <div style={SECTION_STYLE}>
      <div style={LABEL_STYLE}>Example PRs</div>
      {EXAMPLE_PRS.map((pr) => (
        <button key={pr.number} type="button" style={ROW_STYLE} onClick={() => load(pr)}>
          <span style={ROW_TITLE_STYLE}>
            <span style={NUMBER_STYLE}>#{pr.number}</span> {pr.title}
          </span>
          <span style={ROW_SUMMARY_STYLE}>{exampleSummary(pr)}</span>
        </button>
      ))}
    </div>
  );
}

const SECTION_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#6C7683",
  marginTop: 2,
};
const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  textAlign: "left",
  width: "100%",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "8px 10px",
  cursor: "pointer",
  font: "inherit",
};
const ROW_TITLE_STYLE: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#E6EDF3" };
const NUMBER_STYLE: React.CSSProperties = { color: "#56C271" };
const ROW_SUMMARY_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2" };
