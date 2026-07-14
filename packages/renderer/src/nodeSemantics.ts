import type { FlowCallAsync, FlowStep, GraphNode } from "@meridian/core";

/** High-signal declaration modifiers that belong in a compact graph-node header. */
export type NodeSemanticModifier = "async" | "generator" | "static" | "abstract" | "readonly";

/** Invocation state is occurrence-specific. It must never be inferred from declaration metadata. */
export type NodeAsyncState =
  | { kind: "awaited" }
  | { kind: "launched"; binding?: string }
  | { kind: "detached" }
  | { kind: "barrier"; mode: "all" | "allSettled"; taskCount: number }
  | { kind: "await"; taskCount: number };

/**
 * Semantic facts rendered by the shared BaseNode chrome.
 *
 * Declaration facts (`modifiers`, `returnsPromise`) describe the target callable. `asyncState`
 * describes this one call occurrence. Keeping those lanes separate prevents an async declaration
 * from being mislabeled as awaited, and prevents an ordinary Promise launch from being mislabeled
 * as fire-and-forget.
 */
export interface NodeSemanticModel {
  modifiers?: NodeSemanticModifier[];
  returnsPromise?: boolean;
  asyncState?: NodeAsyncState;
  /** Detached calls inside a callee, not a property of the parent invocation itself. */
  nestedNotAwaited?: number;
  /** Explicitly discarded call results inside a callee when Promise-ness is not proven. */
  nestedResultsDropped?: number;
}

const MODIFIER_ORDER: readonly NodeSemanticModifier[] = ["async", "generator", "static", "abstract", "readonly"];

/** Paint/layout contract for occurrence text with extractor-provided payloads (notably bindings). */
export const SEMANTIC_STATE_TEXT_MAX_WIDTH = 142;

/** Declaration semantics preserved from the artifact instead of reconstructed in React. */
export function declarationSemantics(node: GraphNode | undefined): NodeSemanticModel | undefined {
  if (!node) return undefined;
  const tags = new Set(node.tags ?? []);
  const modifiers = MODIFIER_ORDER.filter((modifier) => tags.has(modifier));
  // `async` is kept separate from result type. In particular, an async generator returns an async
  // iterator rather than a Promise, and older artifacts do not retain enough syntax to distinguish
  // every generator. Only an explicit direct Promise return is strong enough to paint PROMISE.
  const returnsPromise = tags.has("returns-promise") || explicitPromiseReturn(node.signature);
  if (modifiers.length === 0 && !returnsPromise) return undefined;
  return {
    ...(modifiers.length > 0 ? { modifiers: [...modifiers] } : {}),
    ...(returnsPromise ? { returnsPromise: true } : {}),
  };
}

/** Whether this call's result is known to be Promise-valued. This is intentionally conservative:
 * a launch/barrier event is extractor proof, while legacy flows can still inherit the fact from
 * the resolved declaration. `detached` by itself only says the result was discarded. */
export function callReturnsPromise(
  step: Extract<FlowStep, { kind: "call" }>,
  target: GraphNode | undefined,
): boolean {
  return step.async?.kind === "launch"
    || step.async?.kind === "barrier"
    || declarationSemantics(target)?.returnsPromise === true;
}

/** Occurrence semantics from an extracted call. Absence means unknown/plain, never "not awaited". */
export function callOccurrenceSemantics(input: {
  awaited?: boolean;
  detached?: boolean;
  async?: FlowCallAsync;
}): NodeSemanticModel | undefined {
  const event = input.async;
  let asyncState: NodeAsyncState | undefined;
  if (input.detached) {
    asyncState = { kind: "detached" };
  } else if (event?.kind === "barrier") {
    asyncState = { kind: "barrier", mode: event.mode, taskCount: event.inputs.length };
  } else if (event?.kind === "direct-await" || input.awaited) {
    asyncState = { kind: "awaited" };
  } else if (event?.kind === "launch") {
    asyncState = { kind: "launched", ...(event.binding ? { binding: event.binding } : {}) };
  }
  if (!asyncState && !event) return undefined;
  const promiseProven = event?.kind === "launch" || event?.kind === "barrier";
  return {
    // Launches and Promise barriers are type-checked Promise work. A direct `await` is not proof:
    // JavaScript deliberately permits awaiting ordinary values.
    ...(promiseProven ? { returnsPromise: true } : {}),
    ...(asyncState ? { asyncState } : {}),
  };
}

export function awaitSemantics(taskCount: number): NodeSemanticModel {
  return { asyncState: { kind: "await", taskCount } };
}

export function mergeNodeSemantics(
  ...models: Array<NodeSemanticModel | undefined>
): NodeSemanticModel | undefined {
  const modifiers = new Set<NodeSemanticModifier>();
  let returnsPromise = false;
  let asyncState: NodeAsyncState | undefined;
  let nestedNotAwaited: number | undefined;
  let nestedResultsDropped: number | undefined;
  for (const model of models) {
    if (!model) continue;
    model.modifiers?.forEach((modifier) => modifiers.add(modifier));
    returnsPromise ||= model.returnsPromise === true;
    asyncState = model.asyncState ?? asyncState;
    nestedNotAwaited = model.nestedNotAwaited ?? nestedNotAwaited;
    nestedResultsDropped = model.nestedResultsDropped ?? nestedResultsDropped;
  }
  if (modifiers.size === 0 && !returnsPromise && !asyncState && !nestedNotAwaited && !nestedResultsDropped) return undefined;
  return {
    ...(modifiers.size > 0 ? { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)) } : {}),
    ...(returnsPromise ? { returnsPromise: true } : {}),
    ...(asyncState ? { asyncState } : {}),
    ...(nestedNotAwaited ? { nestedNotAwaited } : {}),
    ...(nestedResultsDropped ? { nestedResultsDropped } : {}),
  };
}

/** Labels are shared by paint and layout so semantic chrome cannot silently clip names. */
export function semanticLabels(model: NodeSemanticModel | undefined): string[] {
  if (!model) return [];
  const labels = (model.modifiers ?? []).map((modifier) => modifier.toUpperCase());
  if (model.returnsPromise) labels.push("PROMISE");
  if (model.asyncState) labels.push(semanticStateLabel(model.asyncState, model.returnsPromise === true));
  if (model.nestedNotAwaited) labels.push(`${model.nestedNotAwaited} NOT AWAITED INSIDE`);
  if (model.nestedResultsDropped) {
    labels.push(`${model.nestedResultsDropped} ${model.nestedResultsDropped === 1 ? "RESULT" : "RESULTS"} DROPPED INSIDE`);
  }
  return labels;
}

export function asyncStateLabel(state: NodeAsyncState): string {
  if (state.kind === "awaited") return "AWAITED";
  if (state.kind === "launched") return state.binding ? `LAUNCHED · ${state.binding}` : "LAUNCHED";
  if (state.kind === "detached") return "NOT AWAITED";
  if (state.kind === "barrier") {
    const mode = state.mode === "allSettled" ? "ALL SETTLED" : "AWAIT ALL";
    return `${mode} · ${state.taskCount}`;
  }
  return state.taskCount > 1 ? `AWAITED · ${state.taskCount} TASKS` : "AWAITED";
}

/** The exact state text painted by the rail; layouts use the same function to reserve its width. */
export function semanticStateLabel(state: NodeAsyncState, returnsPromise: boolean): string {
  return state.kind === "detached" && !returnsPromise ? "RESULT DROPPED" : asyncStateLabel(state);
}

export function displayNodeKind(kind: string): string {
  if (kind === "functions") return "FUNCTIONS";
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toUpperCase();
}

export interface DetachedCallSummary {
  /** Promise-valued launches explicitly discarded at their call occurrence. */
  notAwaited: number;
  /** Explicitly discarded results whose Promise-ness is unknown or false. */
  resultsDropped: number;
}

export type DetachedPromiseResolver = (
  step: Extract<FlowStep, { kind: "call" }>,
) => boolean;

/** Summarize explicit detached occurrences anywhere in a callable's structured flow tree without
 * upgrading an arbitrary `void syncCall()` into a Promise claim. */
export function detachedCallSummary(
  steps: readonly FlowStep[],
  returnsPromise: DetachedPromiseResolver = () => false,
): DetachedCallSummary {
  const summary: DetachedCallSummary = { notAwaited: 0, resultsDropped: 0 };
  for (const step of steps) {
    if (step.kind === "call") {
      if (step.detached) {
        if (step.async?.kind === "launch" || returnsPromise(step)) summary.notAwaited += 1;
        else summary.resultsDropped += 1;
      }
      continue;
    }
    if (step.kind === "branch") {
      for (const path of step.paths) addDetachedSummary(summary, detachedCallSummary(path.body, returnsPromise));
      continue;
    }
    if (step.kind === "loop" || step.kind === "callback") {
      addDetachedSummary(summary, detachedCallSummary(step.body, returnsPromise));
    }
  }
  return summary;
}

function addDetachedSummary(target: DetachedCallSummary, addition: DetachedCallSummary): void {
  target.notAwaited += addition.notAwaited;
  target.resultsDropped += addition.resultsDropped;
}

function explicitPromiseReturn(signature: string | undefined): boolean {
  if (!signature) return false;
  const directReturn = outerReturnType(signature);
  if (directReturn === null) return false;
  // A nested Promise (`() => Promise<T>`, `{ pending: Promise<T> }`) does not make the callable's
  // own result a Promise. Prefer a conservative direct-type match over a visually confident lie.
  return isDirectPromiseType(directReturn);
}

function isDirectPromiseType(type: string): boolean {
  const head = /^(?:globalThis\.)?Promise(?:Like)?/.exec(type);
  if (!head) return false;
  let cursor = head[0].length;
  while (/\s/.test(type[cursor] ?? "")) cursor += 1;
  if (cursor === type.length) return true;
  if (type[cursor] !== "<") return false;
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let i = cursor; i < type.length; i += 1) {
    const char = type[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "<") depth += 1;
    if (char !== ">" || type[i - 1] === "=") continue;
    depth -= 1;
    if (depth === 0) return type.slice(i + 1).trim().length === 0;
  }
  return false;
}

/** Find the return annotation after the callable's OUTER parameter list. Callback parameter types
 * may contain their own `): Promise` fragments, so a last-index search is not structurally safe. */
function outerReturnType(signature: string): string | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let i = open; i < signature.length; i += 1) {
    const char = signature[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const suffix = signature.slice(i + 1).trim();
    if (suffix.startsWith(":")) return suffix.slice(1).trim();
    if (suffix.startsWith("->")) return suffix.slice(2).trim();
    return null;
  }
  return null;
}
