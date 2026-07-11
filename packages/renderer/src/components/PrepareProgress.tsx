/** A reusable staged-progress indicator for long-running preparation flows. */

export interface PrepareProgressStep<Id extends string> {
  id: Id;
  label: string;
}

export interface PrepareProgressProps<Id extends string> {
  /** Accessible operation name; also rendered as the card heading. */
  title: string;
  /** At least one step is required so an absent/unknown active id has a safe first-step fallback. */
  steps: readonly [PrepareProgressStep<Id>, ...PrepareProgressStep<Id>[]];
  activeStep: Id | null;
  variant?: "card" | "inline";
  style?: React.CSSProperties;
  actions?: React.ReactNode;
}

type StepState = "done" | "active" | "pending";

export function PrepareProgress<Id extends string>(props: PrepareProgressProps<Id>) {
  const activeIndex = activeIndexOf(props.steps, props.activeStep);
  if (props.variant === "inline") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ ...INLINE_ROW, ...props.style }}
      >
        <span aria-hidden="true" data-state="active" style={stepDot("active")} />
        <span style={INLINE_LABEL}>
          <span style={SCREEN_READER_ONLY}>{props.title}: </span>
          {props.steps[activeIndex].label}
        </span>
      </div>
    );
  }

  return (
    <section style={{ ...CARD, ...props.style }}>
      <span role="status" aria-live="polite" aria-atomic="true" style={SCREEN_READER_ONLY}>
        {props.title}: {props.steps[activeIndex].label}
      </span>
      <div style={CARD_TITLE}>{props.title}</div>
      <ol style={STEP_LIST}>
        {props.steps.map((entry, index) => {
          const state = stepState(index, activeIndex);
          return (
            <li key={entry.id} data-state={state} aria-current={state === "active" ? "step" : undefined} style={STEP_ROW}>
              <span aria-hidden="true" data-state={state} style={stepDot(state)} />
              <span style={stepLabel(state)}>{entry.label}</span>
            </li>
          );
        })}
      </ol>
      {props.actions}
    </section>
  );
}

function activeIndexOf<Id extends string>(
  steps: readonly [PrepareProgressStep<Id>, ...PrepareProgressStep<Id>[]],
  activeStep: Id | null,
): number {
  const index = activeStep === null ? -1 : steps.findIndex((entry) => entry.id === activeStep);
  return index >= 0 ? index : 0;
}

function stepState(index: number, activeIndex: number): StepState {
  if (index < activeIndex) {
    return "done";
  }
  return index === activeIndex ? "active" : "pending";
}

function stepDot(state: StepState): React.CSSProperties {
  const colors: Record<StepState, string> = { done: "#56C271", active: "#388BFD", pending: "#2A2F37" };
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    flexShrink: 0,
    background: colors[state],
    boxShadow: state === "active" ? "0 0 0 4px rgba(56,139,253,0.2)" : "none",
  };
}

function stepLabel(state: StepState): React.CSSProperties {
  return {
    fontSize: 13.5,
    color: state === "pending" ? "#8B949E" : "#E6EDF3",
    fontWeight: state === "active" ? 650 : 500,
  };
}

const CARD: React.CSSProperties = {
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "#0B0F14",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const CARD_TITLE: React.CSSProperties = { color: "#F0F6FC", fontSize: 13.5, fontWeight: 650 };
const INLINE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const INLINE_LABEL: React.CSSProperties = { fontSize: 12, color: "#E6EDF3", fontWeight: 550 };
const STEP_LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 };
const STEP_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const SCREEN_READER_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
