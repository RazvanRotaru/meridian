import type { NodeAsyncState, NodeSemanticModel } from "../../nodeSemantics";
import { displayNodeKind, semanticStateLabel, SEMANTIC_STATE_TEXT_MAX_WIDTH } from "../../nodeSemantics";

/** Stable identity marker rendered beside every BaseNode label. */
export function NodeKindBadge({ kind }: { kind: string }) {
  const label = displayNodeKind(kind);
  return (
    <span
      style={KIND_BADGE}
      title={`Node kind: ${label.toLowerCase()}`}
      aria-label={`Node kind: ${label.toLowerCase()}`}
      data-node-kind-label={kind}
    >
      {label}
    </span>
  );
}

/**
 * Declaration and invocation semantics occupy one predictable, non-interactive rail. Utility
 * actions and disclosure live after this component, so semantics never disappear when a card turns
 * into a frame and never compete with source/expand controls for ordering.
 */
export function NodeSemanticRail({ semantics }: { semantics: NodeSemanticModel | undefined }) {
  if (!semantics) return null;
  const state = semantics.asyncState;
  const stateLabel = state ? semanticStateLabel(state, semantics.returnsPromise === true) : null;
  return (
    <span style={SEMANTIC_RAIL} data-node-semantic-rail="true">
      {semantics.modifiers?.map((modifier) => (
        <span
          key={modifier}
          style={MODIFIER_CHIP}
          title={`${modifier} declaration`}
          data-node-semantic-modifier={modifier}
        >
          {modifier.toUpperCase()}
        </span>
      ))}
      {(semantics.returnsPromise || stateLabel) ? (
        <span
          style={stateGroupStyle(state)}
          title={semanticExplanation(semantics)}
          aria-label={semanticExplanation(semantics)}
          data-node-semantic-result={semantics.returnsPromise ? "promise" : undefined}
          data-node-semantic-state={state?.kind}
        >
          {semantics.returnsPromise ? <span style={RESULT_SEGMENT}>PROMISE</span> : null}
          {stateLabel ? (
            <span style={semantics.returnsPromise ? STATE_SEGMENT : RESULT_SEGMENT}>{stateLabel}</span>
          ) : null}
        </span>
      ) : null}
      {semantics.nestedNotAwaited ? (
        <span
          style={NESTED_WARNING}
          title={`${semantics.nestedNotAwaited} ${semantics.nestedNotAwaited === 1 ? "promise is" : "promises are"} not awaited inside this callable`}
          aria-label={`${semantics.nestedNotAwaited} not awaited inside`}
          data-node-semantic-nested-not-awaited={semantics.nestedNotAwaited}
        >
          {semantics.nestedNotAwaited} NOT AWAITED INSIDE
        </span>
      ) : null}
      {semantics.nestedResultsDropped ? (
        <span
          style={NESTED_WARNING}
          title={`${semantics.nestedResultsDropped} call ${semantics.nestedResultsDropped === 1 ? "result is" : "results are"} explicitly dropped inside this callable; Promise-ness is not proven`}
          aria-label={`${semantics.nestedResultsDropped} ${semantics.nestedResultsDropped === 1 ? "result" : "results"} dropped inside`}
          data-node-semantic-nested-results-dropped={semantics.nestedResultsDropped}
        >
          {semantics.nestedResultsDropped} {semantics.nestedResultsDropped === 1 ? "RESULT" : "RESULTS"} DROPPED INSIDE
        </span>
      ) : null}
    </span>
  );
}

function semanticExplanation(semantics: NodeSemanticModel): string {
  const declaration = semantics.modifiers?.includes("async") ? "Async declaration" : null;
  const result = semantics.returnsPromise ? "Returns a Promise" : null;
  const state = semantics.asyncState ? stateExplanation(semantics.asyncState, semantics.returnsPromise === true) : null;
  return [declaration, result, state].filter(Boolean).join(" · ");
}

function stateExplanation(state: NodeAsyncState, returnsPromise: boolean): string {
  if (state.kind === "awaited") return "This call is awaited";
  if (state.kind === "launched") return state.binding
    ? `Promise launched as ${state.binding}; execution continues and it may be joined later`
    : "Promise launched; execution continues and it may be joined later";
  if (state.kind === "detached") return returnsPromise
    ? "This Promise is explicitly not awaited in this flow"
    : "This call result is explicitly dropped";
  if (state.kind === "barrier") return `Waits for ${state.taskCount} tasks with Promise.${state.mode}`;
  return `Waits for ${state.taskCount} ${state.taskCount === 1 ? "task" : "tasks"}`;
}

const KIND_BADGE: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: 76,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  border: "1px solid rgba(200,211,224,0.32)",
  borderRadius: 3,
  padding: "1px 4px",
  background: "rgba(11,14,19,0.34)",
  color: "#D6DEE8",
  fontSize: 7.5,
  fontWeight: 750,
  lineHeight: 1.15,
  letterSpacing: "0.055em",
  opacity: 0.88,
};

const SEMANTIC_RAIL: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
};

const CHIP_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  overflow: "hidden",
  borderRadius: 3,
  background: "rgba(11,14,19,0.58)",
  whiteSpace: "nowrap",
  fontSize: 7.5,
  fontWeight: 750,
  lineHeight: 1.15,
  letterSpacing: "0.035em",
};

const MODIFIER_CHIP: React.CSSProperties = {
  ...CHIP_BASE,
  border: "1px solid rgba(200,211,224,0.28)",
  padding: "1px 4px",
  color: "#D6DEE8",
};

const RESULT_SEGMENT: React.CSSProperties = { padding: "1px 4px" };
const STATE_SEGMENT: React.CSSProperties = {
  display: "inline-block",
  minWidth: 0,
  maxWidth: SEMANTIC_STATE_TEXT_MAX_WIDTH,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  padding: "1px 4px",
  borderLeft: "1px solid currentColor",
};

const NESTED_WARNING: React.CSSProperties = {
  ...CHIP_BASE,
  border: "1px solid rgba(155,123,216,0.62)",
  padding: "1px 4px",
  background: "rgba(87,55,118,0.58)",
  color: "#E1D2F5",
};

function stateGroupStyle(state: NodeAsyncState | undefined): React.CSSProperties {
  const detached = state?.kind === "detached";
  const launched = state?.kind === "launched";
  return {
    ...CHIP_BASE,
    border: `1px solid ${detached ? "rgba(155,123,216,0.78)" : "rgba(78,195,207,0.62)"}`,
    background: detached
      ? "rgba(87,55,118,0.66)"
      : launched
        ? "rgba(25,72,80,0.42)"
        : "rgba(19,76,83,0.58)",
    color: detached ? "#E1D2F5" : "#B8EDF1",
  };
}
