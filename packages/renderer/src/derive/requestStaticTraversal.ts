import {
  branchKindOf,
  pathRole,
  syntheticFallThroughLabel,
  type FlowPath,
  type FlowSourceAnchor,
  type FlowStep,
  type LogicFlows,
  type RequestTrace,
  type TimelineEvent,
  type TimelineSpan,
} from "@meridian/core";
import type { LogicEdgeSpec, RequestEdgeTraversalEvidence } from "./logicGraph";
import {
  logicBranchBodyPrefix,
  logicCallBodyPrefix,
  logicControlBodyPrefix,
  logicFinallyBodyPrefix,
  logicNodeId,
  logicStepPath,
  logicTopLevelBodyPrefix,
} from "./logicFlowAddress";

type BranchEvent = Extract<TimelineEvent, { type: "branch.taken" }>;
type LoopEvent = Extract<TimelineEvent, { type: "loop.summary" }>;
type ExceptionEvent = Extract<TimelineEvent, { type: "exception" }>;
type Termination = Extract<FlowStep, { kind: "exit" }>["variant"];

interface ActualExit {
  id: string;
  edgeLabel?: string;
  childSpanId?: string;
  evidence?: RequestEdgeTraversalEvidence;
}

interface StepResult {
  entry: string;
  exits: ActualExit[];
  terminations: Termination[];
  entryChildSpanId?: string;
}

interface SequenceResult {
  firstId: string | null;
  lastExits: ActualExit[];
  terminations: Termination[];
  fallsThrough: boolean;
}

interface SpanContext {
  branchEvents: BranchEvent[];
  loopEvents: LoopEvent[];
  exceptionEvents: ExceptionEvent[];
  usedEventIds: Set<string>;
  children: TimelineSpan[];
  usedChildSpanIds: Set<string>;
}

/** Add positive, occurrence-scoped telemetry evidence to the static edges grafted inside one
 * expanded request span. Source anchors and path ids are extractor/probe joins; an edge that cannot
 * be proven stays metadata-free and is rendered as context by the request pane. */
export function correlateStaticRequestEdges(args: {
  edges: readonly LogicEdgeSpec[];
  execPrefix: string;
  steps: FlowStep[];
  flows: LogicFlows;
  expansionOverrides: ReadonlySet<string>;
  trace: RequestTrace;
  span: TimelineSpan;
}): LogicEdgeSpec[] {
  const correlator = new StaticTraversalCorrelator(
    args.execPrefix,
    args.flows,
    args.expansionOverrides,
    args.trace,
    args.edges,
  );
  const rootEvidence = spanEvidence(args.trace, args.span);
  correlator.sequence(args.steps, logicTopLevelBodyPrefix(0), args.span, rootEvidence);
  return args.edges.map((edge) => {
    const evidence = correlator.evidenceFor(edge);
    return evidence === undefined ? edge : { ...edge, requestTraversal: evidence };
  });
}

class StaticTraversalCorrelator {
  private readonly evidenceByEdge = new Map<string, RequestEdgeTraversalEvidence>();
  private readonly spanContexts = new Map<string, SpanContext>();

  constructor(
    private readonly execPrefix: string,
    private readonly flows: LogicFlows,
    private readonly expansionOverrides: ReadonlySet<string>,
    private readonly trace: RequestTrace,
    private readonly renderedEdges: readonly LogicEdgeSpec[],
  ) {}

  evidenceFor(edge: LogicEdgeSpec): RequestEdgeTraversalEvidence | undefined {
    return this.evidenceByEdge.get(edgeKey(edge.source, edge.target, edge.label));
  }

  sequence(
    steps: FlowStep[],
    prefix: string,
    span: TimelineSpan,
    evidence: RequestEdgeTraversalEvidence | undefined,
  ): SequenceResult {
    let firstId: string | null = null;
    let previous: ActualExit[] = [];
    const terminations: Termination[] = [];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      const path = logicStepPath(prefix, index);
      const result = this.step(step, path, span, steps[index + 1]);
      firstId ??= result.entry;
      for (const exit of previous) {
        const linkEvidence = exit.evidence
          ?? (exit.childSpanId !== undefined && result.entryChildSpanId !== undefined
            ? childOrderEvidence(this.trace.traceId, span.spanId, exit.childSpanId, result.entryChildSpanId)
            : evidence);
        if (linkEvidence !== undefined) {
          this.mark(exit.id, result.entry, exit.edgeLabel, linkEvidence);
        }
      }
      terminations.push(...result.terminations);
      if (result.exits.length === 0) {
        return { firstId, lastExits: [], terminations: uniqueTerminations(terminations), fallsThrough: false };
      }
      previous = result.exits;
    }

    return {
      firstId,
      lastExits: previous,
      terminations: uniqueTerminations(terminations),
      fallsThrough: steps.length === 0 || previous.length > 0,
    };
  }

  private step(
    step: FlowStep,
    path: string,
    span: TimelineSpan,
    nextStep: FlowStep | undefined,
  ): StepResult {
    const id = logicNodeId(this.execPrefix, path);
    if (step.kind === "call") {
      return this.call(step, path, id, span, nextStep);
    }
    if (step.kind === "await") {
      // The redesigned execution graph represents a structural await as its own pass-through node.
      // Runtime ordering for the surrounding span is enough to prove entry and continuation; async
      // handoff details remain on the occurrence graph rather than being invented here.
      return { entry: id, exits: [{ id }], terminations: [] };
    }
    if (step.kind === "exit") {
      return { entry: id, exits: [], terminations: [step.variant] };
    }
    if (step.kind === "loop") {
      return this.loop(step, path, id, span);
    }
    if (step.kind === "callback") {
      // The callback object was handed over, but its body is not proven to have run merely because
      // the enclosing span executed. Keep its inner edges as context until an async handoff joins it.
      return { entry: id, exits: [{ id }], terminations: [] };
    }
    if (branchKindOf(step) === "try") {
      return this.tryBranch(step, path, id, span);
    }
    return this.branch(step, path, id, span);
  }

  private call(
    step: Extract<FlowStep, { kind: "call" }>,
    path: string,
    id: string,
    span: TimelineSpan,
    nextStep: FlowStep | undefined,
  ): StepResult {
    const child = step.target === null ? null : this.claimChild(span, step.target);
    let nested: SequenceResult | null = null;
    if (
      step.target !== null
      && (this.flows[step.target]?.length ?? 0) > 0
      && this.expanded(id, false)
    ) {
      const nestedSpan = child ?? span;
      nested = this.sequence(
        this.flows[step.target]!,
        logicCallBodyPrefix(path),
        nestedSpan,
        spanEvidence(this.trace, nestedSpan),
      );
    }

    const detached = step.detached === true;
    const inlineException = child === null
      && !followedByMatchingThrow(step, nextStep)
      ? this.claimUnhandledException(span, step.source)
      : null;
    const nestedOnlyThrows = nested !== null
      && !nested.fallsThrough
      && nested.terminations.includes("throw")
      && !nested.terminations.includes("return");
    // A detached failure belongs to independent work and cannot terminate or order the caller.
    // Otherwise a failing captured child, an observed inline exception, or a proven nested throw
    // enters this call but provides no normal continuation out of it.
    const stops = !detached && (child?.status === "error" || inlineException !== null || nestedOnlyThrows);
    return {
      entry: id,
      ...((child === null || detached) ? {} : { entryChildSpanId: child.spanId }),
      exits: stops
        ? []
        : [{ id, ...((child === null || detached) ? {} : { childSpanId: child.spanId }) }],
      terminations: stops ? ["throw"] : [],
    };
  }

  private branch(
    step: Extract<FlowStep, { kind: "branch" }>,
    path: string,
    id: string,
    span: TimelineSpan,
  ): StepResult {
    const events = this.claimBranchEvents(span, [step.source, ...step.paths.map((candidate) => candidate.source)]);
    if (events.length === 0) {
      return { entry: id, exits: [], terminations: [] };
    }

    // A branch nested in a loop may be observed repeatedly and can take more than one arm during a
    // single span. Aggregate equal paths, then paint every arm that has positive event evidence.
    const byPath = groupBranchEvents(events);
    const exits: ActualExit[] = [];
    const continuingEvents: BranchEvent[] = [];
    const terminations: Termination[] = [];
    const joinId = this.renderedNodeId(`${id}::join`);
    for (const pathEvents of byPath.values()) {
      const pathId = pathEvents[0]!.pathId;
      const evidence = branchEvidence(this.trace.traceId, span.spanId, pathEvents);
      const selectedIndex = step.paths.findIndex((candidate) => pathMatches(candidate, pathId));
      if (selectedIndex >= 0) {
        const selected = step.paths[selectedIndex]!;
        const body = this.sequence(selected.body, logicBranchBodyPrefix(path, selectedIndex), span, evidence);
        if (body.firstId === null) {
          const armExits = [{ id, edgeLabel: selected.label, evidence }];
          if (joinId === null) exits.push(...armExits);
          else {
            this.markExitsTo(armExits, joinId, evidence);
            continuingEvents.push(...pathEvents);
          }
          continue;
        }
        this.mark(id, body.firstId, selected.label, evidence);
        const armExits = body.lastExits.map((exit) => ({ ...exit, evidence }));
        if (joinId === null) exits.push(...armExits);
        else if (armExits.length > 0) {
          this.markExitsTo(armExits, joinId, evidence);
          continuingEvents.push(...pathEvents);
        }
        terminations.push(...body.terminations);
        continue;
      }

      const fallthrough = syntheticFallThroughLabel(step);
      if (fallthrough !== null && pathId === fallthrough) {
        const armExits = [{ id, edgeLabel: fallthrough, evidence }];
        if (joinId === null) exits.push(...armExits);
        else {
          this.markExitsTo(armExits, joinId, evidence);
          continuingEvents.push(...pathEvents);
        }
      }
    }
    return {
      entry: id,
      exits: joinId !== null && continuingEvents.length > 0
        ? [{ id: joinId, evidence: branchEvidence(this.trace.traceId, span.spanId, continuingEvents) }]
        : exits,
      terminations: uniqueTerminations(terminations),
    };
  }

  private loop(
    step: Extract<FlowStep, { kind: "loop" }>,
    path: string,
    id: string,
    span: TimelineSpan,
  ): StepResult {
    const event = this.claimLoopEvent(span, step.source);
    if (event !== null && event.iterations > 0) {
      const body = this.sequence(
        step.body,
        logicControlBodyPrefix(path, 0),
        span,
        loopEvidence(this.trace.traceId, span.spanId, event),
      );
      // Expansion controls rendering, not completion. Traversing a collapsed loop body only marks
      // absent inner edge ids, while still preventing an observed failure from painting the
      // post-loop edge. Even if repeated branch observations also yielded a continuing arm, the
      // captured terminating occurrence makes that outer continuation uncertain.
      if (body.terminations.length > 0) {
        return { entry: id, exits: [], terminations: body.terminations };
      }
    }
    return { entry: id, exits: [{ id }], terminations: [] };
  }

  private tryBranch(
    step: Extract<FlowStep, { kind: "branch" }>,
    path: string,
    id: string,
    span: TimelineSpan,
  ): StepResult {
    const event = this.claimBranchEvent(span, [step.source, ...step.paths.map((candidate) => candidate.source)]);
    if (event === null) {
      // Span status cannot tell whether the try arm completed or a catch handled an exception.
      return { entry: id, exits: [], terminations: [] };
    }
    const selectedRole = pathRoleForId(step.paths, event.pathId);
    if (selectedRole !== "try" && selectedRole !== "catch") {
      return { entry: id, exits: [], terminations: [] };
    }

    const selectedEvidence = branchEvidence(this.trace.traceId, span.spanId, [event]);
    const tryIndex = step.paths.findIndex((candidate) => pathRole(candidate) === "try");
    const catchIndex = step.paths.findIndex((candidate) => pathRole(candidate) === "catch");
    const finallyIndex = step.paths.findIndex((candidate) => pathRole(candidate) === "finally");

    // The execution-graph redesign charts an ordinary try/catch as real alternative lanes and a
    // non-terminating finally as one mandatory phase after their join. Detect that rendered shape
    // from the edge inventory instead of duplicating the builder's eligibility rules: complex
    // try/finally cases with deferred exits intentionally remain expandable control containers.
    const charted = this.renderedEdges.some((edge) => (
      edge.source === id
      && edge.kind === "branch"
      && step.paths.some((candidate) => candidate.label === edge.label)
    ));
    if (charted) {
      return this.chartedTryBranch(
        step,
        path,
        id,
        span,
        selectedRole,
        selectedEvidence,
        tryIndex,
        catchIndex,
        finallyIndex,
      );
    }

    // A catch observation proves that execution first entered the try arm and reached an exception.
    // Traverse that prefix so calls before the failure remain visible, then consume the throw at the
    // catch boundary and use the catch completion as the container's completion.
    const tryResult = tryIndex < 0
      ? emptySequenceResult()
      : this.sequence(
        step.paths[tryIndex]!.body,
        logicControlBodyPrefix(path, tryIndex),
        span,
        selectedEvidence,
      );
    let selectedResult = tryResult;
    if (selectedRole === "catch") {
      selectedResult = catchIndex < 0
        ? unknownSequenceResult()
        : this.sequence(
          step.paths[catchIndex]!.body,
          logicControlBodyPrefix(path, catchIndex),
          span,
          selectedEvidence,
        );
    }

    if (finallyIndex >= 0) {
      const finallyResult = this.sequence(
        step.paths[finallyIndex]!.body,
        logicControlBodyPrefix(path, finallyIndex),
        span,
        selectedEvidence,
      );
      selectedResult = applyFinally(selectedResult, finallyResult);
    }

    // Expansion controls rendering, not execution semantics. Traversing a collapsed body above is
    // harmless (its edge ids are absent) and keeps termination propagation stable across toggles.
    return {
      entry: id,
      exits: selectedResult.fallsThrough ? [{ id, evidence: selectedEvidence }] : [],
      terminations: selectedResult.terminations,
    };
  }

  /** Correlate the split/join try topology. A caught request proves entry into the protected arm
   * up to the throwing call and then the catch lane; only the catch completion reaches the join.
   * FINALLY is a shared phase after that join, not a third optional branch arm. */
  private chartedTryBranch(
    step: Extract<FlowStep, { kind: "branch" }>,
    path: string,
    id: string,
    span: TimelineSpan,
    selectedRole: "try" | "catch",
    evidence: RequestEdgeTraversalEvidence,
    tryIndex: number,
    catchIndex: number,
    finallyIndex: number,
  ): StepResult {
    const protectedTry = this.chartedArm(step, path, id, tryIndex, span, evidence);
    // Do not route a caught try prefix into the merge: the exception interrupted that lane. The
    // prefix traversal above still paints every positively observed edge before the throw.
    const selected = selectedRole === "catch"
      ? this.chartedArm(step, path, id, catchIndex, span, evidence)
      : protectedTry;
    const joinId = this.renderedNodeId(`${id}::join`);
    const protectedExits = selected.result.fallsThrough
      ? this.routeExitsThrough(selected.exits, joinId, evidence)
      : [];

    const finallyId = this.renderedNodeId(`${id}::finally`);
    if (finallyId === null || finallyIndex < 0) {
      return {
        entry: id,
        exits: protectedExits,
        terminations: selected.result.terminations,
      };
    }

    // The rendered shared phase is entered only by a protected path that reached its merge. A
    // runtime failure inside catch still executes finally in JavaScript, but the static graph has
    // no honest exceptional edge for that transfer, so leave the linking edge unpainted.
    for (const exit of protectedExits) {
      this.mark(exit.id, finallyId, exit.edgeLabel, exit.evidence ?? evidence);
    }
    const finallyResult = this.sequence(
      step.paths[finallyIndex]!.body,
      logicFinallyBodyPrefix(path),
      span,
      evidence,
    );
    if (finallyResult.firstId !== null) {
      this.mark(finallyId, finallyResult.firstId, undefined, evidence);
    }
    const completion = applyFinally(selected.result, finallyResult);
    if (!completion.fallsThrough) {
      return { entry: id, exits: [], terminations: completion.terminations };
    }
    return {
      entry: id,
      exits: finallyResult.firstId === null
        ? [{ id: finallyId, evidence }]
        : finallyResult.lastExits.map((exit) => ({ ...exit, evidence })),
      terminations: completion.terminations,
    };
  }

  private chartedArm(
    step: Extract<FlowStep, { kind: "branch" }>,
    path: string,
    id: string,
    index: number,
    span: TimelineSpan,
    evidence: RequestEdgeTraversalEvidence,
  ): { result: SequenceResult; exits: ActualExit[] } {
    if (index < 0) {
      return { result: unknownSequenceResult(), exits: [] };
    }
    const arm = step.paths[index]!;
    const result = this.sequence(arm.body, logicBranchBodyPrefix(path, index), span, evidence);
    if (result.firstId === null) {
      return {
        result,
        exits: result.fallsThrough ? [{ id, edgeLabel: arm.label, evidence }] : [],
      };
    }
    this.mark(id, result.firstId, arm.label, evidence);
    return {
      result,
      exits: result.lastExits.map((exit) => ({ ...exit, evidence })),
    };
  }

  private routeExitsThrough(
    exits: ActualExit[],
    joinId: string | null,
    evidence: RequestEdgeTraversalEvidence,
  ): ActualExit[] {
    if (joinId === null) return exits;
    this.markExitsTo(exits, joinId, evidence);
    return exits.length === 0 ? [] : [{ id: joinId, evidence }];
  }

  private markExitsTo(
    exits: ActualExit[],
    target: string,
    evidence: RequestEdgeTraversalEvidence,
  ): void {
    exits.forEach((exit) => {
      this.mark(exit.id, target, exit.edgeLabel, exit.evidence ?? evidence);
    });
  }

  /** A structural node has no source-model step. Its presence in the rendered graph is therefore
   * established by being an endpoint of at least one emitted edge. */
  private renderedNodeId(id: string): string | null {
    return this.renderedEdges.some((edge) => edge.source === id || edge.target === id) ? id : null;
  }

  private mark(
    source: string,
    target: string,
    label: string | undefined,
    evidence: RequestEdgeTraversalEvidence,
  ): void {
    this.evidenceByEdge.set(edgeKey(source, target, label), evidence);
  }

  private expanded(id: string, defaultExpanded: boolean): boolean {
    return defaultExpanded !== this.expansionOverrides.has(id);
  }

  private claimBranchEvent(
    span: TimelineSpan,
    sources: Array<FlowSourceAnchor | undefined>,
  ): BranchEvent | null {
    const context = this.context(span);
    const event = context.branchEvents.find((candidate) => (
      !context.usedEventIds.has(candidate.eventId)
      && sources.some((source) => sourceMatches(source, candidate.source))
    ));
    if (event === undefined) return null;
    context.usedEventIds.add(event.eventId);
    return event;
  }

  private claimBranchEvents(
    span: TimelineSpan,
    sources: Array<FlowSourceAnchor | undefined>,
  ): BranchEvent[] {
    const context = this.context(span);
    const events = context.branchEvents.filter((candidate) => (
      !context.usedEventIds.has(candidate.eventId)
      && sources.some((source) => sourceMatches(source, candidate.source))
    ));
    events.forEach((event) => context.usedEventIds.add(event.eventId));
    return events;
  }

  private claimLoopEvent(span: TimelineSpan, source: FlowSourceAnchor | undefined): LoopEvent | null {
    const context = this.context(span);
    const event = context.loopEvents.find((candidate) => (
      !context.usedEventIds.has(candidate.eventId)
      && sourceMatches(source, candidate.source)
    ));
    if (event === undefined) return null;
    context.usedEventIds.add(event.eventId);
    return event;
  }

  private claimUnhandledException(
    span: TimelineSpan,
    source: FlowSourceAnchor | undefined,
  ): ExceptionEvent | null {
    const context = this.context(span);
    const event = context.exceptionEvents.find((candidate) => (
      !candidate.handled
      && !context.usedEventIds.has(candidate.eventId)
      && candidate.source !== undefined
      && sourceMatches(source, candidate.source)
    ));
    if (event === undefined) return null;
    context.usedEventIds.add(event.eventId);
    return event;
  }

  private claimChild(span: TimelineSpan, targetId: string): TimelineSpan | null {
    const context = this.context(span);
    const child = context.children.find((candidate) => (
      !context.usedChildSpanIds.has(candidate.spanId) && candidate.nodeId === targetId
    ));
    if (child === undefined) return null;
    context.usedChildSpanIds.add(child.spanId);
    return child;
  }

  private context(span: TimelineSpan): SpanContext {
    const existing = this.spanContexts.get(span.spanId);
    if (existing !== undefined) return existing;
    const context: SpanContext = {
      branchEvents: span.events.filter((event): event is BranchEvent => event.type === "branch.taken"),
      loopEvents: span.events.filter((event): event is LoopEvent => event.type === "loop.summary"),
      exceptionEvents: span.events.filter((event): event is ExceptionEvent => event.type === "exception"),
      usedEventIds: new Set<string>(),
      children: this.trace.spans
        .filter((candidate) => candidate.parentSpanId === span.spanId)
        .sort(compareSpans),
      usedChildSpanIds: new Set<string>(),
    };
    this.spanContexts.set(span.spanId, context);
    return context;
  }
}

function spanEvidence(trace: RequestTrace, span: TimelineSpan): RequestEdgeTraversalEvidence | undefined {
  if (!trace.completeness.complete || span.status !== "ok") return undefined;
  return { traceId: trace.traceId, basis: "span-body", spanId: span.spanId };
}

function emptySequenceResult(): SequenceResult {
  return { firstId: null, lastExits: [], terminations: [], fallsThrough: true };
}

function unknownSequenceResult(): SequenceResult {
  return { firstId: null, lastExits: [], terminations: [], fallsThrough: false };
}

/** `finally` always runs. A terminating finally overrides the selected try/catch completion; a
 * falling-through finally preserves it. An uncorrelated finally keeps the whole result unknown. */
function applyFinally(selected: SequenceResult, finalizer: SequenceResult): SequenceResult {
  const finalizerKnown = finalizer.fallsThrough || finalizer.terminations.length > 0;
  const selectedKnown = selected.fallsThrough || selected.terminations.length > 0;
  if (!finalizerKnown || !selectedKnown) return unknownSequenceResult();
  if (!finalizer.fallsThrough) {
    return {
      firstId: finalizer.firstId,
      lastExits: [],
      terminations: finalizer.terminations,
      fallsThrough: false,
    };
  }
  return {
    firstId: selected.firstId,
    lastExits: selected.lastExits,
    terminations: uniqueTerminations([...selected.terminations, ...finalizer.terminations]),
    fallsThrough: selected.fallsThrough,
  };
}

function uniqueTerminations(terminations: Termination[]): Termination[] {
  return [...new Set(terminations)];
}

/** `throw new Error()` is extracted as a constructor call followed by an explicit throw on the
 * same source line. The exception belongs to the exit step, not to the constructor call. */
function followedByMatchingThrow(
  step: Extract<FlowStep, { kind: "call" }>,
  nextStep: FlowStep | undefined,
): boolean {
  return nextStep?.kind === "exit"
    && nextStep.variant === "throw"
    && nextStep.source !== undefined
    && sourceRangeContains(nextStep.source, step.source);
}

function childOrderEvidence(
  traceId: string,
  spanId: string,
  sourceChildSpanId: string,
  targetChildSpanId: string,
): RequestEdgeTraversalEvidence {
  return {
    traceId,
    basis: "child-span-order",
    spanId,
    childSpanIds: [sourceChildSpanId, targetChildSpanId],
  };
}

function branchEvidence(traceId: string, spanId: string, events: BranchEvent[]): RequestEdgeTraversalEvidence {
  const first = events[0]!;
  return {
    traceId,
    basis: "branch-path",
    spanId,
    eventIds: events.map((event) => event.eventId),
    siteId: first.siteId,
    pathIds: [...new Set(events.map((event) => event.pathId))],
  };
}

function groupBranchEvents(events: BranchEvent[]): Map<string, BranchEvent[]> {
  const grouped = new Map<string, BranchEvent[]>();
  events.forEach((event) => {
    const existing = grouped.get(event.pathId);
    if (existing === undefined) grouped.set(event.pathId, [event]);
    else existing.push(event);
  });
  return grouped;
}

function loopEvidence(traceId: string, spanId: string, event: LoopEvent): RequestEdgeTraversalEvidence {
  return {
    traceId,
    basis: "loop-body",
    spanId,
    eventIds: [event.eventId],
    siteId: event.siteId,
    iterations: event.iterations,
  };
}

function pathMatches(path: FlowPath, pathId: string): boolean {
  return path.pathId === pathId || pathRole(path) === pathId || path.label === pathId;
}

function pathRoleForId(paths: FlowPath[], pathId: string): ReturnType<typeof pathRole> | null {
  const path = paths.find((candidate) => pathMatches(candidate, pathId));
  return path === undefined ? null : pathRole(path);
}

function sourceMatches(left: FlowSourceAnchor | undefined, right: { file: string; line: number; col?: number }): boolean {
  if (left === undefined || left.line !== right.line) return false;
  if (left.col !== undefined && right.col !== undefined && left.col !== right.col) return false;
  return baseName(left.file) === baseName(right.file);
}

/** A call extracted from `throw buildError()` has its own inner range while the following exit
 * step owns the enclosing throw-statement range. Keep strict column matching for telemetry joins,
 * but recognize this one structural relationship by containment. Line-only legacy artifacts retain
 * the previous same-line behavior. */
function sourceRangeContains(
  outer: FlowSourceAnchor,
  inner: FlowSourceAnchor | undefined,
): boolean {
  if (inner === undefined || baseName(outer.file) !== baseName(inner.file)) return false;
  if (
    outer.col === undefined
    || outer.endLine === undefined
    || outer.endCol === undefined
    || inner.col === undefined
    || inner.endLine === undefined
    || inner.endCol === undefined
  ) {
    return outer.line === inner.line;
  }
  return positionAtOrBefore(outer.line, outer.col, inner.line, inner.col)
    && positionAtOrBefore(inner.endLine, inner.endCol, outer.endLine, outer.endCol);
}

function positionAtOrBefore(leftLine: number, leftCol: number, rightLine: number, rightCol: number): boolean {
  return leftLine < rightLine || (leftLine === rightLine && leftCol <= rightCol);
}

function baseName(file: string): string {
  return file.replaceAll("\\", "/").split("/").pop() ?? file;
}

function edgeKey(source: string, target: string, label: string | undefined): string {
  return `${source}\u0000${target}\u0000${label ?? ""}`;
}

function compareSpans(left: TimelineSpan, right: TimelineSpan): number {
  const leftStart = nano(left.startedAtUnixNano);
  const rightStart = nano(right.startedAtUnixNano);
  if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
  return left.spanId.localeCompare(right.spanId);
}

function nano(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
