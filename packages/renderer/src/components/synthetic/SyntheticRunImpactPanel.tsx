import type {
  SyntheticExecutionComparison,
  SyntheticOccurrenceComparison,
} from "../../synthetic/syntheticExecutionComparison";
import type { SyntheticValueChange } from "../../synthetic/syntheticValueDiff";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface SyntheticRunImpactPanelProps {
  comparison: SyntheticExecutionComparison;
  selectedCurrentSpanId?: string | null;
  labelForNode?: (nodeId: string) => string | undefined;
  /** Previous-only rows are deliberately not clickable because they have no current graph moment. */
  onSelectCurrentOccurrence?: (spanId: string, nodeId: string | null) => void;
}

/**
 * One-run comparison summary. It reports only captured callable, decision, and boundary-snapshot
 * differences. The panel never promotes correlation into field-level runtime lineage.
 */
export function SyntheticRunImpactPanel(props: SyntheticRunImpactPanelProps) {
  const { comparison } = props;
  if (!comparison.compatible) {
    return (
      <section style={PANEL} aria-label="Synthetic run impact" data-synthetic-run-impact="incompatible">
        <div style={TITLE_ROW}>
          <span style={EYEBROW}>RUN IMPACT</span>
          <span style={UNAVAILABLE}>UNAVAILABLE</span>
        </div>
        <strong style={EMPTY_TITLE}>These runs cannot be compared.</strong>
        <span style={EMPTY_COPY}>{comparison.incompatibilityReason ?? "They do not describe the same synthetic flow."}</span>
        <Caveat partial={comparison.confidence === "partial"} partialReasons={comparison.partialReasons} />
      </section>
    );
  }

  const changed = comparison.occurrences.filter((occurrence) => occurrence.changed);
  const summary = comparison.summary;
  const accessibleSummary = [
    `${summary.inputChangeCount} whole-flow input changes`,
    `${summary.pathChangeCount} observed path changes`,
    `${summary.outputChangeCount} output changes`,
    `${summary.statusChangeCount} status changes`,
    `${summary.changedOccurrenceCount} changed callable occurrences`,
  ].join(", ");

  return (
    <section
      style={PANEL}
      aria-label={`Synthetic run impact: ${accessibleSummary}`}
      data-synthetic-run-impact={summary.hasChanges ? "changed" : "unchanged"}
      data-comparison-confidence={comparison.confidence}
    >
      <div style={HEADER}>
        <div style={TITLE_GROUP}>
          <div style={TITLE_ROW}>
            <span style={EYEBROW}>RUN IMPACT</span>
            <span style={summary.hasChanges ? CHANGED : UNCHANGED}>
              {summary.hasChanges ? "CHANGED" : "NO OBSERVED CHANGE"}
            </span>
          </div>
          <span style={SUBTITLE}>Current run compared with the previous successful run</span>
        </div>
        <div style={SUMMARY} aria-label={accessibleSummary}>
          <SummaryChip label="Input" value={summary.inputChangeCount} />
          <SummaryChip label="Path" value={summary.pathChangeCount} />
          <SummaryChip label="Outputs" value={summary.outputChangeCount} />
          <SummaryChip label="Status" value={summary.statusChangeCount} />
          <SummaryChip label="Occurrences" value={summary.changedOccurrenceCount} />
        </div>
      </div>

      {comparison.inputChanges.length === 0 ? null : (
        <InputChanges changes={comparison.inputChanges} />
      )}

      {changed.length === 0 ? (
        <div style={EMPTY} role="status">
          <strong style={EMPTY_TITLE}>No captured execution differences</strong>
          <span style={EMPTY_COPY}>This run produced the same observed callables, path events, statuses, and snapshots.</span>
        </div>
      ) : (
        <ol style={ROWS} aria-label="Changed observed callable occurrences">
          {changed.map((occurrence) => (
            <OccurrenceRow
              key={occurrence.key}
              occurrence={occurrence}
              selected={occurrence.after?.spanId === props.selectedCurrentSpanId}
              label={occurrenceLabel(occurrence, props.labelForNode)}
              onSelect={props.onSelectCurrentOccurrence}
            />
          ))}
        </ol>
      )}
      <Caveat partial={comparison.confidence === "partial"} partialReasons={comparison.partialReasons} />
    </section>
  );
}

const MAX_VISIBLE_INPUT_CHANGES = 6;

function InputChanges({ changes }: { changes: readonly SyntheticValueChange[] }) {
  const visible = changes.slice(0, MAX_VISIBLE_INPUT_CHANGES);
  const hiddenCount = Math.max(0, changes.length - visible.length);
  return (
    <section style={INPUT_CHANGES} aria-label="Changed whole-flow input fields">
      <span style={INPUT_CHANGES_LABEL}>CHANGED FLOW INPUT</span>
      <ol style={INPUT_CHANGE_LIST}>
        {visible.map((change) => {
          const values = inputChangeValues(change);
          return (
            <li
              key={`${change.kind}:${change.path}`}
              style={INPUT_CHANGE_ROW}
              data-input-change-kind={change.kind}
              aria-label={`${change.path}: ${values.accessible}`}
            >
              <span style={inputChangeKindStyle(change.kind)}>{inputChangeGlyph(change.kind)}</span>
              <code style={INPUT_CHANGE_PATH}>{change.path}</code>
              <span style={INPUT_CHANGE_VALUE} title={values.title}>{values.visible}</span>
            </li>
          );
        })}
      </ol>
      {hiddenCount === 0 ? null : (
        <span style={MORE_INPUT_CHANGES}>+{hiddenCount} more changed field{hiddenCount === 1 ? "" : "s"}</span>
      )}
    </section>
  );
}

function inputChangeValues(change: SyntheticValueChange): { visible: string; accessible: string; title: string } {
  if (change.kind === "added") {
    const after = compactJson(change.after);
    return { visible: `added ${after.short}`, accessible: `added ${after.long}`, title: `Added ${after.long}` };
  }
  if (change.kind === "removed") {
    const before = compactJson(change.before);
    return { visible: `removed ${before.short}`, accessible: `removed ${before.long}`, title: `Removed ${before.long}` };
  }
  const before = compactJson(change.before);
  const after = compactJson(change.after);
  return {
    visible: `${before.short} → ${after.short}`,
    accessible: `changed from ${before.long} to ${after.long}`,
    title: `Changed from ${before.long} to ${after.long}`,
  };
}

function compactJson(value: unknown): { short: string; long: string } {
  const formatted = JSON.stringify(value) ?? "undefined";
  return { short: truncate(formatted, 56), long: truncate(formatted, 180) };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function inputChangeGlyph(kind: SyntheticValueChange["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "−";
  return "↔";
}

function inputChangeKindStyle(kind: SyntheticValueChange["kind"]): React.CSSProperties {
  const color = kind === "added" ? "#58C9A3" : kind === "removed" ? "#F0787C" : "#E6B84D";
  return { flexShrink: 0, color, fontSize: 10, fontWeight: 800 };
}

function SummaryChip({ label, value }: { label: string; value: number }) {
  return (
    <span style={SUMMARY_CHIP} data-impact-summary={label.toLowerCase()}>
      <span style={SUMMARY_LABEL}>{label}</span>
      <strong style={value === 0 ? SUMMARY_ZERO : SUMMARY_VALUE}>{value}</strong>
    </span>
  );
}

function OccurrenceRow({
  occurrence,
  selected,
  label,
  onSelect,
}: {
  occurrence: SyntheticOccurrenceComparison;
  selected: boolean;
  label: string;
  onSelect: SyntheticRunImpactPanelProps["onSelectCurrentOccurrence"];
}) {
  const current = occurrence.after;
  const evidence = occurrenceEvidence(occurrence);
  const content = (
    <>
      <span style={presenceStyle(occurrence.presence)}>{presenceLabel(occurrence.presence)}</span>
      <span style={OCCURRENCE_COPY}>
        <strong style={OCCURRENCE_NAME}>{label}</strong>
        <span style={OCCURRENCE_DETAIL}>{evidence.join(" · ")}</span>
      </span>
      {current === null ? null : <span style={OPEN_GLYPH} aria-hidden="true">›</span>}
    </>
  );

  return (
    <li style={ROW_ITEM} data-occurrence-presence={occurrence.presence} data-occurrence-key={occurrence.key}>
      {current !== null && onSelect !== undefined ? (
        <button
          type="button"
          style={occurrenceRowStyle(selected, true)}
          aria-label={`Show current occurrence ${label} in the execution graph`}
          aria-pressed={selected}
          onClick={() => onSelect(current.spanId, occurrence.nodeId)}
        >
          {content}
        </button>
      ) : (
        <div style={occurrenceRowStyle(selected, false)}>{content}</div>
      )}
    </li>
  );
}

function occurrenceLabel(
  occurrence: SyntheticOccurrenceComparison,
  labelForNode: SyntheticRunImpactPanelProps["labelForNode"],
): string {
  const resolved = occurrence.nodeId === null ? undefined : labelForNode?.(occurrence.nodeId);
  const label = resolved ?? shortSpanName(occurrence.name);
  return occurrence.ordinal > 1 ? `${label} · occurrence ${occurrence.ordinal}` : label;
}

function shortSpanName(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? name : name.slice(separator + 1);
}

function occurrenceEvidence(occurrence: SyntheticOccurrenceComparison): string[] {
  const evidence: string[] = [];
  if (occurrence.presence === "after-only") evidence.push("observed only in changed run");
  if (occurrence.presence === "before-only") evidence.push("not observed in changed run");
  if (occurrence.statusChanged) evidence.push("status changed");
  if (occurrence.decisionChanges.length > 0) {
    evidence.push(`${occurrence.decisionChanges.length} path event change${occurrence.decisionChanges.length === 1 ? "" : "s"}`);
  }
  if (occurrence.snapshotInputChanges !== null && occurrence.snapshotInputChanges.length > 0) {
    evidence.push(`${occurrence.snapshotInputChanges.length} input field change${occurrence.snapshotInputChanges.length === 1 ? "" : "s"}`);
  }
  if (occurrence.snapshotAvailabilityChanged) evidence.push("snapshot availability changed");
  if (occurrence.outcomeChange !== null) evidence.push(outcomeEvidence(occurrence.outcomeChange));
  return evidence.length === 0 ? ["captured occurrence changed"] : evidence;
}

function outcomeEvidence(change: NonNullable<SyntheticOccurrenceComparison["outcomeChange"]>): string {
  if (change.valueChanges.length > 0) {
    return `${change.valueChanges.length} output field change${change.valueChanges.length === 1 ? "" : "s"}`;
  }
  if (change.before.kind === change.after.kind) {
    return change.after.kind === "error" ? "error changed" : "output value changed";
  }
  return `${outcomeKindLabel(change.before.kind)} → ${outcomeKindLabel(change.after.kind)}`;
}

function outcomeKindLabel(
  kind: NonNullable<SyntheticOccurrenceComparison["outcomeChange"]>["before"]["kind"],
): string {
  if (kind === "value") return "output value";
  if (kind === "void") return "no output";
  if (kind === "error") return "error";
  return "uncaptured output";
}

function presenceLabel(presence: SyntheticOccurrenceComparison["presence"]): string {
  if (presence === "after-only") return "AFTER ONLY";
  if (presence === "before-only") return "BEFORE ONLY";
  return "CHANGED";
}

function presenceStyle(presence: SyntheticOccurrenceComparison["presence"]): React.CSSProperties {
  const color = presence === "after-only" ? "#58C9A3" : presence === "before-only" ? "#F0787C" : "#E6B84D";
  return {
    flexShrink: 0,
    minWidth: 70,
    border: `1px solid ${color}66`,
    borderRadius: 999,
    background: `${color}13`,
    color,
    padding: "2px 6px",
    textAlign: "center",
    fontSize: 7.5,
    fontWeight: 800,
    letterSpacing: "0.06em",
  };
}

function occurrenceRowStyle(selected: boolean, clickable: boolean): React.CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxSizing: "border-box",
    border: `1px solid ${selected ? "#58C9A3" : "#28323E"}`,
    borderRadius: 6,
    background: selected ? "rgba(88,201,163,0.09)" : "#0A0F15",
    color: "#C7D2DE",
    padding: "7px 8px",
    textAlign: "left",
    fontFamily: MONO,
    cursor: clickable ? "pointer" : "default",
  };
}

function Caveat({ partial, partialReasons }: { partial: boolean; partialReasons: readonly string[] }) {
  return (
    <p style={CAVEAT} title={partial ? partialReasons.join("\n") : undefined}>
      Observed callable, control-decision, and snapshot comparison only; this does not prove field-level data lineage.
      {" "}Repeated same-call occurrences are aligned by capture order. A zero Path count means no changed captured path events, not that every internal branch was observed.
      {partial ? " One or both captures are partial, so uncaptured differences may be missing." : ""}
    </p>
  );
}

const PANEL: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 9,
  border: "1px solid #2A3742",
  borderRadius: 8,
  background: "#0C1117",
  color: "#C8D3DF",
  fontFamily: MONO,
};
const HEADER: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 8 };
const TITLE_GROUP: React.CSSProperties = { minWidth: 180, flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 3 };
const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7 };
const EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 8.5, fontWeight: 800, letterSpacing: "0.09em" };
const CHANGED: React.CSSProperties = { border: "1px solid #E6B84D66", borderRadius: 999, background: "#E6B84D12", color: "#E6B84D", padding: "2px 6px", fontSize: 7.5, fontWeight: 800, letterSpacing: "0.06em" };
const UNCHANGED: React.CSSProperties = { ...CHANGED, borderColor: "#58C9A366", background: "#58C9A312", color: "#58C9A3" };
const UNAVAILABLE: React.CSSProperties = { ...CHANGED, borderColor: "#78889866", background: "#78889812", color: "#8A98A6" };
const SUBTITLE: React.CSSProperties = { color: "#8795A4", fontSize: 9 };
const SUMMARY: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 5 };
const SUMMARY_CHIP: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid #2A3742", borderRadius: 999, background: "#10161D", padding: "3px 7px" };
const SUMMARY_LABEL: React.CSSProperties = { color: "#7E8B99", fontSize: 8 };
const SUMMARY_VALUE: React.CSSProperties = { color: "#E5BE5D", fontSize: 9, fontVariantNumeric: "tabular-nums" };
const SUMMARY_ZERO: React.CSSProperties = { ...SUMMARY_VALUE, color: "#657382" };
const INPUT_CHANGES: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, border: "1px solid #2A3742", borderRadius: 6, background: "#090E14", padding: "6px 7px" };
const INPUT_CHANGES_LABEL: React.CSSProperties = { flexShrink: 0, color: "#82909E", fontSize: 7.5, fontWeight: 800, letterSpacing: "0.07em" };
const INPUT_CHANGE_LIST: React.CSSProperties = { minWidth: 0, flex: "1 1 360px", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, margin: 0, padding: 0, listStyle: "none" };
const INPUT_CHANGE_ROW: React.CSSProperties = { minWidth: 0, maxWidth: "100%", display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid #293440", borderRadius: 5, background: "#10161D", padding: "3px 6px" };
const INPUT_CHANGE_PATH: React.CSSProperties = { minWidth: 0, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#D4DDE6", fontFamily: MONO, fontSize: 8.5 };
const INPUT_CHANGE_VALUE: React.CSSProperties = { minWidth: 0, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#8997A5", fontSize: 8 };
const MORE_INPUT_CHANGES: React.CSSProperties = { flexShrink: 0, color: "#91A0AE", fontSize: 8.5 };
const ROWS: React.CSSProperties = { maxHeight: 210, margin: 0, padding: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 5, listStyle: "none" };
const ROW_ITEM: React.CSSProperties = { minWidth: 0 };
const OCCURRENCE_COPY: React.CSSProperties = { minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 };
const OCCURRENCE_NAME: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#DDE5ED", fontSize: 9.5 };
const OCCURRENCE_DETAIL: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#7F8C9A", fontSize: 8.5 };
const OPEN_GLYPH: React.CSSProperties = { flexShrink: 0, color: "#58C9A3", fontSize: 15 };
const EMPTY: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, border: "1px dashed #2E5148", borderRadius: 6, background: "rgba(88,201,163,0.04)", padding: 9 };
const EMPTY_TITLE: React.CSSProperties = { color: "#BFCBD6", fontSize: 9.5 };
const EMPTY_COPY: React.CSSProperties = { color: "#7F8D9B", fontSize: 9, lineHeight: 1.45 };
const CAVEAT: React.CSSProperties = { margin: 0, color: "#B79D61", fontSize: 8, lineHeight: 1.45 };
