import type { NodeId, SyntheticScenarioDescriptor } from "@meridian/core";
import type { SyntheticExecutionTrust } from "../../state/syntheticExecutionTrust";
import { useSyntheticExecutionController, type SyntheticExecutionStatus } from "./useSyntheticExecutionController";

const EDITOR_ID = "logic-synthetic-execution-editor";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function LogicSyntheticExecutionControls(props: { rootId: NodeId }) {
  const control = useSyntheticExecutionController(props.rootId, "logic");
  return (
    <div style={LOGIC_CONTROL} aria-label="Synthetic execution controls">
      <div style={LOGIC_ACTIONS}>
        <button
          type="button"
          style={SYNTHETIC_ACTION_BUTTON_STYLE}
          disabled={control.status === "running"}
          aria-expanded={control.editorOpen}
          aria-controls={EDITOR_ID}
          onClick={control.toggleEditor}
        >
          {control.buttonLabel}
        </button>
        {control.executionOpen ? (
          <button type="button" style={SECONDARY_ACTION_BUTTON_STYLE} onClick={control.clear}>
            Static flow
          </button>
        ) : null}
      </div>
      {control.editorOpen ? (
        <div id={EDITOR_ID} style={LOGIC_POPOVER}>
          {control.canGenerate ? (
            <SyntheticInputEditor
              scenario={control.scenario!}
              scenarios={control.scenarios}
              value={control.input}
              status={control.status}
              error={control.inputError ?? control.error}
              executionTrust={control.executionTrust!}
              sandboxConsent={control.sandboxConsent}
              onChange={control.setInput}
              onSandboxConsentChange={control.setSandboxConsent}
              onScenarioChange={control.selectScenario}
              onCancel={control.cancelEditor}
              onRun={control.submit}
            />
          ) : (
            <SyntheticAvailabilityNotice
              message={control.availabilityMessage ?? "Synthetic execution is unavailable for this flow."}
              onClose={control.cancelEditor}
            />
          )}
        </div>
      ) : control.error !== null ? (
        <div style={LOGIC_ERROR} role="alert">{control.error}</div>
      ) : null}
    </div>
  );
}

export function SyntheticAvailabilityNotice(props: { message: string; onClose(): void }) {
  return (
    <section style={AVAILABILITY_NOTICE} aria-label="Synthetic execution setup" role="status">
      <span style={AVAILABILITY_EYEBROW}>SYNTHETIC EXECUTION</span>
      <strong style={AVAILABILITY_TITLE}>Setup required</strong>
      <span style={AVAILABILITY_COPY}>{props.message}</span>
      <span style={AVAILABILITY_HINT}>
        The action stays visible so every Logic and PR-review flow has one consistent place to enable or configure a run.
      </span>
      <div style={AVAILABILITY_ACTIONS}>
        <button type="button" style={SECONDARY_ACTION_BUTTON_STYLE} onClick={props.onClose}>Close</button>
      </div>
    </section>
  );
}

export function SyntheticInputEditor(props: {
  scenario: SyntheticScenarioDescriptor;
  scenarios: readonly SyntheticScenarioDescriptor[];
  value: string;
  status: SyntheticExecutionStatus;
  error: string | null;
  executionTrust: SyntheticExecutionTrust;
  sandboxConsent: boolean;
  onChange(value: string): void;
  onSandboxConsentChange(consent: boolean): void;
  onScenarioChange(id: string): void;
  onCancel(): void;
  onRun(): void;
}) {
  const sandboxedPr = props.executionTrust.mode === "sandboxed-pr";
  const provenance = sandboxProvenance(props.executionTrust);
  return (
    <section style={SYNTHETIC_EDITOR} aria-label="Generate synthetic data">
      <div style={SYNTHETIC_EDITOR_COPY}>
        {props.scenarios.length > 1 ? (
          <label style={SYNTHETIC_SCENARIO_FIELD}>
            <span style={SYNTHETIC_SCENARIO_LABEL}>Scenario</span>
            <select
              style={SYNTHETIC_SCENARIO_SELECT}
              value={props.scenario.id}
              aria-label="Synthetic scenario"
              disabled={props.status === "running"}
              onChange={(event) => props.onScenarioChange(event.currentTarget.value)}
            >
              {props.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
            </select>
          </label>
        ) : null}
        <strong style={SYNTHETIC_EDITOR_TITLE}>{props.scenario.label}</strong>
        {props.scenario.description ? <span>{props.scenario.description}</span> : null}
        {sandboxedPr ? (
          <div style={SANDBOX_NOTICE} role="note" aria-label="Untrusted PR sandbox">
            <strong style={SANDBOX_TITLE}>UNTRUSTED PR SANDBOX</strong>
            {provenance === null ? null : <span style={SANDBOX_PROVENANCE}>{provenance}</span>}
            <span>
              Runs PR code in an ephemeral OCI sandbox. Network is disabled; source and root are
              read-only; there are no host credentials or writable workspace mounts; CPU, memory,
              processes, and time are bounded.
            </span>
            <span>This is untrusted code. Review the input and explicitly confirm each editor session.</span>
            <span>Results are a forgeable inspection aid from the PR, not authoritative security evidence.</span>
          </div>
        ) : (
          <span style={SYNTHETIC_TRUST}>Runs trusted local project code on this machine. Review the generated input before starting.</span>
        )}
      </div>
      <textarea
        style={SYNTHETIC_TEXTAREA}
        value={props.value}
        spellCheck={false}
        aria-label="Synthetic execution input JSON"
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      {sandboxedPr ? (
        <label style={SANDBOX_CONSENT}>
          <input
            type="checkbox"
            checked={props.sandboxConsent}
            disabled={props.status === "running"}
            onChange={(event) => props.onSandboxConsentChange(event.currentTarget.checked)}
          />
          <span>I understand this runs untrusted PR code in the isolated sandbox.</span>
        </label>
      ) : null}
      <div style={SYNTHETIC_EDITOR_FOOTER}>
        {props.error ? <span style={SYNTHETIC_ERROR_STYLE} role="alert">{props.error}</span> : <span />}
        <button type="button" style={SYNTHETIC_CANCEL} disabled={props.status === "running"} onClick={props.onCancel}>Cancel</button>
        <button type="button" style={SYNTHETIC_RUN} disabled={props.status === "running" || (sandboxedPr && !props.sandboxConsent)} onClick={props.onRun}>
          {props.status === "running" ? "Running…" : "Run scenario"}
        </button>
      </div>
    </section>
  );
}

function sandboxProvenance(trust: SyntheticExecutionTrust): string | null {
  const repository = trust.provenance?.repository;
  const headSha = trust.provenance?.headSha;
  if (repository && headSha) return `${repository} · ${headSha.slice(0, 12)}`;
  return repository ?? (headSha ? `PR head ${headSha.slice(0, 12)}` : null);
}

export const SECONDARY_ACTION_BUTTON_STYLE: React.CSSProperties = {
  border: "1px solid #2A313D",
  borderRadius: 5,
  background: "#151B24",
  color: "#C9D3E0",
  padding: "4px 8px",
  fontSize: 12,
  cursor: "pointer",
};

export const SYNTHETIC_ACTION_BUTTON_STYLE: React.CSSProperties = {
  ...SECONDARY_ACTION_BUTTON_STYLE,
  borderColor: "#3D6F60",
  background: "rgba(88,201,163,0.10)",
  color: "#78D8B7",
};

export const SYNTHETIC_ERROR_STYLE: React.CSSProperties = {
  minWidth: 0,
  color: "#E7A0A4",
  fontFamily: MONO,
  fontSize: 9.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const LOGIC_CONTROL: React.CSSProperties = { position: "relative", pointerEvents: "auto" };
const LOGIC_ACTIONS: React.CSSProperties = { display: "flex", justifyContent: "center", gap: 6 };
const LOGIC_POPOVER: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(760px, calc(100vw - 40px))",
  padding: 8,
  border: "1px solid #273A36",
  borderRadius: 9,
  background: "rgba(8,12,17,0.97)",
  boxShadow: "0 14px 40px rgba(0,0,0,0.45)",
};
const LOGIC_ERROR: React.CSSProperties = { ...SYNTHETIC_ERROR_STYLE, position: "absolute", top: "calc(100% + 7px)", left: "50%", transform: "translateX(-50%)", maxWidth: 520, padding: "6px 9px", border: "1px solid #5B353B", borderRadius: 6, background: "rgba(30,13,17,0.96)" };
const AVAILABILITY_NOTICE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 12, border: "1px solid #3C4A58", borderRadius: 7, background: "#0C1219", color: "#A8B5C3", fontFamily: MONO, fontSize: 10, lineHeight: 1.45 };
const AVAILABILITY_EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 8.5, fontWeight: 800, letterSpacing: "0.09em" };
const AVAILABILITY_TITLE: React.CSSProperties = { color: "#E1E9F1", fontSize: 12 };
const AVAILABILITY_COPY: React.CSSProperties = { maxWidth: 660 };
const AVAILABILITY_HINT: React.CSSProperties = { color: "#748292", fontSize: 9 };
const AVAILABILITY_ACTIONS: React.CSSProperties = { display: "flex", justifyContent: "flex-end", marginTop: 3 };
const SYNTHETIC_EDITOR: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(240px, 0.75fr) minmax(280px, 1.25fr)", gap: 10, alignItems: "stretch", padding: 10, border: "1px solid #315B50", borderRadius: 7, background: "rgba(12,22,21,0.92)" };
const SYNTHETIC_EDITOR_COPY: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, color: "#91A49F", fontFamily: MONO, fontSize: 9.5, lineHeight: 1.4 };
const SYNTHETIC_EDITOR_TITLE: React.CSSProperties = { color: "#D8E9E2", fontSize: 11 };
const SYNTHETIC_SCENARIO_FIELD: React.CSSProperties = { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "center", gap: 7, marginBottom: 2 };
const SYNTHETIC_SCENARIO_LABEL: React.CSSProperties = { color: "#6F8A82", fontSize: 8, fontWeight: 750, letterSpacing: "0.07em", textTransform: "uppercase" };
const SYNTHETIC_SCENARIO_SELECT: React.CSSProperties = { minWidth: 0, border: "1px solid #344D47", borderRadius: 5, outline: "none", background: "#0A1112", color: "#C8D9D3", padding: "4px 6px", fontFamily: MONO, fontSize: 9 };
const SYNTHETIC_TRUST: React.CSSProperties = { marginTop: 3, color: "#D4B56A" };
const SANDBOX_NOTICE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginTop: 4, padding: 8, border: "1px solid #8B6332", borderRadius: 5, background: "rgba(107,67,24,0.18)", color: "#D8C39B" };
const SANDBOX_TITLE: React.CSSProperties = { color: "#F2BE68", fontSize: 10, letterSpacing: "0.08em" };
const SANDBOX_PROVENANCE: React.CSSProperties = { color: "#E2D5BD", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const SANDBOX_CONSENT: React.CSSProperties = { gridColumn: "1 / -1", display: "flex", alignItems: "flex-start", gap: 7, padding: "7px 8px", border: "1px solid #59472E", borderRadius: 5, background: "rgba(84,57,24,0.15)", color: "#E4D3B3", fontFamily: MONO, fontSize: 9.5, lineHeight: 1.35, cursor: "pointer" };
const SYNTHETIC_TEXTAREA: React.CSSProperties = { minHeight: 84, maxHeight: 150, resize: "vertical", boxSizing: "border-box", border: "1px solid #34433F", borderRadius: 5, outline: "none", background: "#090F11", color: "#C8D9D3", padding: "7px 8px", fontFamily: MONO, fontSize: 9.5, lineHeight: 1.4 };
const SYNTHETIC_EDITOR_FOOTER: React.CSSProperties = { gridColumn: "1 / -1", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 7, alignItems: "center" };
const SYNTHETIC_CANCEL: React.CSSProperties = { ...SECONDARY_ACTION_BUTTON_STYLE, padding: "4px 10px" };
const SYNTHETIC_RUN: React.CSSProperties = { ...SYNTHETIC_ACTION_BUTTON_STYLE, padding: "4px 10px" };
