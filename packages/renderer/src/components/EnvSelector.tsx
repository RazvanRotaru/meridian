/**
 * The mandatory environment gate (rendered whenever `hasOverlay`).
 *
 * It opens with NO selection applied — the store's `environment` stays null until the reader
 * actively loads one. `preselectedEnv` only PRE-FILLS the visible dropdown; it never bypasses
 * the explicit "Load" step, and prod (though listable) is never auto-applied. Telemetry is
 * fetched only after `setEnvironment`, so `refreshTelemetry`'s null-guard is never tripped.
 */

import { useState } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

const PLACEHOLDER = "— select environment —";

export function EnvSelector(props: { preselectedEnv: string | null }) {
  const provider = useBlueprint((state) => state.provider);
  const applied = useBlueprint((state) => state.environment);
  const actions = useBlueprintActions();
  // Seed the dropdown from an already-applied env (e.g. one restored from the URL) so a shared
  // link shows its environment selected; the lazy initializer captures it once at mount.
  const [pending, setPending] = useState(() => applied ?? props.preselectedEnv ?? "");
  if (!provider) {
    return null;
  }
  const load = () => applyEnvironment(pending, actions.setEnvironment, actions.refreshTelemetry);
  return (
    <div style={ROW_STYLE}>
      <label style={LABEL_STYLE}>Environment</label>
      <select style={SELECT_STYLE} value={pending} onChange={(event) => setPending(event.target.value)}>
        <option value="">{PLACEHOLDER}</option>
        {provider.listEnvironments().map((environment) => (
          <option key={environment} value={environment}>
            {environment}
          </option>
        ))}
      </select>
      <button type="button" style={loadStyle(pending === "")} disabled={pending === ""} onClick={load}>
        Load telemetry
      </button>
      <span style={STATUS_STYLE}>{applied ? `loaded: ${applied}` : "no telemetry"}</span>
    </div>
  );
}

function applyEnvironment(
  pending: string,
  setEnvironment: (environment: string) => void,
  refreshTelemetry: () => Promise<void>,
): void {
  if (pending === "") {
    return;
  }
  setEnvironment(pending);
  void refreshTelemetry();
}

const ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const LABEL_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", textTransform: "uppercase" };
const SELECT_STYLE: React.CSSProperties = {
  background: "#11151B",
  color: "#E6EDF3",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};
const STATUS_STYLE: React.CSSProperties = { fontSize: 11, color: "#6E7681" };

function loadStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#1A1F27" : "#21303B",
    color: disabled ? "#5A6573" : "#7FD0DD",
    border: "1px solid #2A3742",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
