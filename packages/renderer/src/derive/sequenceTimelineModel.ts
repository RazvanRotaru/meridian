/**
 * Pure projection for the static sequence view. The source flow is intraprocedural, so the model
 * deliberately makes the smallest useful interprocedural inference: a resolved callee may be
 * expanded one level, while cycles, very large diagrams, and participant fan-out are bounded.
 * Geometry and interaction stay in SequenceTimelineView.
 */

import type { ChangeStatus, FlowStep, LogicFlows, NodeId } from "@meridian/core";
import { branchKindOf, exitLabel, parseNodeId, syntheticFallThroughLabel } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { callDisplay } from "./flowViewModel";

export interface SequenceTimelineOptions {
  /** Resolved callees are expanded this many hops beneath the selected flow. */
  maxInlineDepth?: number;
  /** Includes the flow owner and the synthetic overflow participant. */
  maxParticipants?: number;
  /** Includes the final truncation note when a guard is reached. */
  maxRows?: number;
}

export type SequenceParticipantKind = "node" | "resource" | "external" | "unresolved" | "callback" | "overflow";

export interface SequenceParticipant {
  id: string;
  kind: SequenceParticipantKind;
  label: string;
  detail: string | null;
  nodeId: NodeId | null;
  changedStatus?: ChangeStatus;
}

export type SequenceMessageTone = "call" | "await" | "detached" | "callback";
export type SequenceVisualRole = "primary" | "detail";

export interface SequenceMessage {
  id: string;
  type: "message";
  row: number;
  kind: "call" | "return";
  tone: SequenceMessageTone;
  from: string;
  to: string;
  label: string;
  /** Detail rows remain in the semantic transcript but may be omitted from the quiet visual view. */
  visualRole: SequenceVisualRole;
  /** Exact callable target. Return arrows retain it for linked highlighting but never select/drill. */
  target: NodeId | null;
  drillable: boolean;
}

export interface SequenceNote {
  id: string;
  type: "note";
  row: number;
  participant: string;
  tone: "wait" | "exit" | "handoff" | "guard";
  label: string;
  /** Detail rows remain in the semantic transcript but may be omitted from the quiet visual view. */
  visualRole: SequenceVisualRole;
}

export type SequenceRow = SequenceMessage | SequenceNote;

export interface SequenceFrameSeparator {
  /** Boundary before this row. */
  row: number;
  label: string;
}

export interface SequenceFrame {
  id: string;
  kind: "loop" | "callback" | "alt";
  label: string;
  startRow: number;
  endRow: number;
  separators: SequenceFrameSeparator[];
}

export interface SequenceTimelineModel {
  participants: SequenceParticipant[];
  rows: SequenceRow[];
  frames: SequenceFrame[];
  truncated: boolean;
  guards: Required<SequenceTimelineOptions>;
}

export const DEFAULT_SEQUENCE_TIMELINE_OPTIONS: Required<SequenceTimelineOptions> = {
  maxInlineDepth: 1,
  maxParticipants: 8,
  maxRows: 96,
};

const OVERFLOW_ID = "sequence:participant-overflow";

interface DeferredCallbackRegion {
  step: Extract<FlowStep, { kind: "callback" }>;
  participant: string;
  inlineDepth: number;
  activeTargets: ReadonlySet<NodeId>;
}

export function buildSequenceTimeline(
  rootId: NodeId,
  steps: FlowStep[],
  flows: LogicFlows,
  index: GraphIndex,
  options: SequenceTimelineOptions = {},
): SequenceTimelineModel {
  const guards: Required<SequenceTimelineOptions> = {
    maxInlineDepth: Math.max(0, options.maxInlineDepth ?? DEFAULT_SEQUENCE_TIMELINE_OPTIONS.maxInlineDepth),
    // One slot is the owner; one can become the overflow participant.
    maxParticipants: Math.max(2, options.maxParticipants ?? DEFAULT_SEQUENCE_TIMELINE_OPTIONS.maxParticipants),
    // Reserve a row for a useful truncation explanation.
    maxRows: Math.max(2, options.maxRows ?? DEFAULT_SEQUENCE_TIMELINE_OPTIONS.maxRows),
  };
  const builder = new SequenceBuilder(rootId, flows, index, guards);
  builder.walk(steps, builder.rootParticipantId, 0, new Set([rootId]));
  return builder.finish();
}

class SequenceBuilder {
  readonly rootParticipantId: string;

  private readonly participants: SequenceParticipant[] = [];
  private readonly participantByKey = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private readonly rows: SequenceRow[] = [];
  private readonly frames: SequenceFrame[] = [];
  private sequence = 0;
  private overflowedParticipants = false;
  private rowLimitReached = false;

  constructor(
    rootId: NodeId,
    private readonly flows: LogicFlows,
    private readonly index: GraphIndex,
    private readonly guards: Required<SequenceTimelineOptions>,
  ) {
    // The selected root remains a callable lane. Callees are grouped by component owner below.
    this.rootParticipantId = this.ensureNodeParticipant(rootId);
  }

  walk(steps: FlowStep[], owner: string, inlineDepth: number, activeTargets: ReadonlySet<NodeId>): void {
    const deferredCallbacks: DeferredCallbackRegion[] = [];
    this.walkSteps(steps, owner, inlineDepth, activeTargets, deferredCallbacks);
    this.drainDeferredCallbacks(deferredCallbacks);
  }

  private walkSteps(
    steps: FlowStep[],
    owner: string,
    inlineDepth: number,
    activeTargets: ReadonlySet<NodeId>,
    deferredCallbacks: DeferredCallbackRegion[],
  ): void {
    for (const step of steps) {
      if (this.rowLimitReached) return;
      switch (step.kind) {
        case "call":
          this.call(step, owner, inlineDepth, activeTargets, deferredCallbacks);
          break;
        case "await":
          this.note(owner, "wait", waitLabel(step.label, step.inputs.map((input) => input.label)));
          break;
        case "exit":
          this.note(owner, "exit", exitLabel(step));
          break;
        case "loop":
          this.framed("loop", step.label, owner, () => {
            this.walkSteps(step.body, owner, inlineDepth, activeTargets, deferredCallbacks);
          });
          break;
        case "callback":
          this.callback(step, owner, inlineDepth, activeTargets, deferredCallbacks);
          break;
        case "branch":
          this.branch(step, owner, inlineDepth, activeTargets, deferredCallbacks);
          break;
      }
    }
  }

  private call(
    step: Extract<FlowStep, { kind: "call" }>,
    owner: string,
    inlineDepth: number,
    activeTargets: ReadonlySet<NodeId>,
    deferredCallbacks: DeferredCallbackRegion[],
  ): void {
    const callee = this.participantForCall(step);
    const display = callDisplay(step, this.flows, this.index);
    const waiting = isWaitingCall(step);
    const launched = step.async?.kind === "launch";
    const tone: SequenceMessageTone = step.detached || launched
      ? "detached"
      : waiting
        ? "await"
        : "call";
    const callAdded = this.message({
      kind: "call",
      tone,
      from: owner,
      to: callee,
      label: waiting ? `await ${step.label}` : step.label,
      target: step.target,
      drillable: display.navigable,
    });
    if (!callAdded) return;

    if (waiting) {
      const inputs = step.async?.kind === "barrier" ? step.async.inputs.map((input) => input.label) : [];
      // The awaited call label already communicates this pause. Keep the fuller explanation in the
      // transcript without giving it a second visual row.
      this.note(owner, "wait", waitLabel(step.label, inputs), "detail");
    }
    if (step.detached) {
      this.note(owner, "handoff", `${step.label} continues without this caller`);
      return;
    }

    // A launch returns a handle immediately. Expanding its target flow here would place all of the
    // launched work before the parent's next row, falsely turning concurrency into a blocking call.
    if (launched) {
      this.note(owner, "handoff", launchLabel(step));
      if (!this.rowLimitReached) {
        this.message({
          kind: "return",
          tone,
          from: callee,
          to: owner,
          label: returnLabel(step),
          target: step.target,
          drillable: false,
        });
      }
      return;
    }

    const target = step.resolution === "resolved" ? step.target : null;
    const targetFlow = target ? this.flows[target] : undefined;
    const guaranteedThrow = targetFlow !== undefined && flowGuaranteesThrow(targetFlow);
    const cyclic = target !== null && activeTargets.has(target);
    const canInline = target !== null
      && targetFlow !== undefined
      && targetFlow.length > 0
      && inlineDepth < this.guards.maxInlineDepth
      && !cyclic
      && callee !== OVERFLOW_ID;
    if (canInline) {
      const nextActive = new Set(activeTargets);
      nextActive.add(target);
      this.walkSteps(targetFlow, callee, inlineDepth + 1, nextActive, deferredCallbacks);
    } else if (cyclic) {
      this.note(callee, "guard", "recursive call · nested cycle collapsed");
    }

    if (this.rowLimitReached) return;
    if (guaranteedThrow) {
      if (!canInline) this.note(callee, "exit", "does not return · throws on every path");
      return;
    }
    const resolutionLabel = returnLabel(step);
    this.message({
      kind: "return",
      tone,
      from: callee,
      to: owner,
      label: resolutionLabel,
      target: step.target,
      drillable: false,
      // Plain synchronous returns are optional sequence-diagram noise. Named handles and awaited
      // resolutions stay primary because they materially change the caller's story.
      visualRole: resolutionLabel === "returns" ? "detail" : "primary",
    });
  }

  private callback(
    step: Extract<FlowStep, { kind: "callback" }>,
    owner: string,
    inlineDepth: number,
    activeTargets: ReadonlySet<NodeId>,
    deferredCallbacks: DeferredCallbackRegion[],
  ): void {
    const callback = this.ensureParticipant(`callback:${step.label}`, {
      id: `sequence:callback:${step.label}`,
      kind: "callback",
      label: step.label,
      detail: "callback",
      nodeId: null,
    });
    if (!this.message({
      kind: "call",
      tone: "callback",
      from: owner,
      to: callback,
      label: `register ${step.label}`,
      target: null,
      drillable: false,
    })) return;
    deferredCallbacks.push({
      step,
      participant: callback,
      inlineDepth,
      activeTargets,
    });
  }

  private drainDeferredCallbacks(deferredCallbacks: DeferredCallbackRegion[]): void {
    // The queue may grow while a callback definition is projected. Appending nested callbacks to
    // the tail keeps every deferred body outside its parent's ordinary continuation and preserves
    // deterministic source order without claiming runtime order.
    for (let index = 0; index < deferredCallbacks.length; index += 1) {
      if (this.rowLimitReached) return;
      const deferred = deferredCallbacks[index]!;
      this.framed(
        "callback",
        `${deferred.step.label} · deferred / timing unknown`,
        deferred.participant,
        () => {
          this.note(
            deferred.participant,
            "handoff",
            "definition only · not ordered against parent continuation",
            "detail",
          );
          this.walkSteps(
            deferred.step.body,
            deferred.participant,
            deferred.inlineDepth,
            deferred.activeTargets,
            deferredCallbacks,
          );
        },
      );
    }
  }

  private branch(
    step: Extract<FlowStep, { kind: "branch" }>,
    owner: string,
    inlineDepth: number,
    activeTargets: ReadonlySet<NodeId>,
    deferredCallbacks: DeferredCallbackRegion[],
  ): void {
    const start = this.rows.length;
    const separators: SequenceFrameSeparator[] = [];
    const syntheticFallthrough = syntheticFallThroughLabel(step);
    step.paths.forEach((path, pathIndex) => {
      if (this.rowLimitReached) return;
      if (pathIndex > 0) separators.push({ row: this.rows.length, label: path.label });
      const pathStart = this.rows.length;
      this.walkSteps(path.body, owner, inlineDepth, activeTargets, deferredCallbacks);
      if (!this.rowLimitReached && this.rows.length === pathStart) {
        this.note(owner, "guard", `${path.label} · no visible flow steps`, "detail");
      }
    });
    if (!this.rowLimitReached && syntheticFallthrough !== null) {
      if (step.paths.length > 0) {
        separators.push({ row: this.rows.length, label: `${syntheticFallthrough} (implicit)` });
      }
      this.note(owner, "guard", `${syntheticFallthrough} · implicit source fallthrough`, "detail");
    }
    if (this.rows.length > start) {
      const firstAlternative = step.paths[0]?.label ?? syntheticFallthrough;
      this.frames.push({
        id: this.id("frame"),
        kind: "alt",
        label: firstAlternative ? `${step.label} · ${firstAlternative}` : step.label,
        startRow: start,
        endRow: this.rows.length - 1,
        separators,
      });
    }
  }

  private framed(
    kind: "loop" | "callback",
    label: string,
    owner: string,
    body: () => void,
  ): void {
    const start = this.rows.length;
    body();
    if (!this.rowLimitReached && this.rows.length === start) {
      this.note(owner, "guard", `${label} · no visible flow steps`, "detail");
    }
    if (this.rows.length > start) {
      this.frames.push({
        id: this.id("frame"),
        kind,
        label,
        startRow: start,
        endRow: this.rows.length - 1,
        separators: [],
      });
    }
  }

  private participantForCall(step: Extract<FlowStep, { kind: "call" }>): string {
    if (step.resolution === "resolved" && step.target !== null) {
      return this.ensureNodeParticipant(this.participantOwner(step.target));
    }
    if (step.resolution === "external") {
      return this.ensureParticipant("external", {
        id: "sequence:external",
        kind: "external",
        label: "External",
        detail: "library / service",
        nodeId: null,
      });
    }
    return this.ensureParticipant("unresolved", {
      id: "sequence:unresolved",
      kind: "unresolved",
      label: "Unresolved",
      detail: "target not linked",
      nodeId: null,
    });
  }

  private ensureNodeParticipant(nodeId: NodeId): string {
    const node = this.index.nodesById.get(nodeId);
    const parsed = parseNodeId(nodeId);
    const label = node?.displayName
      ?? parsed.qualname?.split(".").pop()
      ?? parsed.modulePath.split("/").pop()
      ?? nodeId;
    const detail = node?.location?.file ?? parsed.modulePath ?? null;
    return this.ensureParticipant(`node:${nodeId}`, {
      id: `sequence:node:${nodeId}`,
      kind: "node",
      label,
      detail,
      nodeId,
      changedStatus: this.index.changedStatus.get(nodeId),
    });
  }

  /** Sequence lanes are components, not one column per helper. Prefer the nearest structural owner
   * while messages retain the exact callable target for selection, drill, and PR status. */
  private participantOwner(targetId: NodeId): NodeId {
    const seen = new Set<NodeId>([targetId]);
    let current = this.index.parentOf?.get(targetId) ?? this.index.nodesById.get(targetId)?.parentId ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = this.index.nodesById.get(current);
      if (node && isSequenceOwnerKind(node.kind)) return current;
      current = this.index.parentOf?.get(current) ?? node?.parentId ?? null;
    }
    return targetId;
  }

  private ensureParticipant(key: string, participant: SequenceParticipant): string {
    const existing = this.participantByKey.get(key);
    if (existing) return existing;
    if (this.participants.length < this.guards.maxParticipants) {
      this.participants.push(participant);
      this.participantByKey.set(key, participant.id);
      return participant.id;
    }

    this.overflowedParticipants = true;
    if (!this.participants.some((entry) => entry.id === OVERFLOW_ID)) {
      // Replace the last non-owner lane with one bounded overflow lane. Earlier rows are remapped
      // in finish(), so the diagram never exceeds maxParticipants even after the guard trips.
      const evicted = this.participants.pop();
      if (evicted) {
        this.aliases.set(evicted.id, OVERFLOW_ID);
        for (const [knownKey, knownId] of this.participantByKey) {
          if (knownId === evicted.id) this.participantByKey.set(knownKey, OVERFLOW_ID);
        }
      }
      this.participants.push({
        id: OVERFLOW_ID,
        kind: "overflow",
        label: "More participants",
        detail: "collapsed by size guard",
        nodeId: null,
      });
    }
    this.participantByKey.set(key, OVERFLOW_ID);
    return OVERFLOW_ID;
  }

  private message(
    input: Omit<SequenceMessage, "id" | "type" | "row" | "visualRole"> & {
      visualRole?: SequenceVisualRole;
    },
  ): boolean {
    return this.push({ ...input, visualRole: input.visualRole ?? "primary", type: "message" });
  }

  private note(
    participant: string,
    tone: SequenceNote["tone"],
    label: string,
    visualRole: SequenceVisualRole = "primary",
  ): boolean {
    return this.push({ type: "note", participant, tone, label, visualRole });
  }

  private push(input: Omit<SequenceMessage, "id" | "row"> | Omit<SequenceNote, "id" | "row">): boolean {
    if (this.rowLimitReached) return false;
    if (this.rows.length >= this.guards.maxRows - 1) {
      this.rowLimitReached = true;
      return false;
    }
    this.rows.push({ ...input, id: this.id(input.type), row: this.rows.length } as SequenceRow);
    return true;
  }

  private id(prefix: string): string {
    return `sequence:${prefix}:${this.sequence++}`;
  }

  finish(): SequenceTimelineModel {
    if (this.rowLimitReached && this.rows.length < this.guards.maxRows) {
      this.rows.push({
        id: this.id("note"),
        type: "note",
        row: this.rows.length,
        participant: this.rootParticipantId,
        tone: "guard",
        label: `Flow truncated at ${this.guards.maxRows} rows`,
        visualRole: "primary",
      });
    }
    const alias = (id: string) => this.aliases.get(id) ?? id;
    const rows = this.rows.map((row): SequenceRow => row.type === "message"
      ? { ...row, from: alias(row.from), to: alias(row.to) }
      : { ...row, participant: alias(row.participant) });
    const frames = [...this.frames]
      .filter((frame) => frame.startRow < rows.length)
      .map((frame) => ({ ...frame, endRow: Math.min(frame.endRow, rows.length - 1) }))
      .sort((left, right) => left.startRow - right.startRow || right.endRow - left.endRow || left.id.localeCompare(right.id));
    return {
      participants: this.participants,
      rows,
      frames,
      truncated: this.rowLimitReached || this.overflowedParticipants,
      guards: this.guards,
    };
  }
}

function isWaitingCall(step: Extract<FlowStep, { kind: "call" }>): boolean {
  return step.awaited === true
    || step.async?.kind === "direct-await"
    || step.async?.kind === "barrier";
}

function waitLabel(label: string, inputs: string[]): string {
  const inputLabel = inputs.length > 0 ? ` · ${inputs.slice(0, 3).join(", ")}` : "";
  return `waits here for ${label}${inputLabel}`;
}

function returnLabel(step: Extract<FlowStep, { kind: "call" }>): string {
  if (step.async?.kind === "launch") return step.async.binding ? `task handle · ${step.async.binding}` : "task handle";
  if (isWaitingCall(step)) return "resolves";
  return "returns";
}

function launchLabel(step: Extract<FlowStep, { kind: "call" }>): string {
  const binding = step.async?.kind === "launch" ? step.async.binding : undefined;
  return binding
    ? `starts in parallel · continuation keeps ${binding}`
    : "starts in parallel · completion ordering unknown";
}

/** True only when every charted route through the flow reaches a throw. Mixed/try flows retain a
 * normal return arrow: suppressing one without proof is more misleading than keeping it. */
function flowGuaranteesThrow(steps: FlowStep[]): boolean {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (step.kind === "exit") return step.variant === "throw";
    if (step.kind !== "branch") continue;

    // Finally makes try/catch outcome composition non-trivial; stay conservative until the flow
    // artifact carries an explicit post-finally outcome relation.
    if (branchKindOf(step) === "try") return false;
    const continuation = steps.slice(index + 1);
    const routes = step.paths.map((path) => [...path.body, ...continuation]);
    if (syntheticFallThroughLabel(step) !== null) routes.push(continuation);
    return routes.length > 0 && routes.every((route) => flowGuaranteesThrow(route));
  }
  return false;
}

function isSequenceOwnerKind(kind: string): boolean {
  return kind === "class"
    || kind === "interface"
    || kind === "object"
    || kind === "namespace"
    || kind === "module"
    || kind === "package";
}
