import { TOKENS } from "../controlpanel/panelKit";
import type { SyntheticFlowStep } from "../../synthetic/syntheticFlowModel";

export type { SyntheticFlowStep } from "../../synthetic/syntheticFlowModel";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** One already-derived runtime occurrence in capture order. The component deliberately does not
 * infer a path from timestamps or static callers: its caller only supplies the ordered occurrences
 * that belong to the selected synthetic run. */
export interface SyntheticFlowOption extends SyntheticFlowStep {
  captureIndex: number;
  occurrenceIndex: number;
  occurrenceCount: number;
  displayLabel: string;
}

export interface SyntheticFlowNavigatorProps {
  steps: readonly SyntheticFlowStep[];
  selectedId: string | null;
  scenarioLabel: string;
  rootLabel: string;
  onSelect(id: string): void;
  onPrevious(): void;
  onNext(): void;
}

/** Add occurrence ordinals without disturbing the caller-provided capture order. Artifact id owns
 * repetition; two unrelated callables that happen to share a display name remain unnumbered. */
export function syntheticFlowOptions(steps: readonly SyntheticFlowStep[]): SyntheticFlowOption[] {
  const totals = new Map<string, number>();
  for (const step of steps) {
    const key = occurrenceKey(step);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return steps.map((step, captureIndex) => {
    const key = occurrenceKey(step);
    const occurrenceIndex = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrenceIndex);
    const occurrenceCount = totals.get(key) ?? 1;
    return {
      ...step,
      captureIndex,
      occurrenceIndex,
      occurrenceCount,
      displayLabel: occurrenceCount > 1
        ? `${step.label} · occurrence ${occurrenceIndex} of ${occurrenceCount}`
        : step.label,
    };
  });
}

/** A stale/missing controlled selection falls back to the first captured occurrence for display.
 * The parent still owns selection and may immediately commit that id if it wants URL/store parity. */
export function selectedSyntheticFlowIndex(
  options: readonly Pick<SyntheticFlowOption, "id">[],
  selectedId: string | null,
): number {
  if (options.length === 0) return -1;
  const selectedIndex = selectedId === null ? -1 : options.findIndex((option) => option.id === selectedId);
  return selectedIndex < 0 ? 0 : selectedIndex;
}

export function SyntheticFlowNavigator(props: SyntheticFlowNavigatorProps) {
  const options = syntheticFlowOptions(props.steps);
  const selectedIndex = selectedSyntheticFlowIndex(options, props.selectedId);
  const selected = selectedIndex < 0 ? null : options[selectedIndex]!;
  const count = options.length;
  const previousDisabled = selectedIndex <= 0;
  const nextDisabled = selectedIndex < 0 || selectedIndex >= count - 1;
  const callerPath = selected === null
    ? []
    : [...selected.callerBreadcrumb, selected.displayLabel];

  return (
    <section
      style={ROOT}
      aria-label="Synthetic flow navigator"
      data-synthetic-flow-navigator="true"
    >
      <div style={SCOPE} aria-label={`Synthetic scenario ${props.scenarioLabel}; root ${props.rootLabel}`}>
        <span style={EYEBROW}>SYNTHETIC RUN</span>
        <span style={SCENARIO} title={props.scenarioLabel}>{props.scenarioLabel}</span>
        <span style={SCOPE_SEPARATOR}>·</span>
        <span style={ROOT_LABEL} title={props.rootLabel}>{props.rootLabel}</span>
      </div>

      <div style={CONTROL_ROW}>
        <button
          type="button"
          style={navButtonStyle(previousDisabled)}
          disabled={previousDisabled}
          aria-label="Previous synthetic flow"
          title="Previous captured flow"
          onClick={props.onPrevious}
        >
          ‹
        </button>
        <select
          style={SELECT}
          value={selected?.id ?? ""}
          disabled={count === 0}
          aria-label="Synthetic flow selection"
          onChange={(event) => props.onSelect(event.currentTarget.value)}
        >
          {count === 0 ? <option value="">No captured flows</option> : null}
          {options.map((option) => (
            <option
              key={option.id}
              value={option.id}
              data-synthetic-step-id={option.id}
            >
              {option.displayLabel}
            </option>
          ))}
        </select>
        <span
          style={POSITION}
          aria-label={`Capture order ${selectedIndex < 0 ? 0 : selectedIndex + 1} of ${count}`}
        >
          {selectedIndex < 0 ? 0 : selectedIndex + 1} of {count}
        </span>
        <button
          type="button"
          style={navButtonStyle(nextDisabled)}
          disabled={nextDisabled}
          aria-label="Next synthetic flow"
          title="Next captured flow"
          onClick={props.onNext}
        >
          ›
        </button>
      </div>

      {selected === null ? (
        <div style={EMPTY}>No runtime flows were captured for this synthetic run.</div>
      ) : (
        <nav
          style={BREADCRUMB}
          aria-label={`Caller breadcrumb: ${callerPath.join(" to ")}`}
          data-synthetic-selected-step-id={selected.id}
        >
          <span style={BREADCRUMB_LABEL}>Caller path</span>
          {callerPath.map((label, index) => (
            <span key={`${index}:${label}`} style={BREADCRUMB_ITEM}>
              {index === 0 ? null : <span style={BREADCRUMB_SEPARATOR}>›</span>}
              <span style={index === callerPath.length - 1 ? BREADCRUMB_CURRENT : undefined}>{label}</span>
            </span>
          ))}
        </nav>
      )}
    </section>
  );
}

function occurrenceKey(step: SyntheticFlowStep): string {
  // An unmapped occurrence has no safe callable identity. Keep it occurrence-unique rather than
  // grouping unrelated external spans merely because their producer labels happen to match.
  return step.nodeId ?? `unmapped:${step.id}`;
}

const ROOT: React.CSSProperties = {
  display: "grid",
  gap: 7,
  minWidth: 0,
  padding: "8px 10px",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 8,
  background: "rgba(12, 17, 23, 0.94)",
  color: TOKENS.text,
};

const SCOPE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 10,
};

const EYEBROW: React.CSSProperties = {
  flexShrink: 0,
  color: "#58C9A3",
  fontSize: 8.5,
  fontWeight: 750,
  letterSpacing: "0.09em",
};

const SCENARIO: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#C9D8D3",
  fontWeight: 650,
};

const SCOPE_SEPARATOR: React.CSSProperties = { color: "#44505D", flexShrink: 0 };
const ROOT_LABEL: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: TOKENS.textMuted,
};

const CONTROL_ROW: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "28px minmax(0, 1fr) auto 28px",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const SELECT: React.CSSProperties = {
  minWidth: 0,
  width: "100%",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 6,
  outline: "none",
  background: TOKENS.pillBg,
  color: TOKENS.text,
  padding: "6px 8px",
  fontFamily: MONO,
  fontSize: 10.5,
};

const POSITION: React.CSSProperties = {
  minWidth: 42,
  color: TOKENS.textMuted,
  fontFamily: MONO,
  fontSize: 9.5,
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
  whiteSpace: "nowrap",
};

function navButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 29,
    padding: 0,
    border: `1px solid ${TOKENS.surfaceBorder}`,
    borderRadius: 6,
    background: TOKENS.pillBg,
    color: disabled ? TOKENS.textDim : "#78D8B7",
    fontFamily: MONO,
    fontSize: 18,
    lineHeight: "25px",
    cursor: disabled ? "default" : "pointer",
  };
}

const BREADCRUMB: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  minWidth: 0,
  overflow: "hidden",
  fontFamily: MONO,
  fontSize: 9.5,
  whiteSpace: "nowrap",
};

const BREADCRUMB_LABEL: React.CSSProperties = {
  flexShrink: 0,
  color: TOKENS.label,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

const BREADCRUMB_ITEM: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minWidth: 0,
  color: TOKENS.textMuted,
};

const BREADCRUMB_SEPARATOR: React.CSSProperties = { color: "#44505D" };
const BREADCRUMB_CURRENT: React.CSSProperties = { color: "#D9E9E4", fontWeight: 650 };
const EMPTY: React.CSSProperties = { color: TOKENS.textDim, fontFamily: MONO, fontSize: 9.5 };
