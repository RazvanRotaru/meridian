/**
 * Logic-graph node components, styled after Unreal Blueprints: dark bodies with a coloured title
 * bar and left/right exec pins (the white sequence wires connect through them). A "building block"
 * is a function-call node — provenance (package › module) rides under the title so a block is never
 * a bare name; expandable ones carry a disclosure and expand INTO a container frame; leaf calls
 * shrink to full-contrast compact cards while boundary status stays explicit. `for`/`while` render
 * as framed containers. `if`/`switch` alone use decision diamonds; ordinary `try`/`catch` uses a
 * compact amber exception gate whose ivory normal pin runs straight through while a lower catch pin
 * peels into a dashed error lane. Every lane owns a stable source pin.
 */

import { useMemo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ChangeStatus } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import type { DefGroupData, LogicRfNode } from "../../../layout/logicElk";
import { FRAME_PROVENANCE_MAX_WIDTH, type LogicBranchPort, type LogicNodeData, type TerminalData } from "../../../derive/logicGraph";
import { FLOW_COLORS } from "../../../derive/flowViewModel";
import { isSourceBackedNode } from "../../../derive/sourceBackedNode";
import { executionCoverageIndex, executionEvidenceForCallTarget } from "../../../derive/logicExecutionCoverage";
import { callTargetCoverageVerdict, COVERAGE_COLORS, type CoverageVerdict } from "../../../theme/coverageColors";
import { CodeInlinePanel } from "../../CodeInlinePanel";
import { changedColor, changedFill } from "../../ChangedBadge";
import { changedTextColor } from "../../../theme/changedColors";
import { BaseNode, type BaseNodeModel } from "../BaseNode";
import { EmptyNodeExpansion } from "../EmptyNodeExpansion";
import { useLogicFlowOrientation } from "./LogicFlowOrientationContext";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** A solid PR-change beacon. Unlike a one-pixel ring, its filled footprint survives the flow pane's
 * fit-to-overview zoom; the body wash below carries the same signal across the whole card. */
export function ChangedTag({ color }: { color: string }) {
  return (
    <span
      role="img"
      aria-label="Changed in this PR"
      title="Changed in this PR"
      data-pr-change-marker="true"
      style={{ ...CHANGED_TAG, color, borderColor: color, background: `${color}33` }}
    >
      Δ
    </span>
  );
}

/** A call can point at code changed by the PR while its own source line is untouched. Keep that
 * relationship explicit and textual: it must not borrow the whole-card wash used for a changed
 * call site, and it must remain understandable without relying on the status colour. */
export function TargetChangedTag({ status }: { status: ChangeStatus }) {
  const accent = changedColor(status);
  const color = changedTextColor(status);
  const statusLabel = status.toUpperCase();
  return (
    <span
      role="img"
      aria-label={`Call target ${status} in this PR`}
      title={`Call target ${status} in this PR`}
      data-pr-target-change-marker="true"
      data-pr-target-change-status={status}
      style={{ ...TARGET_CHANGED_TAG, color, borderColor: accent, background: `${accent}20` }}
    >
      TARGET {statusLabel}
    </span>
  );
}

// Layer status paint over the node's whole footprint. Selection may own the outer ring, but it never
// erases the PR wash/beacon; dimmed changed nodes stay bright enough to remain review landmarks.
export function withChanged(base: React.CSSProperties, ring: string | null, select: SelectState): React.CSSProperties {
  const normalized = normalizedBackground(base);
  if (!ring) {
    return normalized;
  }
  const existingImage = typeof normalized.backgroundImage === "string" ? normalized.backgroundImage : null;
  const wash = `linear-gradient(${changedFill(ring)}, ${changedFill(ring)})`;
  const statusShadow = `0 0 0 2px ${ring}DD, 0 0 16px ${ring}99`;
  const existingShadow = typeof normalized.boxShadow === "string" ? normalized.boxShadow : null;
  return {
    ...normalized,
    opacity: select === "dimmed" ? 0.82 : normalized.opacity,
    backgroundImage: existingImage ? `${wash}, ${existingImage}` : wash,
    outline: select === "selected" ? normalized.outline : `2px solid ${ring}`,
    outlineOffset: select === "selected" ? normalized.outlineOffset : -1,
    boxShadow: select === "selected"
      ? normalized.boxShadow
      : existingShadow
        ? `${existingShadow}, ${statusShadow}`
        : statusShadow,
  };
}

/** Every logic card supplies a solid-colour `background` shorthand. Normalize it on both changed
 * and unchanged renders so React never reconciles that shorthand against the PR wash longhand. */
function normalizedBackground(base: React.CSSProperties): React.CSSProperties {
  const { background, backgroundColor, backgroundImage, ...rest } = base;
  const shorthand = typeof background === "string" ? background : undefined;
  const shorthandIsImage = shorthand?.includes("gradient(") === true;
  const solidColor = typeof backgroundColor === "string"
    ? backgroundColor
    : shorthand !== undefined && !shorthandIsImage
      ? shorthand
      : undefined;
  return {
    ...rest,
    backgroundColor: solidColor,
    backgroundImage: typeof backgroundImage === "string"
      ? backgroundImage
      : shorthandIsImage
        ? shorthand
        : undefined,
  };
}

function StructuralChangedMarker({ color }: { color: string }) {
  return <span style={STRUCTURAL_CHANGED_MARKER}><ChangedTag color={color} /></span>;
}

function ExecPins() {
  const orientation = useLogicFlowOrientation();
  return (
    <>
      <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={PIN} isConnectable={false} />
      <Handle type="source" position={orientation === "horizontal" ? Position.Right : Position.Bottom} style={PIN} isConnectable={false} />
    </>
  );
}

function callableBaseNodeModel(instanceId: string, data: LogicNodeData): BaseNodeModel {
  return {
    instanceId,
    targetId: data.targetId,
    nodeType: "block",
    kind: data.runtime?.kind ?? data.callKind ?? data.logicKind,
    semantics: data.semantics,
    label: data.label,
    childCount: data.childCount,
    canExpand: data.expandable,
    expanded: data.isExpanded,
    // Runtime occurrences historically select their mapped artifact on a single click; only static
    // calls drill into a callee on double-click. The surface adapter owns the corresponding action.
    canNavigate: data.runtime === undefined
      && data.targetId !== null
      && (data.navigable ?? data.expandable),
    data: data as unknown as Record<string, unknown>,
  };
}

function controlBaseNodeModel(instanceId: string, data: LogicNodeData): BaseNodeModel {
  return {
    instanceId,
    targetId: data.targetId,
    nodeType: "control",
    kind: data.logicKind,
    semantics: data.semantics,
    label: data.label,
    childCount: data.childCount,
    canExpand: data.expandable,
    expanded: data.isExpanded,
    // Controls navigate into their stored body paths rather than through an artifact target.
    canNavigate: (data.bodies?.length ?? 0) > 0,
    data: data as unknown as Record<string, unknown>,
  };
}

function runtimeDomAttributes(
  kind: NonNullable<LogicNodeData["runtime"]>["kind"],
  status: NonNullable<LogicNodeData["runtime"]>["status"],
  targetId: string | null,
  expanded: boolean,
): React.HTMLAttributes<HTMLDivElement> {
  return {
    "data-request-runtime-kind": kind,
    "data-request-runtime-status": status,
    "data-request-runtime-target": targetId ?? undefined,
    "data-request-runtime-expanded": expanded ? "true" : "false",
  } as React.HTMLAttributes<HTMLDivElement>;
}

function BlockNode({ id, data }: NodeProps<LogicRfNode>) {
  const { showCode, expandCode, closeCode } = useBlueprintActions();
  const index = useBlueprint((s) => s.index);
  const sourceUrl = useBlueprint((s) => s.sourceUrl);
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const flowPaneOrigin = useBlueprint((s) => s.flowPaneOrigin);
  const syntheticSelectedMomentId = useBlueprint((s) => s.syntheticSelectedMomentId);
  const requestSelected = useBlueprint((s) => (
    s.flowPaneOrigin === "request" && s.moduleSelected.size === 1
      ? [...s.moduleSelected][0] ?? null
      : null
  ));
  const codeView = useBlueprint((s) => s.codeView);
  const artifact = useBlueprint((s) => s.artifact);
  const coverageMode = useBlueprint((s) => s.coverageMode);
  const coverage = useBlueprint((s) => (s.coverageMode ? s.coverage : null));
  const execution = useMemo(
    () => (coverageMode ? executionCoverageIndex(artifact) : null),
    [artifact, coverageMode],
  );
  const d = data as LogicNodeData;
  const select = d.runtime && flowPaneOrigin === "synthetic" && syntheticSelectedMomentId !== null
    ? syntheticOccurrenceSelectState(id, syntheticSelectedMomentId)
    : selectStateFor(d.targetId, d.runtime ? requestSelected : logicSelected);
  const changedStatus = d.changedStatus
    ?? (d.definition && d.targetId ? index.changedStatus.get(d.targetId) : undefined);
  const changed = changedStatus !== undefined;
  const changedRing = changedColor(changedStatus);
  const targetChangedStatus = d.definition ? undefined : d.targetChangedStatus;
  if (d.runtime) {
    return <RequestRuntimeBlock id={id} data={d} select={select} />;
  }
  const model = callableBaseNodeModel(id, d);
  // Method/function identity is rendered textually by BaseNode. The accent remains a fast secondary
  // cue without forcing readers to memorize the former ƒ/∷ glyph vocabulary.
  // In coverage mode the title bar recolors by the CALLEE's coverage verdict (green/amber/red), so the
  // exec flow doubles as a coverage map; otherwise it keeps the call/method/def accent.
  const executionEvidence = executionEvidenceForCallTarget(d.targetId, d.resolution, index, execution);
  const covVerdict = execution
    ? executionEvidence?.verdict ?? null
    : coverage ? callTargetCoverageVerdict(d.targetId, d.resolution, coverage) : null;
  const covAccent = covVerdict ? COVERAGE_COLORS[covVerdict] : null;
  const accent = covAccent ?? (d.asyncEvent?.kind === "barrier" ? AWAIT_ACCENT : d.definition ? DEF_ACCENT : d.callKind === "method" ? METHOD_ACCENT : BLOCK_ACCENT);
  // The explicit per-node coverage signal: a dark-tracked "battery" that reads on ANY title colour
  // (a coverage-tinted title would swallow a coverage-tinted badge). Only for measured callees.
  const battery = covVerdict === "covered" || covVerdict === "indirect" || covVerdict === "uncovered"
    ? <CoverageBattery
        verdict={covVerdict}
        title={execution
          ? executionEvidence
            ? executionEvidence.hits > 0
              ? `Executed · ${executionEvidence.hits} aggregate hit${executionEvidence.hits === 1 ? "" : "s"}`
              : "Not executed · instrumented with 0 hits"
            : "Execution coverage unknown"
          : undefined}
      />
    : null;
  const codeNode = d.targetId ? index.nodesById.get(d.targetId) : undefined;
  const canCode = isSourceBackedNode(codeNode) && Boolean(sourceUrl);
  // The inline box shows only for THIS block's own target, and only while the store keeps it in
  // the compact "inline" mode (the modal takes over once expandCode flips mode → "modal").
  const showingInline = codeNode != null && codeView != null && codeView.node.id === codeNode.id && codeView.mode === "inline";
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const toggleCode = () => {
    void showCode(codeNode!);
    expandCode();
  };
  const codeButton = canCode && codeNode ? (
    <button type="button" style={d.compact ? COMPACT_CODE_BTN : CODE_BTN} title="view source" onClick={(e) => { stop(e); toggleCode(); }}>{"</>"}</button>
  ) : null;
  const inline = showingInline && codeView ? <CodeInlinePanel codeView={codeView} onExpand={expandCode} onClose={closeCode} /> : null;
  if (d.isContainer) {
    return (
      <div style={WRAP} data-coverage-verdict={covVerdict ?? undefined}>
        <ContainerFrame
          model={model}
          accent={accent}
          provenance={d.provenance}
          select={select}
          indicators={(
            <>
              {battery}
              {changed ? <ChangedTag color={changedRing} /> : null}
              {targetChangedStatus ? <TargetChangedTag status={targetChangedStatus} /> : null}
              {d.definition ? <span style={DEF_TAG}>def</span> : null}
            </>
          )}
          actions={codeButton}
          changedRing={changed ? changedRing : null}
          nestedNotAwaitedCount={d.semantics?.nestedNotAwaited}
          emptyFlow={d.emptyFlow === true}
        />
        <AsyncDecoration d={d} />
        {inline}
      </div>
    );
  }
  // A leaf stays physically smaller without being semantically faded. Resolution owns its costume:
  // an internal leaf is filled, an external/platform call is hollow and hatched, and an unresolved
  // call is a broken coral outline. Expandability no longer masquerades as trust.
  if (d.compact) {
    const compactAccent = callScopeAccent(d.callScope, accent);
    return (
      <div style={WRAP} data-coverage-verdict={covVerdict ?? undefined}>
        <BaseNode
          model={model}
          style={withChanged(selectStyle(compactBodyStyle(d.callScope, compactAccent), select), changed ? changedRing : null, select)}
          headerStyle={compactTitleStyle(d.callScope, compactAccent)}
          labelStyle={NAME}
          indicators={(
            <>
              {battery}
              {changed ? <ChangedTag color={changedRing} /> : null}
              {targetChangedStatus ? <TargetChangedTag status={targetChangedStatus} /> : null}
            </>
          )}
          actions={codeButton}
          ports={<ExecPins />}
          title={d.navigable ? "Double-click to open this callable's logic" : d.callScope === "external" ? "External call boundary" : undefined}
        >
          {d.provenance ? <div style={COMPACT_PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.module}</div> : null}
          {(d.semantics?.nestedNotAwaited ?? 0) > 0 ? <span style={NESTED_DETACHED_RAIL} aria-hidden="true" /> : null}
        </BaseNode>
        <AsyncDecoration d={d} />
        {inline}
      </div>
    );
  }
  // A normal block is an expandable call. BaseNode appends expand-in-place after </> in the shared
  // action rail; a single body click selects and a double-click dives.
  // The relative WRAP (not clipped) hosts the clipped body PLUS the inline box hanging below it.
  return (
    <div style={WRAP} data-coverage-verdict={covVerdict ?? undefined}>
      <BaseNode
        model={model}
        style={withChanged(selectStyle(BODY, select), changed ? changedRing : null, select)}
        headerStyle={titleStyle(accent)}
        labelStyle={NAME}
        indicators={(
          <>
            {battery}
            {changed ? <ChangedTag color={changedRing} /> : null}
            {targetChangedStatus ? <TargetChangedTag status={targetChangedStatus} /> : null}
            {d.definition ? <span style={DEF_TAG}>def</span> : null}
          </>
        )}
        actions={codeButton}
        ports={<ExecPins />}
      >
        {/* A FRAMED block sits inside its service frame, whose title already names the owner — so it
            drops the provenance line and shows just name + signature. A standalone/external call (or a
            definition grid cell) keeps its `pkg › module` provenance. */}
        {!d.framed && d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
        {/* The signature — WHAT the block calls. Definition grid cells are a fixed compact size, so
            they opt out; only in-flow call blocks carry it. */}
        {!d.definition && d.signature ? <div style={SIGNATURE} title={d.signature}>{d.signature}</div> : null}
        {(d.semantics?.nestedNotAwaited ?? 0) > 0 ? <span style={NESTED_DETACHED_RAIL} aria-hidden="true" /> : null}
      </BaseNode>
      <AsyncDecoration d={d} />
      {inline}
    </div>
  );
}

/** One concrete request moment. It deliberately reads apart from a static call block: the title
 * says what was observed (span/decision/loop/exception), while the body carries caller/timing and
 * privacy-safe captured values. The normal exec pins let the existing Logic layout draw the actual
 * request order through these occurrence-specific cards. */
function RequestRuntimeBlock(props: { id: string; data: LogicNodeData; select: SelectState }) {
  const runtime = props.data.runtime!;
  const baseModel = callableBaseNodeModel(props.id, props.data);
  const model = runtime.focused ? { ...baseModel, canExpand: false } : baseModel;
  const accent = runtimeAccent(runtime.kind, runtime.status);
  const glyph = runtime.kind === "span"
    ? "▶"
    : runtime.kind === "branch"
      ? "◆"
      : runtime.kind === "loop"
        ? "↻"
        : runtime.kind === "exception"
        ? "⚡"
          : "⤳";
  if (props.data.isContainer) {
    return (
      <BaseNode
        model={model}
        style={selectStyle(frameStyle(accent), props.select)}
        headerStyle={runtimeTitleStyle(accent)}
        labelStyle={NAME}
        leading={<span style={GLYPH}>{glyph}</span>}
        indicators={(
          <>
            {runtime.durationMs === undefined ? null : <span style={RUNTIME_DURATION}>{formatRuntimeDuration(runtime.durationMs)}</span>}
            {runtime.eventCount === undefined || runtime.eventCount === 0 ? null : <span style={RUNTIME_EVENT_COUNT}>{runtime.eventCount} evt</span>}
            {runtime.badges?.slice(0, 2).map((badge, index) => (
              <span key={`${index}:${badge}`} style={RUNTIME_FRAME_BADGE} title={badge}>{badge}</span>
            ))}
            {(runtime.badges?.length ?? 0) > 2 ? <span style={RUNTIME_MORE}>+{runtime.badges!.length - 2}</span> : null}
            {runtime.status === undefined ? null : <span style={runtimeStatusStyle(runtime.status)}>{runtime.status}</span>}
          </>
        )}
        ports={<ExecPins />}
        domAttributes={runtimeDomAttributes(runtime.kind, runtime.status, props.data.targetId, true)}
        title={[runtime.detail, ...(runtime.badges ?? [])].filter(Boolean).join(" · ")}
      >
        {runtime.focused ? null : <SnapshotRows snapshot={runtime.snapshot} spanMomentId={props.id} compact />}
        {props.data.emptyFlow ? <EmptyNodeExpansion /> : null}
      </BaseNode>
    );
  }
  return (
    <div style={WRAP}>
      <BaseNode
        model={model}
        style={selectStyle({ ...RUNTIME_BODY, cursor: props.data.targetId === null ? "default" : "pointer" }, props.select)}
        headerStyle={runtimeTitleStyle(accent)}
        labelStyle={NAME}
        leading={<span style={GLYPH}>{glyph}</span>}
        indicators={(
          <>
            {runtime.durationMs === undefined ? null : <span style={RUNTIME_DURATION}>{formatRuntimeDuration(runtime.durationMs)}</span>}
            {runtime.eventCount === undefined || runtime.eventCount === 0 ? null : <span style={RUNTIME_EVENT_COUNT}>{runtime.eventCount} evt</span>}
            {runtime.status === undefined ? null : <span style={runtimeStatusStyle(runtime.status)}>{runtime.status}</span>}
          </>
        )}
        ports={<ExecPins />}
        domAttributes={runtimeDomAttributes(runtime.kind, runtime.status, props.data.targetId, false)}
        title={props.data.targetId === null ? undefined : "Highlight this observed code node on the graph"}
      >
        {runtime.detail ? <div style={RUNTIME_DETAIL} title={runtime.detail}>{runtime.detail}</div> : null}
        {runtime.focused ? null : <SnapshotRows snapshot={runtime.snapshot} spanMomentId={props.id} />}
        {runtime.badges && runtime.badges.length > 0 ? (
          <div style={RUNTIME_BADGES}>
            {runtime.badges.slice(0, 3).map((badge, index) => (
              <span key={`${index}:${badge}`} style={RUNTIME_BADGE} title={badge}>{badge}</span>
            ))}
            {runtime.badges.length > 3 ? <span style={RUNTIME_MORE}>+{runtime.badges.length - 3}</span> : null}
          </div>
        ) : null}
      </BaseNode>
    </div>
  );
}

function SnapshotRows(props: {
  snapshot: NonNullable<LogicNodeData["runtime"]>["snapshot"];
  spanMomentId: string;
  compact?: boolean;
}) {
  if (props.snapshot === undefined) return null;
  const output = props.snapshot.error === undefined
    ? snapshotValue(props.snapshot.output)
    : `ERROR · ${props.snapshot.error}`;
  return (
    <div
      style={props.compact ? RUNTIME_SNAPSHOT_ROWS_COMPACT : RUNTIME_SNAPSHOT_ROWS}
      data-synthetic-snapshot={props.spanMomentId}
      aria-label="Synthetic input and output snapshot"
    >
      <SnapshotRow label="IN" value={snapshotValue(props.snapshot.input)} />
      <SnapshotRow label="OUT" value={output} error={props.snapshot.error !== undefined} />
    </div>
  );
}

function SnapshotRow(props: { label: "IN" | "OUT"; value: string; error?: boolean }) {
  return (
    <div style={RUNTIME_SNAPSHOT_ROW} aria-label={`${props.label} ${props.value}`}>
      <span style={props.error ? RUNTIME_SNAPSHOT_LABEL_ERROR : RUNTIME_SNAPSHOT_LABEL}>{props.label}</span>
      <span style={props.error ? RUNTIME_SNAPSHOT_VALUE_ERROR : RUNTIME_SNAPSHOT_VALUE} title={props.value}>{props.value}</span>
    </div>
  );
}

function snapshotValue(value: unknown): string {
  if (value === undefined) return "—";
  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length <= 90 ? rendered : `${rendered.slice(0, 87)}…`;
}

function runtimeAccent(kind: NonNullable<LogicNodeData["runtime"]>["kind"], status: NonNullable<LogicNodeData["runtime"]>["status"]): string {
  if (status === "error") return "#D75B64";
  if (kind === "span") return status === "ok" ? "#58C9A3" : "#657181";
  if (kind === "branch") return "#E6B84D";
  if (kind === "loop") return "#61C4D8";
  if (kind === "exception") return "#D98A5B";
  return "#9B7BD8";
}

function formatRuntimeDuration(durationMs: number): string {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  if (durationMs >= 10) return `${durationMs.toFixed(1)}ms`;
  return `${durationMs.toFixed(2)}ms`;
}

/**
 * A SERVICE FRAME: the logic-flow analog of a composition scorecard. Consecutive calls into the same
 * owning unit nest inside it, so the flat exec chain reads UML-like (containers, like the composition
 * view). Its title shows the unit — a health dot + kind glyph + name (+ smell marker) + a count of the
 * calls it frames — health-tinted so the frame's health reads at a glance; DOUBLE-clicking the frame
 * opens that unit in the Service-composition view (handled by the view, so single click never
 * navigates). It carries NO exec pins: the white wires thread between the child blocks across frames,
 * never through the frame itself. The body stays transparent for ELK-placed children.
 */
function ServiceGroupNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as LogicNodeData;
  const owner = d.owner;
  if (!owner) {
    return null; // a service frame is only ever emitted WITH an owner; defensive against a bad spec.
  }
  return (
    <div style={serviceFrameStyle(owner.health)}>
      <div style={{ ...SERVICE_RAIL, background: owner.health }} />
      <div style={SERVICE_TITLE} title="Double-click to open in Service composition">
        <span style={{ ...SERVICE_DOT, background: owner.health }} />
        <span style={NAME} title={owner.label}>{owner.label}</span>
        {/* The textual kind label is the one kind marker — the ◆/◇/❑ glyph vocabulary is retired. */}
        <span style={SERVICE_KIND}>{owner.kind.toUpperCase()}</span>
        {owner.smelly ? <span style={SERVICE_SMELL} title="carries a design smell">⚠</span> : null}
        <span style={SERVICE_COUNT}>{d.childCount}</span>
      </div>
    </div>
  );
}

function ControlNode({ id, data }: NodeProps<LogicRfNode>) {
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const model = controlBaseNodeModel(id, d);
  const select = selectStateFor(d.targetId, logicSelected);
  const accent = CONTROL_ACCENT[d.logicKind] ?? LOOP_ACCENT;
  const glyph = CONTROL_GLYPH[d.logicKind] ?? "↻";
  const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
  if (d.isContainer) {
    return (
      <ContainerFrame
        model={model}
        accent={accent}
        provenance={null}
        select={select}
        indicators={changedRing === null ? null : <ChangedTag color={changedRing} />}
        changedRing={changedRing}
        emptyFlow={d.emptyFlow === true}
      />
    );
  }
  // No whole-node onClick: a single click on a container would fight both node selection and the
  // double-click-to-dive gesture. Collapse/expand is the explicit title button only (collapsed → ▸).
  return (
    <BaseNode
      model={model}
      style={withChanged(selectStyle(BODY, select), changedRing, select)}
      headerStyle={titleStyle(accent)}
      labelStyle={NAME}
      leading={<span style={GLYPH}>{glyph}</span>}
      indicators={(
        <>
          <span style={COUNT}>{d.childCount}</span>
          {changedRing === null ? null : <ChangedTag color={changedRing} />}
        </>
      )}
      ports={<ExecPins />}
    />
  );
}

function BranchNode({ id, data }: NodeProps<LogicRfNode>) {
  const orientation = useLogicFlowOrientation();
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const model = controlBaseNodeModel(id, d);
  const select = selectStateFor(d.targetId, logicSelected);
  const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
  const ports = d.isExpanded ? (
    <>
      <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={PIN} isConnectable={false} />
      {(d.branchPorts ?? []).map((port, index, all) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={orientation === "horizontal" ? Position.Right : Position.Bottom}
          style={orientation === "horizontal"
            ? { ...BRANCH_PIN, top: branchPortTop(index, all.length) }
            : { ...BRANCH_PIN, left: branchPortTop(index, all.length) }}
          isConnectable={false}
          title={port.label}
        />
      ))}
    </>
  ) : <ExecPins />;
  return (
    <BaseNode
      model={model}
      style={withChanged(structuralBodyStyle(BRANCH_ACCENT), changedRing, select)}
      headerStyle={structuralHeaderStyle(BRANCH_ACCENT)}
      labelStyle={NAME}
      labelContent={conditionText(d.label)}
      labelTitle={d.label}
      leading={<span style={{ ...STRUCTURAL_GLYPH, color: BRANCH_ACCENT }}>◇</span>}
      indicators={(
        <>
          <span style={COUNT}>{d.branchPorts?.length ?? d.childCount}</span>
          {changedRing === null ? null : <ChangedTag color={changedRing} />}
        </>
      )}
      ports={ports}
      title={d.isExpanded ? "Collapse to hide branch paths" : "Expand to show branch paths"}
    />
  );
}

/** TRY/CATCH is an exception gate, not a decision. The normal route enters and leaves at the same
 * height through an ivory trunk; the catch outlet sits lower and uses the amber exception colour.
 * Its edge is dashed by `logicElk`, so the visual grammar reads "peels off on throw". */
function ExceptionNode({ id, data }: NodeProps<LogicRfNode>) {
  const orientation = useLogicFlowOrientation();
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const model = controlBaseNodeModel(id, d);
  const select = selectStateFor(d.targetId, logicSelected);
  const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
  const ports = d.isExpanded ? (
    <>
      <Handle
        type="target"
        position={orientation === "horizontal" ? Position.Left : Position.Top}
        style={orientation === "horizontal" ? { ...PIN, top: "50%" } : { ...PIN, left: "50%" }}
        isConnectable={false}
      />
      {(d.branchPorts ?? []).map((port, index, all) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={orientation === "horizontal" ? Position.Right : Position.Bottom}
          style={exceptionPinStyle(port, index, all.length, orientation)}
          isConnectable={false}
          title={port.label}
        />
      ))}
    </>
  ) : <ExecPins />;
  return (
    <BaseNode
      model={model}
      style={withChanged(structuralBodyStyle(TRY_ACCENT), changedRing, select)}
      headerStyle={structuralHeaderStyle(TRY_ACCENT)}
      labelStyle={NAME}
      labelContent="protected block"
      labelTitle={d.label}
      leading={<span style={{ ...STRUCTURAL_GLYPH, color: TRY_ACCENT }}>!</span>}
      indicators={(
        <>
          <span style={STRUCTURAL_ROLE}>CATCH</span>
          {changedRing === null ? null : <ChangedTag color={changedRing} />}
        </>
      )}
      ports={ports}
      title={d.isExpanded ? "Collapse to hide try/catch paths" : "Expand to show try/catch paths"}
    />
  );
}

/** Mandatory cleanup checkpoint after TRY/CATCH lanes reconverge. It sits on the single exec trunk,
 * so topology says "always" before the tag does; the paired amber bars read as a phase boundary,
 * never as another optional branch or ordinary call. */
function FinallyNode({ id, data }: NodeProps<LogicRfNode>) {
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const model = controlBaseNodeModel(id, d);
  const select = selectStateFor(d.targetId, logicSelected);
  const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
  return (
    <BaseNode
      model={model}
      style={withChanged(structuralBodyStyle(TRY_ACCENT), changedRing, select)}
      headerStyle={structuralHeaderStyle(TRY_ACCENT)}
      labelStyle={NAME}
      labelContent="cleanup"
      labelTitle={d.label}
      leading={<span style={{ ...STRUCTURAL_GLYPH, color: TRY_ACCENT }}>↦</span>}
      indicators={(
        <>
          <span style={STRUCTURAL_ROLE}>ALWAYS</span>
          {changedRing === null ? null : <ChangedTag color={changedRing} />}
        </>
      )}
      ports={<ExecPins />}
      title={d.isExpanded ? "Collapse to hide cleanup steps" : "Expand to show cleanup steps"}
    >
      {d.emptyFlow && d.isExpanded ? <EmptyNodeExpansion message="No charted cleanup steps" /> : null}
    </BaseNode>
  );
}

function exceptionPinStyle(
  port: LogicBranchPort,
  index: number,
  count: number,
  orientation: "horizontal" | "vertical",
): React.CSSProperties {
  const placement = (position: string): React.CSSProperties => orientation === "horizontal"
    ? { top: position }
    : { left: position };
  if (port.role === "try") {
    return { ...EXCEPTION_NORMAL_PIN, ...placement("50%") };
  }
  if (port.role === "catch") {
    return { ...EXCEPTION_CATCH_PIN, ...placement("82%") };
  }
  return { ...EXCEPTION_CATCH_PIN, ...placement(branchPortTop(index, count)) };
}

/** Explicit branch reconvergence. A one-way open funnel deliberately avoids the closed diamond
 * silhouette reserved for decisions. A return/throw arm dead-ends before it and never arrives here. */
function JoinNode() {
  const orientation = useLogicFlowOrientation();
  return (
    <div style={JOIN_WRAP} title="Branch paths merge" role="img" aria-label="Branch paths merge">
      <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={JOIN_INPUT_PIN} isConnectable={false} />
      <Handle type="source" position={orientation === "horizontal" ? Position.Right : Position.Bottom} style={JOIN_OUTPUT_PIN} isConnectable={false} />
      <svg viewBox="0 0 42 72" preserveAspectRatio="none" style={orientation === "horizontal" ? BRANCH_SVG : JOIN_SVG_VERTICAL} aria-hidden="true">
        <path d="M4 9 L25 36 L4 63" fill="none" stroke={BRANCH_ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d="M25 36 H40" fill="none" stroke={FLOW_COLORS.ink} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx="25" cy="36" r="4.5" fill={FLOW_COLORS.ink} />
      </svg>
    </div>
  );
}

/** A later `await pending` is a real execution gate: the ivory exec thread enters/leaves sideways,
 * while the cyan lifetime rail lands on one of the sockets below. */
function AsyncNode({ id, data }: NodeProps<LogicRfNode>) {
  const d = data as LogicNodeData;
  const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
  const model = { ...controlBaseNodeModel(id, d), nodeType: "async" };
  return (
    <BaseNode
      model={model}
      style={withChanged(ASYNC_GATE_BODY, changedRing, "none")}
      headerStyle={ASYNC_GATE_HEADER}
      labelStyle={ASYNC_GATE_LABEL}
      leading={<span style={ASYNC_GATE_GLYPH}>⌟</span>}
      ports={<><ExecPins /><AsyncPortHandles ports={d.asyncPorts} /></>}
      title={d.label}
    >
      <div style={ASYNC_GATE_HATCH} />
      {changedRing === null ? null : <StructuralChangedMarker color={changedRing} />}
    </BaseNode>
  );
}

/**
 * The full decision condition for the Branch node's inline panel: the leading `if`/`switch` keyword is
 * dropped (the diamond shape already says "decision"), leaving just the condition expression. NOT
 * truncated — the panel exists precisely to show the whole thing.
 */
function conditionText(label: string): string {
  return label.replace(/^(if|switch)\b\s*/, "").trim() || label;
}

/** A framed container (expanded call / loop / callback / try-finally fallback): a title bar sits
 * over ELK's reserved top pad; child nodes render in the space below. BaseNode owns the shared
 * collapse control and keeps it as the final title action. */
function ContainerFrame(props: {
  model: BaseNodeModel;
  accent: string;
  provenance: LogicNodeData["provenance"];
  select: SelectState;
  indicators?: React.ReactNode;
  actions?: React.ReactNode;
  changedRing?: string | null;
  nestedNotAwaitedCount?: number;
  emptyFlow?: boolean;
}) {
  return (
    <BaseNode
      model={props.model}
      style={withChanged(selectStyle(frameStyle(props.accent), props.select), props.changedRing ?? null, props.select)}
      headerStyle={frameTitleStyle(props.accent)}
      labelStyle={NAME}
      indicators={(
        <>
          {props.provenance ? <span style={FRAME_PROV}>{props.provenance.pkg} › {props.provenance.module}</span> : null}
          {props.indicators}
        </>
      )}
      actions={props.actions}
      ports={<ExecPins />}
    >
      {(props.nestedNotAwaitedCount ?? 0) > 0 ? <span style={NESTED_DETACHED_RAIL} aria-hidden="true" /> : null}
      {props.emptyFlow ? <EmptyNodeExpansion /> : null}
    </BaseNode>
  );
}

/**
 * The per-node coverage "battery": a dark-tracked mini progress bar (with a battery nub) whose fill
 * and colour show how well the callee is covered — full green when a test hits it directly, ~60%
 * amber when tests only reach it through other code, near-empty red when nothing tests it. The dark
 * track keeps it legible on ANY title colour (a coverage-tinted badge on a coverage-tinted bar
 * vanished); the verdict rides the hover title and aria-label so it's not colour-only.
 */
const BATTERY_FILL_FRACTION: Record<CoverageVerdict, number> = { covered: 1, indirect: 0.6, uncovered: 0.12, test: 0, none: 0 };
const BATTERY_TITLE: Record<CoverageVerdict, string> = {
  covered: "Tested directly",
  indirect: "Reached by tests (via other code)",
  uncovered: "Untested",
  test: "Test code",
  none: "Not measured",
};
function CoverageBattery({ verdict, title = BATTERY_TITLE[verdict] }: { verdict: CoverageVerdict; title?: string }) {
  const color = COVERAGE_COLORS[verdict];
  return (
    <span style={BATTERY_WRAP} title={title} aria-label={`Coverage: ${title}`}>
      <span style={BATTERY_TRACK}>
        <span style={{ ...BATTERY_FILL, width: `${BATTERY_FILL_FRACTION[verdict] * 100}%`, background: color }} />
      </span>
      <span style={{ ...BATTERY_NUB, background: color }} />
    </span>
  );
}

/** Structural async marks around a call card. The local direct-await loop is self-contained; launch
 * sockets and barrier inputs are the endpoints used by the cyan correlation-edge layer. */
function AsyncDecoration({ d }: { d: LogicNodeData }) {
  const event = d.asyncEvent;
  const promiseDetached = d.detached === true && d.semantics?.returnsPromise === true;
  if (!event && !promiseDetached) {
    return null;
  }
  return (
    <>
      <AsyncPortHandles ports={d.asyncPorts} />
      {event?.kind === "direct-await" || (!event && d.awaited) ? <DirectAwaitLoop /> : null}
      {event?.kind === "barrier" ? <BarrierComb count={event.inputs.length} /> : null}
      {event?.kind === "launch" && event.binding ? <VariableBead label={event.binding} filled /> : null}
      {promiseDetached ? <DetachedTail /> : null}
    </>
  );
}

function AsyncPortHandles({ ports }: { ports: LogicNodeData["asyncPorts"] }) {
  const orientation = useLogicFlowOrientation();
  if (!ports?.length) return null;
  return (
    <>
      {ports.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.direction}
          position={orientation === "horizontal" ? Position.Bottom : Position.Right}
          style={orientation === "horizontal"
            ? { ...ASYNC_PIN, left: asyncPortLeft(index, ports.length) }
            : { ...ASYNC_PIN, top: asyncPortLeft(index, ports.length) }}
          isConnectable={false}
          title={port.label}
        />
      ))}
    </>
  );
}

function asyncPortLeft(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

function DirectAwaitLoop() {
  return (
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" style={DIRECT_AWAIT_LOOP} aria-hidden="true">
      <path d="M14 1 V12 Q14 16 19 16 H80 Q86 16 86 11 V1" fill="none" stroke={AWAIT_ACCENT} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx="14" cy="1" r="4" fill={AWAIT_ACCENT} vectorEffect="non-scaling-stroke" />
      <path d="M82 1 H90 M82 5 H90" stroke={AWAIT_ACCENT} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function BarrierComb({ count }: { count: number }) {
  return (
    <span style={BARRIER_COMB} aria-hidden="true">
      {Array.from({ length: Math.max(2, count) }, (_, index) => <i key={index} style={BARRIER_TOOTH} />)}
    </span>
  );
}

function VariableBead({ label, filled }: { label: string; filled: boolean }) {
  return <span style={VARIABLE_BEAD_WRAP} title={`Promise ${filled ? "stored as" : "read from"} ${label}`}><i style={filled ? VARIABLE_BEAD_FILLED : VARIABLE_BEAD_HOLLOW} /><span>{label}</span></span>;
}

function DetachedTail() {
  const explanation = "Detached async work starts here; execution continues immediately; this promise is never awaited in this flow.";
  return (
    <span style={DETACHED_TAIL} title={explanation} role="img" aria-label={explanation}>
      <svg viewBox="0 0 120 30" preserveAspectRatio="none" style={DETACHED_RAY} aria-hidden="true">
        {/* Solid at the call: work starts HERE, then visibly peels away from the white exec thread. */}
        <circle cx="4" cy="1.5" r="3.5" fill={DETACH_ACCENT} vectorEffect="non-scaling-stroke" />
        <path d="M4 2 V9 Q4 18 15 20" fill="none" stroke={DETACH_ACCENT} strokeWidth="2.25" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {/* No destination socket: the dashed lifetime leaves the flow through an open arrow. */}
        <path d="M15 20 H106" fill="none" stroke={DETACH_ACCENT} strokeWidth="2.25" strokeDasharray="7 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d="M105 14 L117 20 L105 26" fill="none" stroke={DETACH_ACCENT} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={DETACHED_LABEL}>continues · not awaited</span>
    </span>
  );
}

/**
 * A "jump-to-flow" satellite: a small dashed, muted ghost node the VIEW appends in a row ABOVE the
 * selected building block for every flow that (transitively) reaches its target. It sits in the
 * caller CHAIN, so it is BOTH ends of a jump wire: a source Handle on the BOTTOM (the wire runs DOWN
 * into the node one hop closer to the selection — a deeper ghost, or the selected block itself) AND
 * a target Handle on the TOP (a deeper caller's wire lands here), so the chain reads top→down.
 * Clicking it switches the canvas to that flow. Its data is minimal — a flow-root id, a display
 * label, a faint file path, and how many hops away it is (`depth`): 1 == direct, higher == indirect.
 */
export type JumpFlowNodeData = { rootId: string; label: string; file?: string; depth: number; test?: boolean };
type JumpFlowRfNode = Node<JumpFlowNodeData>;

function JumpFlowNode({ data }: NodeProps<JumpFlowRfNode>) {
  const { openLogicFlow } = useBlueprintActions();
  const d = data as JumpFlowNodeData;
  const changedStatus = useBlueprint((s) => s.index.changedStatus.get(d.rootId));
  const changed = changedStatus !== undefined;
  const changedRing = changedColor(changedStatus);
  // A test ghost (Show tests) reads apart from an ordinary caller ghost: violet dashed border + a
  // "TEST" tag, mirroring the coverage palette's test-code colour, so it's clearly "a test exercising
  // this method" rather than just another caller. Clicking still opens that node's own flow.
  const isTest = d.test === true;
  // A caller ghost is a shortcut into that flow (click to open); a test ghost is read-only context —
  // it just shows WHICH tests exercise this method, so it takes no click and shows no pointer cursor.
  return (
    <div style={withChanged(isTest ? JUMP_TEST_BODY : JUMP_BODY, changed ? changedRing : null, "none")} onClick={isTest ? undefined : () => openLogicFlow(d.rootId)} title={isTest ? `Test: ${d.label}` : `Open flow: ${d.label}`}>
      {/* Target pin on top (a deeper caller's wire lands here) + source pin on the bottom (this
          node's wire drops to the node one hop closer to the selection): the chain wires top→down. */}
      <Handle type="target" position={Position.Top} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={PIN} isConnectable={false} />
      <div style={JUMP_HEAD}>
        <span style={{ ...JUMP_GLYPH, ...(isTest ? { color: COVERAGE_COLORS.test } : {}) }}>{isTest ? "🧪" : "↗"}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {isTest ? (
          <span style={JUMP_TEST_TAG}>TEST</span>
        ) : d.depth > 1 ? (
          // An indirect caller (2+ hops back over the reverse call graph) wears a hop badge so it
          // reads apart from a direct caller; a direct caller (depth 1) needs none.
          <span style={JUMP_DEPTH_BADGE} title={`${d.depth} hops away`}>{`↑${d.depth}`}</span>
        ) : null}
        {changed ? <ChangedTag color={changedRing} /> : null}
      </div>
      {d.file ? <div style={JUMP_FILE} title={d.file}>{d.file}</div> : null}
    </div>
  );
}

/**
 * A flow END-CAP: the ENTRY the observed callable starts at, or the synthetic EXIT every trailing
 * path converges onto. Both are compact pills, not call blocks (no provenance/disclosure/code). The
 * ENTRY wears the callable's name and a left TARGET pin so the view's caller-ghosts — stacked in a
 * column to its left — wire INTO it, plus a right SOURCE pin the exec thread leaves through into the
 * first step. The EXIT is a dead end: a left TARGET pin, no source. Neither is a call site
 * (`targetId: null`), so clicking one is a harmless no-op.
 */
function TerminalNode({ data }: NodeProps<LogicRfNode>) {
  const orientation = useLogicFlowOrientation();
  const d = data as TerminalData;
  if (d.terminal === "entry") {
    const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
    return (
      <div style={withChanged(ENTRY_BODY, changedRing, "none")} title={`Flow entry: ${d.label}`}>
        <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={PIN} isConnectable={false} />
        <Handle type="source" position={orientation === "horizontal" ? Position.Right : Position.Bottom} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>▶</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {changedRing === null ? null : <ChangedTag color={changedRing} />}
        <span style={ENTRY_TAG}>ENTRY</span>
      </div>
    );
  }
  // A mid-flow `return`/`throw` cap: the red dead-end a terminated path stops at. Left target pin
  // only — nothing ever leaves a return, which is exactly the point.
  if (d.terminal === "return" || d.terminal === "throw") {
    const changedRing = d.changedStatus === undefined ? null : changedColor(d.changedStatus);
    return (
      <div style={withChanged(RETURN_BODY, changedRing, "none")} title={`Path ${d.terminal === "throw" ? "throws" : "returns"} here: ${d.label}`}>
        <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>{d.terminal === "throw" ? "⚡" : "⏎"}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {changedRing === null ? null : <ChangedTag color={changedRing} />}
      </div>
    );
  }
  return (
    <div style={EXIT_BODY} title="Flow exit">
      <Handle type="target" position={orientation === "horizontal" ? Position.Left : Position.Top} style={PIN} isConnectable={false} />
      <span style={TERMINAL_GLYPH}>■</span>
      <span style={NAME}>EXIT</span>
    </div>
  );
}

/**
 * A def-group FRAME: the structural container the module view groups a callable owner's methods
 * into — an object literal, a class, or the top-level `functions` bucket. It fills its laid-out box
 * with a titled, teal-tinted border; its body stays transparent so the def nodes React Flow parents
 * to it render OVER it. It is NOT an exec node — no exec pins, no target — so clicking it is a
 * harmless no-op (no selection/drill); only the def blocks inside it are interactive.
 */
function DefGroupNode({ id, data }: NodeProps<LogicRfNode>) {
  const d = data as DefGroupData;
  const model: BaseNodeModel = {
    instanceId: id,
    targetId: d.targetId,
    nodeType: "defgroup",
    kind: d.kind === "module" ? "functions" : d.kind,
    label: d.label,
    childCount: d.childCount,
    canExpand: d.expandable,
    expanded: d.isExpanded,
    canNavigate: false,
    data: d as unknown as Record<string, unknown>,
  };
  return (
    <BaseNode
      model={model}
      style={DEFGROUP_FRAME}
      headerStyle={d.isExpanded ? DEFGROUP_TITLE : DEFGROUP_COLLAPSED_TITLE}
      labelStyle={DEFGROUP_NAME}
      labelTitle={d.label}
      indicators={<span style={DEFGROUP_COUNT}>{d.childCount}</span>}
    />
  );
}

export const logicNodeTypes = { block: BlockNode, control: ControlNode, branch: BranchNode, exception: ExceptionNode, finally: FinallyNode, join: JoinNode, async: AsyncNode, jumpflow: JumpFlowNode, defgroup: DefGroupNode, servicegroup: ServiceGroupNode, terminal: TerminalNode };

// Selection is BY TARGET (a target can be called many times): a matched call site rings green so
// every call of the same target lights up together; while some target is selected, unrelated nodes
// dim so the matches pop. Structural nodes (loops/branches) carry no target, so they only ever dim.
export type SelectState = "selected" | "dimmed" | "none";
// The accent green shared with the emphasized logic edges (imported by LogicFlowView) so the node
// ring and the edge glow can't drift. Sourced from the flow palette — the alternate projections
// (metro/blocks/timeline) highlight with the very same token.
export const SELECT_ACCENT = FLOW_COLORS.select;

/** Synthetic execution selects occurrence identity, not the artifact target shared by repeated
 * calls. This pure seam keeps the exact-ring policy directly regression-testable. */
export function syntheticOccurrenceSelectState(momentId: string, selectedMomentId: string | null): SelectState {
  if (selectedMomentId === null) return "none";
  return momentId === selectedMomentId ? "selected" : "dimmed";
}

function selectStateFor(targetId: string | null, logicSelected: string | null): SelectState {
  if (logicSelected === null) {
    return "none";
  }
  return targetId !== null && targetId === logicSelected ? "selected" : "dimmed";
}

// Layer the selection state over a node's base style: a bright ring at full opacity when matched,
// a dim veil when some other target holds the selection.
function selectStyle(base: React.CSSProperties, select: SelectState): React.CSSProperties {
  if (select === "selected") {
    return { ...base, opacity: 1, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
  }
  if (select === "dimmed") {
    return { ...base, opacity: 0.5 };
  }
  return base;
}

// The flow palette (flowViewModel.FLOW_COLORS) is the single source for every semantic accent, so
// the exec graph and the alternate projections can never drift apart on what a colour means. The
// local names stay so the node styling below keeps reading in this file's own vocabulary.
const BLOCK_ACCENT = FLOW_COLORS.call;
// A small INDIGO shift off the blue call accent — same family, not a jarring new colour — so a method
// call (through a receiver / a class method) is distinguishable at a glance from a free function.
const METHOD_ACCENT = FLOW_COLORS.method;
// Teal, deliberately unlike the blue call accent: a definition node is a declaration ("defined
// here"), a different kind of thing from a call site in the flow.
const DEF_ACCENT = "#3FB8AF";
const EXTERNAL_ACCENT = "#92A1B4";
const UNRESOLVED_ACCENT = "#E06C6C";
const LOOP_ACCENT = FLOW_COLORS.loop;
const TRY_ACCENT = FLOW_COLORS.try;
// A deferred/handed-over callback (a hook body, `.then`, `setTimeout`, a JSX handler): a muted
// slate-cyan, deliberately cooler than the loop/try accents — it reads as "logic passed elsewhere",
// not control-flow that runs here and now.
const CALLBACK_ACCENT = FLOW_COLORS.callback;
// A dotted-arrow glyph for "handed to": the callback is given away, not run in place.
const CALLBACK_GLYPH = "⤳";
const CONTROL_ACCENT: Record<string, string> = { loop: LOOP_ACCENT, try: TRY_ACCENT, callback: CALLBACK_ACCENT };
const CONTROL_GLYPH: Record<string, string> = { loop: "↻", try: "⚠", callback: CALLBACK_GLYPH };
// Sky-blue outline: a branch reads as control-flow via its diamond SHAPE, so it can share the cool
// blue family without being mistaken for a call block — the brighter, cyan-leaning tone stays clear
// of the deeper azure call accent and the indigo method accent.
const BRANCH_ACCENT = FLOW_COLORS.branch;
// Near-canvas dark so the diamond is outline-first, never a flood of colour.
const BRANCH_FILL = "rgba(11,14,19,0.72)";
// A calm green marks the flow's START (evokes a "play"/entry point); a muted slate marks the neutral
// synthetic EXIT end-cap — deliberately quiet so it reads as a terminus, not another step.
const ENTRY_ACCENT = FLOW_COLORS.entry;
const EXIT_ACCENT = FLOW_COLORS.exit;
// A warm red for the return/throw caps a terminated path dead-ends at: unlike the quiet EXIT, an
// early return is a fact worth noticing, so it reads hot.
const RETURN_ACCENT = FLOW_COLORS.exitCap;
// Async semantics on a call block: cyan for an awaited (latent) call the thread holds for, violet
// for a detached fire-and-forget call whose result is dropped and may outlive the flow.
const AWAIT_ACCENT = FLOW_COLORS.awaited;
const DETACH_ACCENT = FLOW_COLORS.detached;

const PIN: React.CSSProperties = { width: 7, height: 7, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const CHANGED_TAG: React.CSSProperties = {
  flexShrink: 0,
  width: 15,
  height: 15,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  border: "1px solid",
  borderRadius: 4,
  fontSize: 9,
  fontWeight: 900,
  lineHeight: 1,
  boxShadow: "0 0 8px currentColor",
};
const TARGET_CHANGED_TAG: React.CSSProperties = {
  flexShrink: 0,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  border: "1px solid",
  borderRadius: 999,
  padding: "0 6px",
  fontSize: 7.5,
  fontWeight: 900,
  lineHeight: 1,
  letterSpacing: "0.055em",
  whiteSpace: "nowrap",
  boxShadow: "0 0 8px currentColor",
};
const STRUCTURAL_CHANGED_MARKER: React.CSSProperties = {
  position: "absolute",
  top: -6,
  right: -6,
  zIndex: 12,
  pointerEvents: "none",
};

// The block's outer shell: fills the node box and is NOT clipped, so the inline code box (an
// absolute child at top:100%) can hang below the body's overflow:hidden without being cut off.
const WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%", fontFamily: MONO };

const BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "#10151C",
  overflow: "hidden",
  fontFamily: MONO,
};

function callScopeAccent(scope: LogicNodeData["callScope"], internalAccent: string): string {
  return scope === "external" ? EXTERNAL_ACCENT : scope === "unresolved" ? UNRESOLVED_ACCENT : internalAccent;
}

function compactBodyStyle(scope: LogicNodeData["callScope"], accent: string): React.CSSProperties {
  if (scope === "external") {
    return {
      ...BODY,
      borderColor: `${accent}CC`,
      borderRadius: 4,
      backgroundColor: "#10151C",
      backgroundImage: "repeating-linear-gradient(-45deg, transparent 0 8px, rgba(146,161,180,0.055) 8px 10px)",
    };
  }
  if (scope === "unresolved") {
    return { ...BODY, border: `1px dashed ${accent}`, background: "rgba(224,108,108,0.035)" };
  }
  return { ...BODY, borderColor: `${accent}AA`, background: "#121823" };
}

function compactTitleStyle(scope: LogicNodeData["callScope"], accent: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 7px",
    borderBottom: `1px solid ${accent}55`,
    background: scope === "internal" ? `${accent}30` : "rgba(255,255,255,0.025)",
    color: scope === "unresolved" ? "#F0B8B8" : "#D8E0EA",
    fontSize: 10.5,
    fontWeight: 700,
    lineHeight: 1.25,
  };
}

const RUNTIME_BODY: React.CSSProperties = { ...BODY, borderColor: "#34404C", background: "#0F151C" };
const RUNTIME_DURATION: React.CSSProperties = { flexShrink: 0, marginLeft: "auto", fontSize: 9.5, fontVariantNumeric: "tabular-nums", opacity: 0.82 };
const RUNTIME_EVENT_COUNT: React.CSSProperties = { flexShrink: 0, fontSize: 8.5, fontVariantNumeric: "tabular-nums", opacity: 0.82 };
const RUNTIME_FRAME_BADGE: React.CSSProperties = { minWidth: 0, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "1px solid rgba(5,12,17,0.28)", borderRadius: 999, padding: "1px 6px", fontSize: 8.5, fontWeight: 500 };
const RUNTIME_DETAIL: React.CSSProperties = { padding: "7px 9px 3px", color: "#9EACBC", fontSize: 9.5, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const RUNTIME_BADGES: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 7px", overflow: "hidden" };
const RUNTIME_BADGE: React.CSSProperties = { minWidth: 0, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "1px solid #334150", borderRadius: 999, background: "rgba(101,137,166,0.09)", color: "#AAB9C8", padding: "1px 6px", fontSize: 8.5 };
const RUNTIME_MORE: React.CSSProperties = { flexShrink: 0, color: "#768697", fontSize: 8.5 };
const RUNTIME_SNAPSHOT_ROWS: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3, padding: "5px 8px 1px", overflow: "hidden" };
const RUNTIME_SNAPSHOT_ROWS_COMPACT: React.CSSProperties = { ...RUNTIME_SNAPSHOT_ROWS, padding: "4px 9px 0" };
const RUNTIME_SNAPSHOT_ROW: React.CSSProperties = { minWidth: 0, height: 16, display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 8.5 };
const RUNTIME_SNAPSHOT_LABEL: React.CSSProperties = { width: 26, flexShrink: 0, border: "1px solid #376454", borderRadius: 4, color: "#70D2AF", background: "rgba(88,201,163,0.09)", textAlign: "center", fontSize: 7.5, fontWeight: 800, letterSpacing: "0.06em" };
const RUNTIME_SNAPSHOT_LABEL_ERROR: React.CSSProperties = { ...RUNTIME_SNAPSHOT_LABEL, borderColor: "#79434A", color: "#F08A91", background: "rgba(240,120,124,0.09)" };
const RUNTIME_SNAPSHOT_VALUE: React.CSSProperties = { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#B6C5D3" };
const RUNTIME_SNAPSHOT_VALUE_ERROR: React.CSSProperties = { ...RUNTIME_SNAPSHOT_VALUE, color: "#E7A0A4" };

const BRANCH_PIN: React.CSSProperties = { ...PIN, width: 8, height: 8, background: BRANCH_ACCENT, boxShadow: `0 0 0 2px ${BRANCH_FILL}` };
function branchPortTop(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}
const EXCEPTION_NORMAL_PIN: React.CSSProperties = { ...PIN, width: 8, height: 8, background: FLOW_COLORS.ink, boxShadow: `0 0 0 2px ${FLOW_COLORS.canvas}` };
const EXCEPTION_CATCH_PIN: React.CSSProperties = { ...PIN, width: 9, height: 9, background: TRY_ACCENT, border: "1px solid #FFD0B2", boxShadow: `0 0 0 2px ${FLOW_COLORS.canvas}` };
// clip-path can't paint a border, so the diamond outline is an SVG polygon; non-scaling-stroke keeps
// the stroke a constant width while the polygon stretches (preserveAspectRatio="none") to the box.
const BRANCH_SVG: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" };
const JOIN_WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%" };
const JOIN_SVG_VERTICAL: React.CSSProperties = {
  ...BRANCH_SVG,
  transform: "rotate(90deg)",
  transformOrigin: "center",
};
const JOIN_INPUT_PIN: React.CSSProperties = { ...PIN, width: 7, height: 7, background: BRANCH_ACCENT, boxShadow: `0 0 0 2px ${FLOW_COLORS.canvas}` };
const JOIN_OUTPUT_PIN: React.CSSProperties = { ...PIN, width: 7, height: 7, background: FLOW_COLORS.ink, boxShadow: `0 0 0 2px ${FLOW_COLORS.canvas}` };

function titleStyle(accent: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 8px",
    background: accent,
    color: "#0B0E13",
    fontSize: 12,
    fontWeight: 700,
  };
}

function runtimeTitleStyle(accent: string): React.CSSProperties {
  return {
    ...titleStyle(accent),
    minHeight: 29,
    boxSizing: "border-box",
  };
}

function runtimeStatusStyle(status: "unset" | "ok" | "error"): React.CSSProperties {
  return {
    flexShrink: 0,
    border: "1px solid rgba(5,12,17,0.28)",
    borderRadius: 999,
    padding: "1px 5px",
    fontSize: 8,
    textTransform: "uppercase",
    color: status === "error" ? "#3D0710" : "#0B1B17",
    background: status === "error" ? "rgba(255,228,230,0.45)" : "rgba(232,255,247,0.35)",
  };
}

function frameStyle(accent: string): React.CSSProperties {
  return { width: "100%", height: "100%", boxSizing: "border-box", border: `1px solid ${accent}`, borderRadius: 10, background: "rgba(16,21,28,0.55)", fontFamily: MONO };
}
function frameTitleStyle(accent: string): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: `1px solid ${accent}`, color: accent, fontSize: 11, fontWeight: 700 };
}

/** Flat control-flow gates reuse BaseNode even though their expanded bodies remain sibling lanes. */
function structuralBodyStyle(accent: string): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    border: `1px solid ${accent}CC`,
    borderRadius: 8,
    background: "#10151C",
    overflow: "visible",
    fontFamily: MONO,
    boxShadow: `inset 3px 0 0 ${accent}55`,
  };
}

function structuralHeaderStyle(accent: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    padding: "0 9px",
    borderRadius: 7,
    background: `linear-gradient(90deg, ${accent}1F, rgba(16,21,28,0.96) 58%)`,
    color: "#DCE6F2",
    fontSize: 11,
    fontWeight: 700,
  };
}

const STRUCTURAL_GLYPH: React.CSSProperties = { flexShrink: 0, fontSize: 15, fontWeight: 850, lineHeight: 1 };
const STRUCTURAL_ROLE: React.CSSProperties = {
  flexShrink: 0,
  padding: "1px 4px",
  border: `1px solid ${TRY_ACCENT}99`,
  borderRadius: 3,
  color: TRY_ACCENT,
  fontSize: 7,
  fontWeight: 800,
  letterSpacing: "0.06em",
};

// The satellite "ghost" look: dashed border, muted fill/text — it reads as a detached shortcut, not
// a step in this flow. Full opacity (it's never dimmed by the selection) so it stays clickable.
const JUMP_BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px dashed #4B535F",
  borderRadius: 8,
  background: "rgba(16,21,28,0.6)",
  padding: "5px 9px",
  fontFamily: MONO,
  color: "#9AA4B2",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  overflow: "hidden",
};
// A test ghost: the same detached-shortcut shape as a caller ghost, re-tinted violet so it reads as
// test code (matching the coverage palette) rather than another caller in the flow.
const JUMP_TEST_BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: `1px dashed ${COVERAGE_COLORS.test}`,
  borderRadius: 8,
  background: "rgba(28,20,45,0.72)",
  padding: "5px 9px",
  fontFamily: MONO,
  color: "#C6BCE0",
  cursor: "default",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  overflow: "hidden",
};
const JUMP_TEST_TAG: React.CSSProperties = {
  marginLeft: "auto",
  flexShrink: 0,
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: COVERAGE_COLORS.test,
  border: `1px solid ${COVERAGE_COLORS.test}66`,
  borderRadius: 3,
  padding: "0 4px",
  background: "rgba(163,113,247,0.14)",
};
const JUMP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600 };
const JUMP_GLYPH: React.CSSProperties = { fontSize: 10, opacity: 0.8, color: "#7B8695" };
// The hop badge on an INDIRECT caller ghost: a quiet blue pill pinned at the row's right end, so a
// 2+-hops-away caller is distinguishable at a glance from a direct one (which carries no badge).
const JUMP_DEPTH_BADGE: React.CSSProperties = {
  marginLeft: "auto",
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  color: "#8FB6E3",
  border: "1px solid #2A3B4D",
  borderRadius: 3,
  padding: "0 4px",
  background: "rgba(59,122,192,0.15)",
};
const JUMP_FILE: React.CSSProperties = { fontSize: 9, color: "#6C7683", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// The coverage battery: a dark track + colour fill + a small nub, so it reads as a fuel gauge on any
// title colour. flex-none so it never squeezes the name; the nub is the battery's positive terminal.
const BATTERY_WRAP: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0 };
const BATTERY_TRACK: React.CSSProperties = {
  width: 30,
  height: 9,
  boxSizing: "border-box",
  borderRadius: 2,
  background: "#0B0E13",
  border: "1px solid rgba(0,0,0,0.45)",
  padding: 1,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
};
const BATTERY_FILL: React.CSSProperties = { height: "100%", borderRadius: 1, minWidth: 2 };
const BATTERY_NUB: React.CSSProperties = { width: 2, height: 5, borderRadius: 1, opacity: 0.55 };

// The entry/exit end-caps: a compact rounded pill (never a rectangular building block), tinted by its
// accent. Shared base; the entry keeps its ENTRY tag pinned right, the exit centres its bare caption.
const TERMINAL_BASE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 14px",
  borderRadius: 999,
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 700,
  overflow: "hidden",
};
const ENTRY_BODY: React.CSSProperties = { ...TERMINAL_BASE, border: `1px solid ${ENTRY_ACCENT}`, background: "rgba(79,180,119,0.12)", color: "#CDEAD9" };
const EXIT_BODY: React.CSSProperties = { ...TERMINAL_BASE, justifyContent: "center", border: `1px solid ${EXIT_ACCENT}`, background: "rgba(138,147,160,0.10)", color: "#B7C0CC" };
// A return/throw cap: warm red so a dead-ending path is unmissable; squared on the entry side and
// rounded on the far side, a one-way cap rather than a two-ended pill.
const RETURN_BODY: React.CSSProperties = {
  ...TERMINAL_BASE,
  fontSize: 11,
  border: `1px solid ${RETURN_ACCENT}`,
  borderRadius: "6px 999px 999px 6px",
  background: "rgba(224,108,108,0.10)",
  color: "#F0C9C9",
};
const TERMINAL_GLYPH: React.CSSProperties = { fontSize: 10, flexShrink: 0, opacity: 0.85 };
const ENTRY_TAG: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", border: `1px solid ${ENTRY_ACCENT}`, borderRadius: 3, padding: "1px 4px", color: ENTRY_ACCENT };

const NESTED_DETACHED_RAIL: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  borderRadius: "0 0 8px 8px",
  background: `repeating-linear-gradient(90deg, ${DETACH_ACCENT} 0 14px, ${DETACH_ACCENT}55 14px 20px, transparent 20px 25px)`,
  boxShadow: `0 0 7px ${DETACH_ACCENT}55`,
  pointerEvents: "none",
};

const ASYNC_PIN: React.CSSProperties = {
  width: 9,
  height: 9,
  minWidth: 0,
  minHeight: 0,
  border: `2px solid ${AWAIT_ACCENT}`,
  background: "#0B0E13",
  boxShadow: `0 0 7px ${AWAIT_ACCENT}88`,
};
const DIRECT_AWAIT_LOOP: React.CSSProperties = {
  position: "absolute",
  left: 14,
  right: 14,
  bottom: -17,
  width: "calc(100% - 28px)",
  height: 18,
  overflow: "visible",
  pointerEvents: "none",
};
const BARRIER_COMB: React.CSSProperties = {
  position: "absolute",
  right: -10,
  top: "18%",
  bottom: "18%",
  width: 11,
  borderLeft: `2px solid ${AWAIT_ACCENT}`,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-evenly",
  pointerEvents: "none",
  filter: `drop-shadow(0 0 4px ${AWAIT_ACCENT}66)`,
};
const BARRIER_TOOTH: React.CSSProperties = { width: 9, height: 2, background: AWAIT_ACCENT, display: "block" };
const VARIABLE_BEAD_WRAP: React.CSSProperties = {
  position: "absolute",
  left: 10,
  bottom: -25,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  color: "#8190A2",
  fontSize: 8.5,
  lineHeight: 1,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};
const VARIABLE_BEAD_FILLED: React.CSSProperties = { width: 7, height: 7, borderRadius: "50%", background: AWAIT_ACCENT, boxShadow: `0 0 5px ${AWAIT_ACCENT}88` };
const VARIABLE_BEAD_HOLLOW: React.CSSProperties = { width: 7, height: 7, boxSizing: "border-box", borderRadius: "50%", border: `1.5px solid ${AWAIT_ACCENT}` };
const DETACHED_TAIL: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "100%",
  width: "max(68%, 150px)",
  height: 40,
  pointerEvents: "none",
  color: DETACH_ACCENT,
};
const DETACHED_RAY: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: "100%",
  height: 30,
  overflow: "visible",
  filter: `drop-shadow(0 0 3px ${DETACH_ACCENT}66)`,
};
const DETACHED_LABEL: React.CSSProperties = {
  position: "absolute",
  left: 15,
  top: 28,
  padding: "1px 4px",
  borderRadius: 3,
  background: "rgba(11,14,19,0.88)",
  color: "#BDA6DE",
  fontFamily: MONO,
  fontSize: 7.5,
  fontWeight: 650,
  letterSpacing: "0.03em",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

const ASYNC_GATE_BODY: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  overflow: "visible",
  border: `1px solid ${AWAIT_ACCENT}`,
  borderLeftWidth: 3,
  borderRightWidth: 3,
  borderRadius: 6,
  background: "#101820",
  color: "#CFE9EC",
  fontFamily: MONO,
  boxShadow: `0 0 0 1px ${AWAIT_ACCENT}1F`,
};
const ASYNC_GATE_HEADER: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "0 9px",
};
const ASYNC_GATE_HATCH: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  borderRadius: 4,
  opacity: 0.5,
  background: `repeating-linear-gradient(-45deg, transparent 0 6px, ${AWAIT_ACCENT}13 6px 9px)`,
  pointerEvents: "none",
};
const ASYNC_GATE_GLYPH: React.CSSProperties = { position: "relative", color: AWAIT_ACCENT, fontSize: 17, lineHeight: 1 };
const ASYNC_GATE_LABEL: React.CSSProperties = { position: "relative", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, fontWeight: 650 };

const GLYPH: React.CSSProperties = { fontSize: 11, opacity: 0.85 };
const NAME: React.CSSProperties = { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const PROV: React.CSSProperties = { padding: "4px 8px", fontSize: 10, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
// The signature line: dimmer than provenance (secondary detail), mono, one clipped line — the full
// text rides the hover title so a long signature never widens the block.
const SIGNATURE: React.CSSProperties = { padding: "0 8px 3px", fontSize: 9.5, color: "#5F6874", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
// The service frame: a neutral-bordered container (like the composition card) with a health-tinted
// left rail, hosting the run's call blocks. Body transparent so ELK-placed children render over it.
function serviceFrameStyle(health: string): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    position: "relative",
    boxSizing: "border-box",
    border: "1px solid #2A2F37",
    borderLeft: `1px solid ${health}`,
    borderRadius: 10,
    background: "rgba(18,23,30,0.45)",
    fontFamily: MONO,
    overflow: "hidden",
  };
}
// The 3px health rail down the frame's left edge — the composition card's fastest health signal.
const SERVICE_RAIL: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 };
// The title bar is a click-through to the unit in the Service-composition view. Its height (~34px)
// sits under ELK's 42px container top padding so the child blocks clear it.
const SERVICE_TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  height: 34,
  boxSizing: "border-box",
  padding: "0 10px 0 12px",
  border: "none",
  borderBottom: "1px solid #232935",
  background: "rgba(255,255,255,0.02)",
  color: "#C8D3E0",
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 700,
};
const SERVICE_DOT: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };
const SERVICE_KIND: React.CSSProperties = { flexShrink: 0, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.06em", opacity: 0.75, border: "1px solid currentColor", borderRadius: 3, padding: "0 3px" };
const SERVICE_SMELL: React.CSSProperties = { flexShrink: 0, fontSize: 10, color: "#E6B84D" };
// The count of calls the frame wraps, pinned right (auto margin) so it never crowds the name.
const SERVICE_COUNT: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
// Compact leaves keep full contrast; smaller type/spacing communicates density, while their boundary
// costume communicates internal/external/unresolved independently.
const COMPACT_PROV: React.CSSProperties = { padding: "1px 7px 3px", fontSize: 9, lineHeight: 1.1, color: "#8A96A5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const FRAME_PROV: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: FRAME_PROVENANCE_MAX_WIDTH,
  fontSize: 9,
  fontWeight: 400,
  color: "#7B8695",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const COUNT: React.CSSProperties = { marginLeft: "auto", fontSize: 10, fontWeight: 600, opacity: 0.75 };
// The little "def" pill on a definition node's title: dark on the teal accent, so it reads as a
// quiet kind-tag ("defined here") without competing with the callable name beside it.
const DEF_TAG: React.CSSProperties = { flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid rgba(0,0,0,0.35)", borderRadius: 3, padding: "0 3px", opacity: 0.75 };
const CODE_BTN: React.CSSProperties = { marginLeft: "auto", border: "none", background: "rgba(0,0,0,0.18)", color: "#0B0E13", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontFamily: MONO, cursor: "pointer" };
const COMPACT_CODE_BTN: React.CSSProperties = { ...CODE_BTN, marginLeft: 0, border: "1px solid rgba(146,161,180,0.45)", background: "rgba(146,161,180,0.08)", color: "#B9C7D6" };

// The def-group frame reuses the def teal (#3FB8AF) but SUBTLER — a faint tinted border/fill that
// reads as a structural group, not a call block. It fills its exact laid-out box (border-box); the
// title bar height matches the layout's TITLE_H, and the body is left transparent for the child def
// nodes to render over. A 32px title matches deriveLogicLayout's TITLE_H so children clear it.
const DEFGROUP_FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(63,184,175,0.4)",
  borderRadius: 10,
  background: "rgba(63,184,175,0.05)",
  fontFamily: MONO,
};
const DEFGROUP_TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  boxSizing: "border-box",
  padding: "0 12px",
  borderBottom: "1px solid rgba(63,184,175,0.25)",
  color: "#7FD6CF",
  fontSize: 12,
  fontWeight: 700,
};
const DEFGROUP_COLLAPSED_TITLE: React.CSSProperties = { ...DEFGROUP_TITLE, borderBottom: "none" };
// The owner name takes the row and truncates; the kind tag and count stay pinned at the right.
const DEFGROUP_NAME: React.CSSProperties = { ...NAME, flex: 1, minWidth: 0 };
const DEFGROUP_COUNT: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
