import { useId } from "react";
import type { JsonValue, SyntheticScenarioDescriptor } from "@meridian/core";
import type { SyntheticExecutionStatus } from "./useSyntheticExecutionController";
import type { SyntheticExecutionTrust } from "../../state/syntheticExecutionTrust";
import { diffSyntheticValues } from "../../synthetic/syntheticValueDiff";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export type SyntheticRunInputState = "current" | "modified" | "invalid";

export interface SyntheticRunInputPanelProps {
  rootLabel: string;
  scenario: SyntheticScenarioDescriptor;
  scenarios: readonly SyntheticScenarioDescriptor[];
  /** Editable JSON text. The accepted value from the visible run is supplied separately. */
  value: string;
  currentInput: JsonValue;
  status: SyntheticExecutionStatus;
  error: string | null;
  executionTrust: SyntheticExecutionTrust;
  sandboxConsent: boolean;
  onChange(value: string): void;
  onSandboxConsentChange(consent: boolean): void;
  onScenarioChange(id: string): void;
  onReset(): void;
  onRun(): void;
}

/**
 * Persistent, whole-flow input editor for an already-visible synthetic execution. This is kept
 * separate from the selected-occurrence inspector: `currentInput` is the exact argument supplied
 * to the root callable, never a child span's boundary snapshot.
 */
export function SyntheticRunInputPanel(props: SyntheticRunInputPanelProps) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const inputState = syntheticRunInputState(props.value, props.currentInput);
  const running = props.status === "running";
  const invalid = inputState === "invalid";
  const modified = inputState === "modified";
  const error = invalid ? "Input must be valid JSON." : props.error;
  const describedBy = error === null ? helpId : `${helpId} ${errorId}`;
  const runLabel = running ? "Running…" : modified ? "Run changed input" : "Run again";
  const sandboxedPr = props.executionTrust.mode === "sandboxed-pr";

  const run = () => {
    if (!running && !invalid && (!sandboxedPr || props.sandboxConsent)) props.onRun();
  };

  return (
    <section
      style={PANEL}
      aria-label="Synthetic flow input"
      aria-busy={running}
      data-synthetic-run-input
      data-input-state={inputState}
    >
      <div style={INTRO}>
        <div style={TITLE_ROW}>
          <span style={EYEBROW}>FLOW INPUT</span>
          <span style={stateChipStyle(inputState)}>{inputStateLabel(inputState)}</span>
        </div>
        <strong style={TITLE}>Argument passed to {props.rootLabel}</strong>
        <span style={DESCRIPTION}>
          Edit this complete input, then run the same scenario to observe a new execution.
        </span>
        {props.scenarios.length > 1 ? (
          <label style={SCENARIO_FIELD}>
            <span style={FIELD_LABEL}>Scenario</span>
            <select
              style={SCENARIO_SELECT}
              value={props.scenario.id}
              disabled={running}
              aria-label="Synthetic rerun scenario"
              onChange={(event) => props.onScenarioChange(event.currentTarget.value)}
            >
              {props.scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <span style={SCENARIO_NAME} title={props.scenario.label}>{props.scenario.label}</span>
        )}
      </div>

      <div style={EDITOR_COLUMN}>
        <label htmlFor={inputId} style={FIELD_LABEL}>Input JSON</label>
        <textarea
          id={inputId}
          style={textareaStyle(invalid)}
          value={props.value}
          disabled={running}
          spellCheck={false}
          aria-label={`Flow input JSON passed to ${props.rootLabel}`}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (!isSyntheticRunShortcut(event)) return;
            event.preventDefault();
            run();
          }}
        />
        <div style={FOOTER}>
          <div style={FEEDBACK}>
            <span id={helpId} style={sandboxedPr ? SANDBOX_TRUST : TRUST}>
              {sandboxedPr
                ? "UNTRUSTED PR SANDBOX · ephemeral OCI; network disabled; read-only source; no host credentials or writable workspace mounts; bounded CPU, memory, processes, and time. Results are forgeable inspection data, not security evidence."
                : "Runs trusted local project code on this machine."}
            </span>
            {error === null ? null : <span id={errorId} style={ERROR} role="alert">{error}</span>}
            {running ? <span style={RUN_STATUS} role="status" aria-live="polite">Running flow…</span> : null}
          </div>
          <div style={ACTIONS}>
            {sandboxedPr ? (
              <label style={SANDBOX_CONSENT}>
                <input
                  type="checkbox"
                  checked={props.sandboxConsent}
                  disabled={running}
                  onChange={(event) => props.onSandboxConsentChange(event.currentTarget.checked)}
                />
                <span>I understand this runs untrusted PR code in the isolated sandbox.</span>
              </label>
            ) : null}
            <span style={SHORTCUT} aria-hidden="true">⌘/Ctrl + Enter</span>
            <button
              type="button"
              style={RESET_BUTTON}
              disabled={running || !modified}
              onClick={props.onReset}
            >
              Reset to current run
            </button>
            <button
              type="button"
              style={runButtonStyle(running || invalid || (sandboxedPr && !props.sandboxConsent))}
              disabled={running || invalid || (sandboxedPr && !props.sandboxConsent)}
              onClick={run}
            >
              {runLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** JSON whitespace and property order are presentation-only and must not mark an input modified. */
export function syntheticRunInputState(value: string, currentInput: JsonValue): SyntheticRunInputState {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value) as JsonValue;
  } catch {
    return "invalid";
  }
  return diffSyntheticValues(currentInput, parsed).length === 0 ? "current" : "modified";
}

export function isSyntheticRunShortcut(
  event: Pick<React.KeyboardEvent<HTMLTextAreaElement>, "key" | "ctrlKey" | "metaKey">,
): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}

function inputStateLabel(state: SyntheticRunInputState): string {
  if (state === "modified") return "MODIFIED";
  if (state === "invalid") return "INVALID";
  return "CURRENT RUN";
}

function stateChipStyle(state: SyntheticRunInputState): React.CSSProperties {
  const color = state === "modified" ? "#E6B84D" : state === "invalid" ? "#F0787C" : "#58C9A3";
  return {
    flexShrink: 0,
    border: `1px solid ${color}66`,
    borderRadius: 999,
    background: `${color}12`,
    color,
    padding: "2px 6px",
    fontSize: 8,
    fontWeight: 800,
    letterSpacing: "0.06em",
  };
}

const PANEL: React.CSSProperties = {
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  gap: 10,
  padding: 10,
  border: "1px solid #315B50",
  borderRadius: 8,
  background: "rgba(12,22,21,0.92)",
  color: "#C8D9D3",
  fontFamily: MONO,
};
const INTRO: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 5 };
const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7 };
const EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 8.5, fontWeight: 800, letterSpacing: "0.09em" };
const TITLE: React.CSSProperties = { color: "#E0ECE7", fontSize: 11.5 };
const DESCRIPTION: React.CSSProperties = { maxWidth: 480, color: "#91A49F", fontSize: 9.5, lineHeight: 1.45 };
const SCENARIO_FIELD: React.CSSProperties = { minWidth: 0, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "center", gap: 7, marginTop: 3 };
const FIELD_LABEL: React.CSSProperties = { color: "#779088", fontSize: 8.5, fontWeight: 750, letterSpacing: "0.07em", textTransform: "uppercase" };
const SCENARIO_SELECT: React.CSSProperties = { minWidth: 0, border: "1px solid #344D47", borderRadius: 5, outline: "none", background: "#0A1112", color: "#C8D9D3", padding: "5px 7px", fontFamily: MONO, fontSize: 9.5 };
const SCENARIO_NAME: React.CSSProperties = { minWidth: 0, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#829B93", fontSize: 9.5 };
const EDITOR_COLUMN: React.CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 5 };
function textareaStyle(invalid: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 96,
    maxHeight: 220,
    resize: "vertical",
    boxSizing: "border-box",
    border: `1px solid ${invalid ? "#A74D58" : "#34433F"}`,
    borderRadius: 6,
    outline: "none",
    background: "#080E10",
    color: "#C8D9D3",
    padding: "8px 9px",
    fontFamily: MONO,
    fontSize: 10,
    lineHeight: 1.45,
  };
}
const FOOTER: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 8 };
const FEEDBACK: React.CSSProperties = { minWidth: 180, flex: "1 1 220px", display: "flex", flexDirection: "column", gap: 3 };
const TRUST: React.CSSProperties = { color: "#D4B56A", fontSize: 8.5 };
const SANDBOX_TRUST: React.CSSProperties = { color: "#F0B966", fontSize: 8.5, lineHeight: 1.4 };
const SANDBOX_CONSENT: React.CSSProperties = { maxWidth: 360, display: "flex", alignItems: "flex-start", gap: 5, color: "#DDC9A4", fontSize: 8.5, lineHeight: 1.35, cursor: "pointer" };
const ERROR: React.CSSProperties = { color: "#E7A0A4", fontSize: 9 };
const RUN_STATUS: React.CSSProperties = { color: "#78D8B7", fontSize: 9 };
const ACTIONS: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 };
const SHORTCUT: React.CSSProperties = { color: "#607269", fontSize: 8 };
const BUTTON: React.CSSProperties = { border: "1px solid #34433F", borderRadius: 5, background: "#151D1C", color: "#BBCBC5", padding: "5px 9px", fontFamily: MONO, fontSize: 9, cursor: "pointer" };
const RESET_BUTTON: React.CSSProperties = BUTTON;
function runButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    ...BUTTON,
    borderColor: disabled ? "#34433F" : "#3D806D",
    background: disabled ? "#151D1C" : "rgba(88,201,163,0.14)",
    color: disabled ? "#68766F" : "#8DE0C2",
    cursor: disabled ? "default" : "pointer",
    fontWeight: 700,
  };
}
