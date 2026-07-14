import { useEffect, useState } from "react";
import type {
  JsonValue,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticNodeSnapshot,
} from "@meridian/core";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function SyntheticExperimentSummary(props: {
  overrides: readonly SyntheticInputOverride[];
  watchers: readonly SyntheticFieldWatcher[];
  execution: SyntheticExecution;
  onRemoveOverride(id: string): void;
  onRemoveWatcher(id: string): void;
}) {
  const stopped = props.execution.outcome === "stopped";
  const stopHit = props.execution.stop?.reason === "watcher"
    ? props.execution.watchHits.find((hit) => hit.id === props.execution.stop?.watchHitId) ?? null
    : null;
  if (props.overrides.length === 0 && props.watchers.length === 0 && !stopped) return null;
  return (
    <section style={SUMMARY} aria-label="Synthetic overrides and watchers">
      <div style={SUMMARY_HEADING}>
        <span style={EYEBROW}>NEXT RUN CONTROLS</span>
        {props.overrides.length > 0 ? <span style={COUNT_CHIP}>{props.overrides.length} override{props.overrides.length === 1 ? "" : "s"}</span> : null}
        {props.watchers.length > 0 ? <span style={COUNT_CHIP}>{props.watchers.length} watcher{props.watchers.length === 1 ? "" : "s"}</span> : null}
        {stopped ? <span style={STOPPED_CHIP}>STOPPED BY WATCHER</span> : null}
      </div>
      {stopHit === null ? null : (
        <div style={STOP_NOTICE} role="status">
          <strong>Execution stopped at {shortNode(stopHit.nodeId)}</strong>
          <span>{stopHit.phase.toUpperCase()} {displayPath(stopHit.path)} · {stopHit.operator}</span>
        </div>
      )}
      <div style={SUMMARY_LISTS}>
        {props.overrides.map((override) => {
          const result = props.execution.inputOverrideResults.find((candidate) => candidate.id === override.id);
          return (
            <ExperimentChip
              key={override.id}
              label={`Override · ${shortNode(override.target.nodeId)}`}
              detail={result?.status ?? "next run"}
              onRemove={() => props.onRemoveOverride(override.id)}
            />
          );
        })}
        {props.watchers.map((watcher) => (
          <ExperimentChip
            key={watcher.id}
            label={`Watch · ${displayPath(watcher.path)}`}
            detail={`${watcher.phase} · ${watcher.operator}`}
            onRemove={() => props.onRemoveWatcher(watcher.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ExperimentChip(props: { label: string; detail: string; onRemove(): void }) {
  return (
    <span style={EXPERIMENT_CHIP}>
      <span style={CHIP_COPY}>
        <strong style={CHIP_LABEL}>{props.label}</strong>
        <span style={CHIP_DETAIL}>{props.detail}</span>
      </span>
      <button type="button" style={REMOVE_BUTTON} aria-label={`Remove ${props.label}`} onClick={props.onRemove}>×</button>
    </span>
  );
}

export function SyntheticOccurrenceExperimentPanel(props: {
  snapshot: SyntheticNodeSnapshot;
  activeOverride: SyntheticInputOverride | null;
  watchers: readonly SyntheticFieldWatcher[];
  watchHit: SyntheticExecution["watchHits"][number] | null;
  onStageOverride(override: SyntheticInputOverride): void;
  onRemoveOverride(id: string): void;
  onAddWatcher(watcher: SyntheticFieldWatcher): void;
  onRemoveWatcher(id: string): void;
}) {
  const [mode, setMode] = useState<"closed" | "override" | "watcher">("closed");
  const [overrideText, setOverrideText] = useState(() => formatJson(props.activeOverride?.input ?? props.snapshot.input));
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SyntheticFieldWatcher["phase"]>("input");
  const [path, setPath] = useState("");
  const [operator, setOperator] = useState<SyntheticFieldWatcher["operator"]>("exists");
  const [expected, setExpected] = useState("");
  const [watcherError, setWatcherError] = useState<string | null>(null);

  useEffect(() => {
    setMode("closed");
    setOverrideText(formatJson(props.activeOverride?.input ?? props.snapshot.input));
    setOverrideError(null);
    setWatcherError(null);
  }, [props.snapshot.spanId, props.activeOverride?.id]);

  const stageOverride = () => {
    let input: JsonValue;
    try {
      input = JSON.parse(overrideText) as JsonValue;
    } catch {
      setOverrideError("Override input must be valid JSON.");
      return;
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      setOverrideError("Override input must be the callable boundary object.");
      return;
    }
    props.onStageOverride({
      id: props.activeOverride?.id ?? experimentId("override"),
      target: { nodeId: props.snapshot.nodeId, occurrenceKey: props.snapshot.occurrenceKey },
      input,
    });
    setOverrideError(null);
    setMode("closed");
  };

  const addWatcher = () => {
    const parsedPath = parseFieldPath(path);
    if (parsedPath === null) {
      setWatcherError("Use a dot path such as request.customerId or a JSON pointer such as /request/customerId.");
      return;
    }
    let parsedExpected: JsonValue | undefined;
    if (operator === "equals") {
      try {
        parsedExpected = JSON.parse(expected) as JsonValue;
      } catch {
        setWatcherError("Expected value must be valid JSON.");
        return;
      }
    }
    props.onAddWatcher({
      id: experimentId("watcher"),
      nodeId: props.snapshot.nodeId,
      // A change needs at least two observations. Scope it to this callable so repeated
      // occurrences can establish a baseline; exists/equals remain exact-occurrence stops.
      ...(operator === "changes" ? {} : { occurrenceKey: props.snapshot.occurrenceKey }),
      phase,
      path: parsedPath,
      operator,
      ...(parsedExpected === undefined ? {} : { expected: parsedExpected }),
    });
    setWatcherError(null);
    setMode("closed");
  };

  return (
    <section style={PANEL} aria-label="Occurrence input override and field watchers">
      <div style={PANEL_HEADER}>
        <span style={EYEBROW}>NEXT RUN</span>
        {props.activeOverride === null ? null : <span style={ACTIVE_CHIP}>INPUT OVERRIDE STAGED</span>}
        {props.watchers.length === 0 ? null : <span style={ACTIVE_CHIP}>{props.watchers.length} WATCHER{props.watchers.length === 1 ? "" : "S"}</span>}
        {props.watchHit === null ? null : <span style={STOPPED_CHIP}>WATCHER HIT</span>}
        <span style={{ flex: 1 }} />
        <button type="button" style={TOOL_BUTTON} aria-expanded={mode === "override"} onClick={() => setMode(mode === "override" ? "closed" : "override")}>Override input</button>
        <button type="button" style={TOOL_BUTTON} aria-expanded={mode === "watcher"} onClick={() => setMode(mode === "watcher" ? "closed" : "watcher")}>Add watcher</button>
      </div>
      {props.watchHit === null ? null : (
        <div style={HIT_ROW} role="status">
          Stopped on {props.watchHit.phase.toUpperCase()} {displayPath(props.watchHit.path)} · {props.watchHit.operator}
        </div>
      )}
      {mode === "override" ? (
        <div style={EDITOR}>
          <label style={FIELD_LABEL}>Complete input for this occurrence</label>
          <textarea style={TEXTAREA} value={overrideText} spellCheck={false} aria-label="Occurrence input override JSON" onChange={(event) => { setOverrideText(event.currentTarget.value); setOverrideError(null); }} />
          <div style={FORM_FOOTER}>
            {overrideError === null ? <span style={FORM_HELP}>Applied before this same causal occurrence on the next run.</span> : <span style={ERROR} role="alert">{overrideError}</span>}
            {props.activeOverride === null ? null : <button type="button" style={SECONDARY_BUTTON} onClick={() => props.onRemoveOverride(props.activeOverride!.id)}>Remove override</button>}
            <button type="button" style={PRIMARY_BUTTON} onClick={stageOverride}>Stage override</button>
          </div>
        </div>
      ) : null}
      {mode === "watcher" ? (
        <div style={WATCHER_FORM}>
          <label style={FIELD}><span style={FIELD_LABEL}>Phase</span><select style={INPUT} value={phase} onChange={(event) => setPhase(event.currentTarget.value as SyntheticFieldWatcher["phase"])}><option value="input">Input</option><option value="output">Output</option></select></label>
          <label style={FIELD}><span style={FIELD_LABEL}>Field path</span><input style={INPUT} value={path} placeholder="request.customerId" onChange={(event) => { setPath(event.currentTarget.value); setWatcherError(null); }} /></label>
          <label style={FIELD}><span style={FIELD_LABEL}>Condition</span><select style={INPUT} value={operator} onChange={(event) => setOperator(event.currentTarget.value as SyntheticFieldWatcher["operator"])}><option value="exists">exists</option><option value="equals">equals</option><option value="changes">changes</option></select></label>
          {operator === "equals" ? <label style={FIELD}><span style={FIELD_LABEL}>Expected JSON</span><input style={INPUT} value={expected} placeholder='"VIP"' onChange={(event) => { setExpected(event.currentTarget.value); setWatcherError(null); }} /></label> : null}
          <div style={FORM_FOOTER_WIDE}>
            {watcherError === null ? <span style={FORM_HELP}>{operator === "changes" ? "Stops when the field changes across repeated calls to this node." : "The run stops when this watcher hits."}</span> : <span style={ERROR} role="alert">{watcherError}</span>}
            <button type="button" style={PRIMARY_BUTTON} onClick={addWatcher}>Add stop watcher</button>
          </div>
        </div>
      ) : null}
      {props.watchers.length === 0 ? null : (
        <div style={WATCHER_LIST} aria-label="Watchers for selected occurrence">
          {props.watchers.map((watcher) => (
            <span key={watcher.id} style={WATCHER_ROW}>
              <code>{watcher.phase.toUpperCase()} {displayPath(watcher.path)} · {watcher.operator}</code>
              <button type="button" style={REMOVE_BUTTON} aria-label={`Remove watcher ${displayPath(watcher.path)}`} onClick={() => props.onRemoveWatcher(watcher.id)}>×</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function parseFieldPath(value: string): string[] | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "$") return [];
  if (trimmed.startsWith("/")) {
    try {
      const parts = trimmed.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      return safeFieldPath(parts) ? parts : null;
    } catch {
      return null;
    }
  }
  const normalized = trimmed.startsWith("$.") ? trimmed.slice(2) : trimmed;
  const parts = normalized.split(".");
  return parts.every((part) => part.length > 0) && safeFieldPath(parts) ? parts : null;
}

function safeFieldPath(parts: readonly string[]): boolean {
  return parts.every((part) => !["__proto__", "prototype", "constructor"].includes(part));
}

function displayPath(path: readonly string[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

function shortNode(nodeId: string): string {
  const separator = Math.max(nodeId.lastIndexOf("#"), nodeId.lastIndexOf("/"));
  return separator < 0 ? nodeId : nodeId.slice(separator + 1);
}

function formatJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function experimentId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

const SUMMARY: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 7, border: "1px solid #2A3742", borderRadius: 8, background: "#0B1117", padding: "8px 9px", color: "#B8C5D1", fontFamily: MONO };
const SUMMARY_HEADING: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 };
const SUMMARY_LISTS: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 };
const EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 8, fontWeight: 800, letterSpacing: "0.09em" };
const COUNT_CHIP: React.CSSProperties = { border: "1px solid #3A4A56", borderRadius: 999, padding: "2px 6px", color: "#9AAABA", fontSize: 8 };
const STOPPED_CHIP: React.CSSProperties = { border: "1px solid #D19B4166", borderRadius: 999, background: "#D19B4114", color: "#E6B84D", padding: "2px 6px", fontSize: 8, fontWeight: 800, letterSpacing: "0.05em" };
const STOP_NOTICE: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, borderLeft: "2px solid #E6B84D", background: "rgba(230,184,77,0.06)", padding: "5px 7px", color: "#D9C38A", fontSize: 9 };
const EXPERIMENT_CHIP: React.CSSProperties = { maxWidth: "100%", display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #2D3A45", borderRadius: 6, background: "#0E161D", padding: "4px 5px 4px 7px" };
const CHIP_COPY: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 1 };
const CHIP_LABEL: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#CBD6E0", fontSize: 8.5 };
const CHIP_DETAIL: React.CSSProperties = { color: "#70808F", fontSize: 7.5 };
const REMOVE_BUTTON: React.CSSProperties = { width: 20, height: 20, flexShrink: 0, border: "none", borderRadius: 4, background: "transparent", color: "#788898", cursor: "pointer", fontSize: 14, lineHeight: "18px" };
const PANEL: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid #202733", background: "#0B1117", padding: "7px 9px", color: "#B7C3CF", fontFamily: MONO };
const PANEL_HEADER: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5 };
const ACTIVE_CHIP: React.CSSProperties = { border: "1px solid #58C9A355", borderRadius: 999, background: "#58C9A310", color: "#78D8B7", padding: "2px 5px", fontSize: 7, fontWeight: 750 };
const TOOL_BUTTON: React.CSSProperties = { border: "1px solid #34414E", borderRadius: 5, background: "#141C25", color: "#B4C1CE", padding: "3px 6px", fontFamily: MONO, fontSize: 8, cursor: "pointer" };
const HIT_ROW: React.CSSProperties = { borderLeft: "2px solid #E6B84D", background: "rgba(230,184,77,0.05)", color: "#D8C384", padding: "4px 6px", fontSize: 8.5 };
const EDITOR: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, border: "1px solid #2A3742", borderRadius: 6, background: "#080D12", padding: 7 };
const TEXTAREA: React.CSSProperties = { minHeight: 92, maxHeight: 190, resize: "vertical", border: "1px solid #34414E", borderRadius: 5, outline: "none", background: "#070B10", color: "#C8D6D0", padding: 7, fontFamily: MONO, fontSize: 9, lineHeight: 1.45 };
const FORM_FOOTER: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", gap: 6 };
const FORM_FOOTER_WIDE: React.CSSProperties = { ...FORM_FOOTER, gridColumn: "1 / -1", gridTemplateColumns: "minmax(0, 1fr) auto" };
const FORM_HELP: React.CSSProperties = { color: "#758594", fontSize: 8 };
const ERROR: React.CSSProperties = { color: "#E7A0A4", fontSize: 8.5 };
const SECONDARY_BUTTON: React.CSSProperties = { ...TOOL_BUTTON, padding: "4px 7px" };
const PRIMARY_BUTTON: React.CSSProperties = { ...TOOL_BUTTON, borderColor: "#3D806D", background: "rgba(88,201,163,0.12)", color: "#8DE0C2", padding: "4px 8px", fontWeight: 700 };
const WATCHER_FORM: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(90px, .55fr) minmax(170px, 1.4fr) minmax(100px, .7fr) minmax(120px, 1fr)", alignItems: "end", gap: 6, border: "1px solid #2A3742", borderRadius: 6, background: "#080D12", padding: 7 };
const FIELD: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 };
const FIELD_LABEL: React.CSSProperties = { color: "#758594", fontSize: 7.5, fontWeight: 750, letterSpacing: "0.06em", textTransform: "uppercase" };
const INPUT: React.CSSProperties = { minWidth: 0, boxSizing: "border-box", border: "1px solid #34414E", borderRadius: 5, outline: "none", background: "#0B1117", color: "#C4D0DC", padding: "5px 6px", fontFamily: MONO, fontSize: 8.5 };
const WATCHER_LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const WATCHER_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 7, border: "1px solid #2A3742", borderRadius: 5, background: "#0C131A", color: "#9BABBA", padding: "3px 4px 3px 7px", fontSize: 8 };
