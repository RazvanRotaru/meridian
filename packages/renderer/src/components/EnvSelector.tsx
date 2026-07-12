/**
 * Persistent request-data gate for the control panel.
 *
 * Source and environment selection are deliberately separate from loading. Changing either select
 * only updates configuration/pending UI; the explicit Load/Refresh button is the sole fetch trigger.
 * A one-environment synthetic source may be visibly prefilled, but is never silently applied.
 */

import { useEffect, useMemo, useState } from "react";
import { telemetryEnvironmentSchema } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { TOKENS } from "./controlpanel/panelKit";

const ENV_PLACEHOLDER = "Choose environment…";
const ENV_SUGGESTIONS_ID = "meridian-telemetry-environment-suggestions";

export function EnvSelector(props: { preselectedEnv: string | null; ariaLabel?: string }) {
  const sources = useBlueprint((state) => state.telemetrySources);
  const sourceId = useBlueprint((state) => state.telemetrySourceId);
  const provider = useBlueprint((state) => state.provider);
  const applied = useBlueprint((state) => state.environment);
  const metricsLoading = useBlueprint((state) => state.telemetryLoading);
  const tracesLoading = useBlueprint((state) => state.traceLoading);
  const metricsError = useBlueprint((state) => state.telemetryError);
  const tracesError = useBlueprint((state) => state.traceError);
  const actions = useBlueprintActions();
  const selectedSource = useMemo(
    () => sources.find((source) => source.id === sourceId) ?? null,
    [sourceId, sources],
  );
  const environments = selectedSource?.environments ?? provider?.listEnvironments() ?? [];
  const arbitraryEnvironment = selectedSource?.environmentMode === "arbitrary";
  const [pending, setPending] = useState(() => suggestedEnvironment(environments, applied, props.preselectedEnv));
  const loading = metricsLoading || tracesLoading;
  const error = tracesError ?? metricsError;
  const parsedPendingEnvironment = telemetryEnvironmentSchema.safeParse(pending);
  const pendingEnvironment = parsedPendingEnvironment.success ? parsedPendingEnvironment.data : "";

  // A source change is configuration only. Keep the next explicit Load convenient, while never
  // calling setEnvironment/refreshTelemetry from this synchronization effect.
  useEffect(() => {
    setPending(suggestedEnvironment(environments, applied, props.preselectedEnv));
  }, [sourceId, applied, props.preselectedEnv, environmentKey(environments)]);

  const load = () => {
    if (!selectedSource || pendingEnvironment === "") return;
    if (applied !== pendingEnvironment) actions.setEnvironment(pendingEnvironment);
    void actions.refreshTelemetry();
  };
  const refresh = applied !== null && applied === pendingEnvironment;

  return (
    <section style={SECTION} aria-label={props.ariaLabel ?? "Request data"}>
      <div style={SECTION_HEADER}>
        <span style={SECTION_TITLE}>Request data</span>
        <span style={STATUS} role="status" aria-live="polite">
          {loading ? "Loading…" : applied ? `Loaded · ${applied}` : "Not loaded"}
        </span>
      </div>

      <label style={FIELD_LABEL}>
        Source
        <select
          style={SELECT}
          value={sourceId ?? ""}
          onChange={(event) => actions.setTelemetrySource(event.target.value || null)}
          aria-label="Request data source"
        >
          <option value="">Off</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>{source.label}</option>
          ))}
        </select>
      </label>

      <label style={FIELD_LABEL}>
        Environment
        {arbitraryEnvironment ? (
          <>
            <input
              style={SELECT}
              value={pending}
              list={ENV_SUGGESTIONS_ID}
              placeholder={ENV_PLACEHOLDER}
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPending(event.target.value)}
              aria-label="Request data environment"
            />
            <datalist id={ENV_SUGGESTIONS_ID}>
              {environments.map((environment) => <option key={environment} value={environment} />)}
            </datalist>
          </>
        ) : (
          <select
            style={SELECT}
            value={pending}
            disabled={selectedSource === null}
            onChange={(event) => setPending(event.target.value)}
            aria-label="Request data environment"
          >
            <option value="">{selectedSource ? ENV_PLACEHOLDER : "Choose a source first…"}</option>
            {environments.map((environment) => (
              <option key={environment} value={environment}>{environment}</option>
            ))}
          </select>
        )}
      </label>

      <div style={ACTION_ROW}>
        <button
          type="button"
          style={loadStyle(selectedSource === null || pendingEnvironment === "" || loading)}
          disabled={selectedSource === null || pendingEnvironment === "" || loading}
          onClick={load}
        >
          {loading ? "Loading…" : refresh ? "Refresh" : "Load"}
        </button>
        <span style={HELP}>{selectedSource ? "Nothing loads automatically." : "Select a source to begin."}</span>
      </div>
      {error ? <div style={ERROR} role="alert">{error}</div> : null}
    </section>
  );
}

function suggestedEnvironment(environments: string[], applied: string | null, preselected: string | null): string {
  if (applied !== null && environments.includes(applied)) return applied;
  if (preselected !== null && environments.includes(preselected)) return preselected;
  return environments.length === 1 ? environments[0]! : "";
}

function environmentKey(environments: string[]): string {
  return environments.join("\u0000");
}

const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const SECTION_HEADER: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 };
const SECTION_TITLE: React.CSSProperties = { color: TOKENS.label, fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase" };
const STATUS: React.CSSProperties = { color: TOKENS.textDim, fontSize: 9.5 };
const FIELD_LABEL: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, color: TOKENS.textMuted, fontSize: 9, letterSpacing: "0.07em", textTransform: "uppercase" };
const SELECT: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: TOKENS.pillBg,
  color: TOKENS.text,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10.5,
  textTransform: "none",
  letterSpacing: 0,
};
const ACTION_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const HELP: React.CSSProperties = { color: TOKENS.textDim, fontSize: 8.5, lineHeight: 1.35 };
const ERROR: React.CSSProperties = { border: "1px solid #6E3438", borderRadius: 6, background: "rgba(240,120,124,0.06)", color: "#D99A9E", padding: "6px 7px", fontSize: 9, lineHeight: 1.4 };

function loadStyle(disabled: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    background: disabled ? "#1A1F27" : "#21303B",
    color: disabled ? "#5A6573" : "#7FD0DD",
    border: "1px solid #2A3742",
    borderRadius: 6,
    padding: "5px 10px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
