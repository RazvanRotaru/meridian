/**
 * The PR-review empty state: shown while `affectedFiles` is empty. A reader pastes the changed
 * file paths from a PR (one per line) and applies them, or tries a canned example to see the
 * lens work before they have a real diff at hand.
 */

import { useState } from "react";
import { parseAffectedInput } from "../derive/changeStatus";
import { useBlueprintActions } from "../state/StoreContext";

// A `git diff --name-status` sample over the orders-service fixture: an ADDED file, a MODIFIED one,
// and a REMOVED path (deleted at HEAD, so it has no node — it lands in the side list, not the graph),
// so "Try an example" shows all three color codes at once.
const EXAMPLE_INPUT = [
  "A\tsrc/pricing/pricingService.ts",
  "M\tsrc/services/orderService.ts",
  "D\tsrc/notifications/legacyMailer.ts",
].join("\n");

export function ReviewSetupCard() {
  const { setAffectedFiles } = useBlueprintActions();
  const [text, setText] = useState("");

  const apply = () => {
    const { paths, statusByFile } = parseAffectedInput(text);
    setAffectedFiles(paths, statusByFile);
  };
  const tryExample = () => {
    const { paths, statusByFile } = parseAffectedInput(EXAMPLE_INPUT);
    setAffectedFiles(paths, statusByFile);
  };
  const canApply = parseAffectedInput(text).paths.length > 0;

  return (
    <div style={WRAP_STYLE}>
      <div style={CARD_STYLE}>
        <div style={TITLE_STYLE}>Review a change</div>
        <div style={SUBTITLE_STYLE}>
          Paste <code>git diff --name-status</code> output (or one path per line) from a PR to isolate
          the flows worth re-checking. Added / modified / removed files are color-coded.
        </div>
        <textarea
          style={TEXTAREA_STYLE}
          placeholder="git diff --name-status output, or one changed path per line"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
        />
        <div style={ACTIONS_STYLE}>
          <button type="button" style={applyStyle(canApply)} disabled={!canApply} onClick={apply}>
            Apply
          </button>
          <button type="button" style={EXAMPLE_BUTTON_STYLE} onClick={tryExample}>
            Try an example
          </button>
        </div>
      </div>
    </div>
  );
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const WRAP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0E1116",
  padding: 24,
};
const CARD_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: "100%",
  maxWidth: 420,
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "#12171E",
  padding: 18,
};
const TITLE_STYLE: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#E6EDF3" };
const SUBTITLE_STYLE: React.CSSProperties = { fontSize: 12, color: "#9AA4B2", lineHeight: 1.5 };
const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "vertical",
  minHeight: 140,
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1.6,
  color: "#E6EDF3",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "8px 10px",
};
const ACTIONS_STYLE: React.CSSProperties = { display: "flex", gap: 8 };
const EXAMPLE_BUTTON_STYLE: React.CSSProperties = {
  background: "transparent",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
  font: "inherit",
};

function applyStyle(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? "#1B3B27" : "#161B22",
    color: enabled ? "#56C271" : "#6C7683",
    border: `1px solid ${enabled ? "#2E6B45" : "#2A2F37"}`,
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: enabled ? "pointer" : "default",
    font: "inherit",
  };
}
