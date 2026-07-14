import { useId, useState } from "react";
import type {
  JsonValue,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticNodeSnapshot,
} from "@meridian/core";
import {
  diffSyntheticValues,
  type SyntheticValueChange,
} from "../../synthetic/syntheticValueDiff";
import { SyntheticOccurrenceExperimentPanel } from "./SyntheticExperimentPanel";

export { diffSyntheticValues } from "../../synthetic/syntheticValueDiff";
export type { SyntheticDiffDepth, SyntheticValueChange } from "../../synthetic/syntheticValueDiff";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export type SyntheticDataInspectorTab = "data" | "changes";
export interface SyntheticDataInspectorProps {
  /** Human-readable callable/occurrence label. Identity still comes from the snapshot ids. */
  occurrenceLabel: string;
  /** Null means this occurrence was observed without a captured boundary snapshot. */
  snapshot: SyntheticNodeSnapshot | null;
  /** Optional one-based position in the active synthetic execution. */
  position?: { current: number; total: number };
  /** Primarily useful when a parent restores a reader's last detail view. */
  initialTab?: SyntheticDataInspectorTab;
  experiment?: {
    activeOverride: SyntheticInputOverride | null;
    watchers: readonly SyntheticFieldWatcher[];
    watchHit: SyntheticExecution["watchHits"][number] | null;
    onStageOverride(override: SyntheticInputOverride): void;
    onRemoveOverride(id: string): void;
    onAddWatcher(watcher: SyntheticFieldWatcher): void;
    onRemoveWatcher(id: string): void;
  };
}

/**
 * Full-fidelity details for one selected synthetic occurrence. Graph cards intentionally retain a
 * compact preview; this inspector owns the untruncated values and labels its comparison as a
 * structural diff rather than claiming field-level runtime lineage.
 */
export function SyntheticDataInspector({
  occurrenceLabel,
  snapshot,
  position,
  initialTab = "data",
  experiment,
}: SyntheticDataInspectorProps) {
  const instanceId = useId();
  const [activeTab, setActiveTab] = useState<SyntheticDataInspectorTab>(initialTab);
  const [copyState, setCopyState] = useState<{ key: string; message: string } | null>(null);
  const tabs: Array<{ id: SyntheticDataInspectorTab; label: string }> = [
    { id: "data", label: "IN + OUT" },
    { id: "changes", label: "CHANGES" },
  ];

  const copy = async (key: string, value: string) => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopyState({ key, message: "Copied" });
    } catch {
      setCopyState({ key, message: "Copy unavailable" });
    }
  };

  return (
    <section style={INSPECTOR} aria-label="Synthetic data inspector" data-synthetic-data-inspector>
      <header style={HEADER}>
        <div style={TITLE_GROUP}>
          <span style={EYEBROW}>SELECTED OCCURRENCE</span>
          <strong style={TITLE}>{occurrenceLabel}</strong>
          {snapshot === null ? null : (
            <span style={IDENTITY} title={`${snapshot.nodeId} · span ${snapshot.spanId}`}>
              {snapshot.nodeId} · span {shortId(snapshot.spanId)}
            </span>
          )}
        </div>
        {position === undefined ? null : (
          <span style={POSITION} aria-label={`Occurrence ${position.current} of ${position.total}`}>
            {position.current} / {position.total}
          </span>
        )}
      </header>

      {snapshot === null ? (
        <div style={EMPTY} role="status">
          <strong>No boundary snapshot</strong>
          <span>This occurrence was observed, but its input and output values were not captured.</span>
        </div>
      ) : (
        <>
          {experiment === undefined ? null : (
            <SyntheticOccurrenceExperimentPanel snapshot={snapshot} {...experiment} />
          )}
          <div style={TAB_LIST} role="tablist" aria-label="Snapshot view">
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
              return (
                <button
                  key={tab.id}
                  id={`${instanceId}-${tab.id}-tab`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${instanceId}-${tab.id}-panel`}
                  tabIndex={selected ? 0 : -1}
                  style={tabStyle(selected)}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    const nextIndex = tabIndexAfterKey(event.key, tabIndex, tabs.length);
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const nextTab = tabs[nextIndex]!;
                    setActiveTab(nextTab.id);
                    document.getElementById(`${instanceId}-${nextTab.id}-tab`)?.focus();
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div
            id={`${instanceId}-${activeTab}-panel`}
            role="tabpanel"
            aria-labelledby={`${instanceId}-${activeTab}-tab`}
            style={TAB_PANEL}
            data-synthetic-inspector-tab={activeTab}
          >
            {activeTab === "data" ? (
              <div style={SNAPSHOT_STACK} aria-label="Input and output data">
                <JsonValuePanel
                  label="Input JSON"
                  value={snapshot.input}
                  copyState={copyState?.key === "input" ? copyState.message : null}
                  onCopy={(text) => void copy("input", text)}
                />
                <OutputPanel
                  snapshot={snapshot}
                  copyState={copyState?.key === "output" ? copyState.message : null}
                  onCopy={(text) => void copy("output", text)}
                />
              </div>
            ) : (
              <ChangesPanel
                snapshot={snapshot}
                copyState={copyState?.key === "changes" ? copyState.message : null}
                onCopy={(text) => void copy("changes", text)}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function OutputPanel(props: {
  snapshot: SyntheticNodeSnapshot;
  copyState: string | null;
  onCopy(text: string): void;
}) {
  if (props.snapshot.error !== undefined) {
    return (
      <div style={STATE_PANEL} data-synthetic-output-state="error">
        <div style={STATE_HEADING_ROW}>
          <strong style={ERROR_TITLE}>Occurrence threw</strong>
          <CopyButton label="Copy error" state={props.copyState} onClick={() => props.onCopy(props.snapshot.error!)} />
        </div>
        <span>No successful output was produced.</span>
        <pre style={ERROR_VALUE}>{props.snapshot.error}</pre>
      </div>
    );
  }
  if (props.snapshot.output === undefined) {
    return (
      <div style={STATE_PANEL} role="status" data-synthetic-output-state="void">
        <strong>No output value</strong>
        <span>The callable returned void or undefined; Meridian does not invent a JSON value for it.</span>
      </div>
    );
  }
  return (
    <JsonValuePanel
      label="Output JSON"
      value={props.snapshot.output}
      copyState={props.copyState}
      onCopy={props.onCopy}
    />
  );
}

function JsonValuePanel(props: {
  label: string;
  value: JsonValue;
  copyState: string | null;
  onCopy(text: string): void;
}) {
  const formatted = formatJson(props.value);
  return (
    <section style={VALUE_PANEL} aria-label={props.label}>
      <div style={VALUE_HEADER}>
        <strong>{props.label}</strong>
        <CopyButton label={`Copy ${props.label}`} state={props.copyState} onClick={() => props.onCopy(formatted)} />
      </div>
      <pre style={JSON_VALUE}>{formatted}</pre>
    </section>
  );
}

function ChangesPanel(props: {
  snapshot: SyntheticNodeSnapshot;
  copyState: string | null;
  onCopy(text: string): void;
}) {
  if (props.snapshot.error !== undefined) {
    return (
      <div style={STATE_PANEL} role="status" data-synthetic-changes-state="error">
        <strong>Changes unavailable</strong>
        <span>The occurrence threw before it produced an output value.</span>
      </div>
    );
  }
  if (props.snapshot.output === undefined) {
    return (
      <div style={STATE_PANEL} role="status" data-synthetic-changes-state="void">
        <strong>Changes unavailable</strong>
        <span>A structural comparison requires an output value.</span>
      </div>
    );
  }
  const changes = diffSyntheticValues(props.snapshot.input, props.snapshot.output, "deep");
  return (
    <section style={CHANGES} aria-label="Structural input and output changes">
      <div style={VALUE_HEADER}>
        <div style={CHANGE_HEADING}>
          <strong>{changes.length} structural change{changes.length === 1 ? "" : "s"}</strong>
          <span style={LINEAGE_NOTE}>Value comparison only · does not prove data lineage</span>
        </div>
        <CopyButton
          label="Copy structural changes"
          state={props.copyState}
          onClick={() => props.onCopy(JSON.stringify(changes, null, 2))}
        />
      </div>
      {changes.length === 0 ? (
        <div style={EMPTY_CHANGES} role="status">Input and output are structurally identical.</div>
      ) : (
        <ol style={CHANGE_LIST} aria-label="Changed JSON paths">
          {changes.map((change) => <ChangeRow key={`${change.kind}:${change.path}`} change={change} />)}
        </ol>
      )}
    </section>
  );
}

function ChangeRow({ change }: { change: SyntheticValueChange }) {
  return (
    <li style={CHANGE_ROW} data-change-kind={change.kind}>
      <div style={CHANGE_PATH_ROW}>
        <span style={changeBadgeStyle(change.kind)}>{change.kind}</span>
        <code style={CHANGE_PATH}>{change.path}</code>
      </div>
      <div style={CHANGE_VALUES}>
        {change.kind === "added" ? null : <ChangeValue label="Before" value={change.before} />}
        {change.kind === "removed" ? null : <ChangeValue label="After" value={change.after} />}
      </div>
    </li>
  );
}

function ChangeValue({ label, value }: { label: string; value: JsonValue }) {
  return (
    <div style={CHANGE_VALUE}>
      <span style={CHANGE_VALUE_LABEL}>{label}</span>
      <pre style={CHANGE_VALUE_JSON}>{formatJson(value)}</pre>
    </div>
  );
}

function CopyButton(props: { label: string; state: string | null; onClick(): void }) {
  return (
    <span style={COPY_GROUP}>
      {props.state === null ? null : <span style={COPY_STATE} role="status">{props.state}</span>}
      <button type="button" style={COPY_BUTTON} aria-label={props.label} onClick={props.onClick}>Copy</button>
    </span>
  );
}

function formatJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function tabIndexAfterKey(key: string, current: number, count: number): number | null {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`;
}

function tabStyle(selected: boolean): React.CSSProperties {
  return {
    border: "none",
    borderBottom: `2px solid ${selected ? "#58C9A3" : "transparent"}`,
    background: selected ? "rgba(88,201,163,0.08)" : "transparent",
    color: selected ? "#A8E7D1" : "#778594",
    padding: "7px 12px 6px",
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 750,
    letterSpacing: "0.06em",
    cursor: "pointer",
  };
}

function changeBadgeStyle(kind: SyntheticValueChange["kind"]): React.CSSProperties {
  const color = kind === "added" ? "#58C9A3" : kind === "removed" ? "#F0787C" : "#E6B84D";
  return {
    minWidth: 58,
    border: `1px solid ${color}66`,
    borderRadius: 999,
    background: `${color}14`,
    color,
    padding: "2px 6px",
    textAlign: "center",
    textTransform: "uppercase",
    fontSize: 8,
    fontWeight: 800,
    letterSpacing: "0.06em",
  };
}

const INSPECTOR: React.CSSProperties = {
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  border: "1px solid #29323D",
  borderRadius: 8,
  overflow: "hidden",
  background: "#0C1016",
  color: "#CDD6E1",
  fontFamily: MONO,
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 12px", borderBottom: "1px solid #202733", background: "#10151C" };
const TITLE_GROUP: React.CSSProperties = { minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 3 };
const EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 8, fontWeight: 800, letterSpacing: "0.09em" };
const TITLE: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#E4EBF3", fontSize: 12 };
const IDENTITY: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#748292", fontSize: 8.5 };
const POSITION: React.CSSProperties = { flexShrink: 0, border: "1px solid #33404C", borderRadius: 999, padding: "3px 7px", color: "#9CACBC", fontSize: 9 };
const TAB_LIST: React.CSSProperties = { display: "flex", alignItems: "stretch", borderBottom: "1px solid #202733", padding: "0 6px", background: "#0E131A" };
const TAB_PANEL: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 10 };
const SNAPSHOT_STACK: React.CSSProperties = { width: "100%", height: "100%", minWidth: 0, minHeight: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, overflow: "hidden" };
const VALUE_PANEL: React.CSSProperties = { minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 };
const VALUE_HEADER: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, color: "#AAB7C5", fontSize: 9.5 };
const JSON_VALUE: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, margin: 0, overflow: "auto", border: "1px solid #222C37", borderRadius: 6, background: "#080C11", color: "#C8D9D3", padding: 10, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const COPY_GROUP: React.CSSProperties = { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 };
const COPY_STATE: React.CSSProperties = { color: "#748292", fontSize: 8.5 };
const COPY_BUTTON: React.CSSProperties = { border: "1px solid #33404C", borderRadius: 5, background: "#151C25", color: "#AEBBC9", padding: "3px 7px", fontFamily: MONO, fontSize: 8.5, cursor: "pointer" };
const STATE_PANEL: React.CSSProperties = { minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", justifyContent: "flex-start", gap: 7, border: "1px dashed #2B3541", borderRadius: 6, background: "#0A0E13", color: "#8391A1", padding: 10, fontSize: 10, lineHeight: 1.5 };
const STATE_HEADING_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 };
const ERROR_TITLE: React.CSSProperties = { color: "#F0787C" };
const ERROR_VALUE: React.CSSProperties = { maxHeight: 180, margin: 0, overflow: "auto", borderLeft: "2px solid #F0787C", background: "rgba(240,120,124,0.05)", color: "#E9A6AA", padding: "7px 9px", fontFamily: MONO, fontSize: 9.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const EMPTY: React.CSSProperties = { minHeight: 120, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6, color: "#7E8B99", padding: 14, fontSize: 10, lineHeight: 1.5 };
const CHANGES: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 9 };
const CHANGE_HEADING: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 };
const LINEAGE_NOTE: React.CSSProperties = { color: "#D4B56A", fontSize: 8.5, fontWeight: 400 };
const EMPTY_CHANGES: React.CSSProperties = { border: "1px dashed #315B50", borderRadius: 6, background: "rgba(88,201,163,0.05)", color: "#8FB8A9", padding: 12, fontSize: 10 };
const CHANGE_LIST: React.CSSProperties = { maxHeight: 380, margin: 0, padding: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 7, listStyle: "none" };
const CHANGE_ROW: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7, border: "1px solid #222C37", borderRadius: 6, background: "#090D12", padding: 8 };
const CHANGE_PATH_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const CHANGE_PATH: React.CSSProperties = { color: "#BAC7D4", fontFamily: MONO, fontSize: 10, overflowWrap: "anywhere" };
const CHANGE_VALUES: React.CSSProperties = { minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 7 };
const CHANGE_VALUE: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 };
const CHANGE_VALUE_LABEL: React.CSSProperties = { color: "#697787", fontSize: 8, fontWeight: 750, letterSpacing: "0.05em", textTransform: "uppercase" };
const CHANGE_VALUE_JSON: React.CSSProperties = { minWidth: 0, maxHeight: 180, margin: 0, overflow: "auto", borderRadius: 4, background: "#070A0E", color: "#AFC0CE", padding: 6, fontFamily: MONO, fontSize: 9, lineHeight: 1.4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
