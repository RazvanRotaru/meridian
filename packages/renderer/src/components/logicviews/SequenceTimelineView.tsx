/**
 * Static sequence projection: actor headers + lifelines, primary calls, meaningful returns, and
 * quiet structural dividers. The semantic model stays complete for the transcript; the visual
 * presentation removes repeated detail so the first read remains a simple actor conversation.
 */

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { MinusIcon, PlusIcon, ResetIcon } from "@radix-ui/react-icons";
import type { ChangeStatus, NodeId } from "@meridian/core";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import {
  buildSequenceTimeline,
  type SequenceFrame,
  type SequenceMessage,
  type SequenceNote,
  type SequenceParticipant,
  type SequenceTimelineModel,
} from "../../derive/sequenceTimelineModel";
import { buildSequencePresentation } from "../../derive/sequenceTimelinePresentation";
import { TargetChangedTag } from "../nodes/logic/logicNodeTypes";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const STRUCTURE_MARKER_OFFSET = 44;
const MESSAGE_LABEL_OFFSET = 28;
const SELF_MESSAGE_LABEL_OFFSET = 32;
const MESSAGE_LABEL_PADDING_Y = 2;
const TARGET_CHANGE_WIRE_GAP = 6;
const TARGET_CHANGE_TAG_HEIGHT = 16;
// A lowered status pill must clear both its wire and the earliest possible divider for the next
// row. Six quiet pixels on either side keeps those three layers visually distinct.
const SEQUENCE_ROW_GAP = STRUCTURE_MARKER_OFFSET + TARGET_CHANGE_WIRE_GAP + TARGET_CHANGE_TAG_HEIGHT + 6;

interface SequenceGeometry {
  minWidth: number;
  sidePadding: number;
  participantGap: number;
  actorTop: number;
  actorWidth: number;
  actorHeight: number;
  firstRowY: number;
  rowGap: number;
  noteWidth: number;
  bottomPadding: number;
}

const FULL_GEOMETRY: SequenceGeometry = {
  minWidth: 720,
  sidePadding: 118,
  participantGap: 226,
  // The full Logic lens has a two-row floating view/synthetic toolbar above the canvas.
  actorTop: 52,
  actorWidth: 172,
  actorHeight: 48,
  firstRowY: 160,
  rowGap: SEQUENCE_ROW_GAP,
  noteWidth: 220,
  bottomPadding: 52,
};

const COMPACT_GEOMETRY: SequenceGeometry = {
  minWidth: 520,
  sidePadding: 86,
  // Keep enough room between compact actors for a typical transport event plus its PR-status
  // line (for example, `deliver · type:delegate-ready`) without covering either arrowhead.
  participantGap: 212,
  actorTop: 18,
  actorWidth: 146,
  actorHeight: 44,
  firstRowY: 126,
  rowGap: SEQUENCE_ROW_GAP,
  noteWidth: 180,
  bottomPadding: 44,
};

export interface SequenceTimelineViewProps extends FlowViewProps {
  density?: "full" | "compact";
  drillEnabled?: boolean;
  /** Full views show controls by default; compact review embeds can opt in explicitly. */
  showZoomControls?: boolean;
  /**
   * Cross-callback/RPC analyses can supply an exact causal sequence that cannot be represented as
   * one intraprocedural `FlowStep[]` tree. Ordinary logic flows keep using the derived model.
   */
  modelOverride?: SequenceTimelineModel | null;
}

export function SequenceTimelineView(props: SequenceTimelineViewProps) {
  const density = props.density ?? "full";
  const geometry = density === "compact" ? COMPACT_GEOMETRY : FULL_GEOMETRY;
  const drillEnabled = props.drillEnabled !== false;
  const showZoomControls = props.showZoomControls ?? density === "full";
  const semanticModel = useMemo(
    () => props.modelOverride ?? buildSequenceTimeline(props.rootId, props.steps, props.flows, props.index),
    [props.modelOverride, props.rootId, props.steps, props.flows, props.index],
  );
  const model = useMemo(() => buildSequencePresentation(semanticModel), [semanticModel]);
  const layout = useMemo(() => layoutSequence(model, geometry), [model, geometry]);
  const [zoom, setZoom] = useState(1);
  const visibleSelection = props.selected !== null && selectionIsVisible(semanticModel, props.selected);
  const highlightedParticipants = useMemo(
    () => selectedParticipantIds(semanticModel, visibleSelection ? props.selected : null),
    [semanticModel, props.selected, visibleSelection],
  );

  return (
    <section
      aria-label="Static sequence diagram"
      data-sequence-density={density}
      style={ROOT}
    >
      <SequenceTranscript model={semanticModel} />
      {showZoomControls ? <ZoomControls zoom={zoom} setZoom={setZoom} /> : null}
      <div
        style={SCROLLER}
        onClick={() => props.onSelect(null)}
      >
        <div style={{ position: "relative", width: layout.width * zoom, height: layout.height * zoom }}>
          <div
            style={{
              position: "relative",
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              background: FLOW_COLORS.canvas,
              overflow: "hidden",
            }}
          >
            <SequenceSvg
              model={model}
              layout={layout}
              selection={visibleSelection ? props.selected : null}
              highlightedParticipants={highlightedParticipants}
            />
            {model.participants.map((participant) => (
              <ParticipantHeader
                key={participant.id}
                participant={participant}
                x={layout.xByParticipant.get(participant.id) ?? 0}
                geometry={geometry}
                selected={visibleSelection ? props.selected : null}
                highlighted={highlightedParticipants.has(participant.id)}
                canDrill={drillEnabled
                  && participant.nodeId !== null
                  && participant.nodeId !== props.rootId
                  && (props.flows[participant.nodeId]?.length ?? 0) > 0}
                onSelect={props.onSelect}
                onDrill={props.onDrill}
              />
            ))}
            {model.rows.map((row) => row.type === "message"
              ? (
                <MessageLabel
                  key={row.id}
                  message={row}
                  y={layout.yForRow(row.row)}
                  fromX={layout.xByParticipant.get(row.from) ?? 0}
                  toX={layout.xByParticipant.get(row.to) ?? 0}
                  surfaceWidth={layout.width}
                  selected={visibleSelection ? props.selected : null}
                  targetStatus={row.target ? props.index.changedStatus.get(row.target) : undefined}
                  drillEnabled={drillEnabled}
                  onSelect={props.onSelect}
                  onDrill={props.onDrill}
                />
              )
              : (
                <NoteLabel
                  key={row.id}
                  note={row}
                  y={layout.yForRow(row.row)}
                  x={layout.xByParticipant.get(row.participant) ?? 0}
                  width={geometry.noteWidth}
                />
              ))}
            {model.rows.length === 0 ? (
              <div style={{ ...EMPTY, left: layout.width / 2, top: geometry.firstRowY }}>
                No chartable flow steps
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

interface SequenceLayout {
  width: number;
  height: number;
  xByParticipant: Map<string, number>;
  yForRow: (row: number) => number;
}

function layoutSequence(model: SequenceTimelineModel, geometry: SequenceGeometry): SequenceLayout {
  const span = Math.max(0, model.participants.length - 1) * geometry.participantGap;
  const width = Math.max(geometry.minWidth, span + geometry.sidePadding * 2);
  const firstX = (width - span) / 2;
  const xByParticipant = new Map(model.participants.map((participant, index) => [
    participant.id,
    firstX + index * geometry.participantGap,
  ]));
  const lastRow = Math.max(0, model.rows.length - 1);
  const yForRow = (row: number) => geometry.firstRowY + row * geometry.rowGap;
  const height = yForRow(lastRow) + geometry.bottomPadding;
  return {
    width,
    height,
    xByParticipant,
    yForRow,
  };
}

function frameStartOrder(frames: SequenceFrame[]): Map<number, SequenceFrame[]> {
  const sourceOrder = new Map(frames.map((frame, index) => [frame.id, index]));
  const grouped = new Map<number, SequenceFrame[]>();
  for (const frame of frames) {
    const group = grouped.get(frame.startRow) ?? [];
    group.push(frame);
    grouped.set(frame.startRow, group);
  }
  for (const group of grouped.values()) {
    // Wider frames are outside narrower frames. When their spans match, builders finish inner
    // frames first, so the later source entry is the outer boundary.
    group.sort((left, right) => right.endRow - left.endRow
      || (sourceOrder.get(right.id) ?? 0) - (sourceOrder.get(left.id) ?? 0));
  }
  return grouped;
}

interface SequenceStructureMarker {
  row: number;
  frames: SequenceFrame[];
  alternatives: Array<{ frame: SequenceFrame; label: string }>;
}

/** One quiet divider per event row. Nested starts and alternative boundaries are combined into a
 * single breadcrumb instead of drawing overlapping enclosure boxes. */
function sequenceStructureMarkers(model: SequenceTimelineModel): SequenceStructureMarker[] {
  const grouped = new Map<number, SequenceStructureMarker>();
  const markerAt = (row: number) => {
    const existing = grouped.get(row);
    if (existing) return existing;
    const marker: SequenceStructureMarker = { row, frames: [], alternatives: [] };
    grouped.set(row, marker);
    return marker;
  };
  for (const [row, frames] of frameStartOrder(model.frames)) {
    markerAt(row).frames.push(...frames);
  }
  for (const frame of model.frames) {
    for (const separator of frame.separators) {
      markerAt(separator.row).alternatives.push({ frame, label: separator.label });
    }
  }
  return [...grouped.values()].sort((left, right) => left.row - right.row);
}

function structureMarkerLabel(marker: SequenceStructureMarker): string {
  const paths = marker.alternatives.map((alternative) => alternativeMarkerLabel(alternative.label));
  const frames = marker.frames.map(frameMarkerLabel);
  const compactFrames = frames.map((label, index) => {
    if (index === 0) return label;
    const previousKind = frames[index - 1]?.split(" · ")[0];
    return previousKind && label.startsWith(`${previousKind} · `)
      ? label.slice(previousKind.length + 3)
      : label;
  });
  return [...paths, ...compactFrames].join("  ›  ");
}

function alternativeMarkerLabel(label: string): string {
  if (label === "else") return "ELSE";
  if (label === "else (implicit)") return "ELSE · implicit";
  if (label === "default") return "DEFAULT";
  if (/^".*"$/.test(label)) return `CASE ${label}`;
  return `PATH · ${label}`;
}

function frameMarkerLabel(frame: SequenceFrame): string {
  const kind = frame.kind === "alt" ? "ALT" : frame.kind.toUpperCase();
  const parts = frame.label.split(" · ");
  if (frame.kind === "alt" && parts.length > 1) {
    const path = parts.at(-1)!;
    const subject = parts.slice(0, -1).join(" · ");
    return path === "then" ? `${kind} · ${subject}` : `${kind} · ${subject} — ${path}`;
  }
  if (frame.kind === "callback" && parts.at(-1) === "deferred / timing unknown") {
    return `${kind} · ${parts.slice(0, -1).join(" · ")} — timing unknown`;
  }
  return `${kind} · ${frame.label}`;
}

interface SequenceTranscriptEntry {
  id: string;
  text: string;
}

function SequenceTranscript({ model }: { model: SequenceTimelineModel }) {
  const entries = sequenceTranscriptEntries(model);
  return (
    <div
      role="region"
      aria-label="Sequence diagram transcript"
      data-sequence-transcript="true"
      style={SR_ONLY}
    >
      <h2>Sequence diagram transcript</h2>
      <p>Participants from left to right:</p>
      <ol aria-label="Sequence participants">
        {model.participants.map((participant, index) => (
          <li key={participant.id}>
            {`Participant ${index + 1} of ${model.participants.length}: ${participant.label}.`}
          </li>
        ))}
      </ol>
      <p>Messages and frame boundaries in top-to-bottom diagram order:</p>
      <ol aria-label="Sequence events">
        {entries.map((entry) => <li key={entry.id}>{entry.text}</li>)}
      </ol>
    </div>
  );
}

function sequenceTranscriptEntries(model: SequenceTimelineModel): SequenceTranscriptEntry[] {
  const participantLabels = new Map(model.participants.map((participant) => [participant.id, participant.label]));
  const framesByStart = frameStartOrder(model.frames);
  const sourceOrder = new Map(model.frames.map((frame, index) => [frame.id, index]));
  const framesByEnd = new Map<number, SequenceFrame[]>();
  const separatorsByRow = new Map<number, Array<{ frame: SequenceFrame; label: string; index: number }>>();
  for (const frame of model.frames) {
    const ending = framesByEnd.get(frame.endRow) ?? [];
    ending.push(frame);
    framesByEnd.set(frame.endRow, ending);
    frame.separators.forEach((separator, index) => {
      const separators = separatorsByRow.get(separator.row) ?? [];
      separators.push({ frame, label: separator.label, index });
      separatorsByRow.set(separator.row, separators);
    });
  }
  for (const ending of framesByEnd.values()) {
    // Close the most deeply nested boundary first.
    ending.sort((left, right) => right.startRow - left.startRow
      || (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0));
  }

  const entries: SequenceTranscriptEntry[] = [];
  for (const row of model.rows) {
    for (const frame of framesByStart.get(row.row) ?? []) {
      entries.push({
        id: `${frame.id}:start`,
        text: `Begin ${frameKindLabel(frame.kind)} frame: ${sentence(frame.label)}`,
      });
    }
    for (const separator of separatorsByRow.get(row.row) ?? []) {
      entries.push({
        id: `${separator.frame.id}:separator:${separator.index}`,
        text: `Alternative path: ${sentence(separator.label)}`,
      });
    }
    if (row.type === "message") {
      const from = participantLabels.get(row.from) ?? "Unknown participant";
      const to = participantLabels.get(row.to) ?? "Unknown participant";
      entries.push({
        id: row.id,
        text: `${row.kind === "return" ? "Return" : "Call"} from ${from} to ${to}: ${sentence(row.label)}`,
      });
    } else {
      const participant = participantLabels.get(row.participant) ?? "Unknown participant";
      entries.push({
        id: row.id,
        text: `${noteToneLabel(row.tone)} at ${participant}: ${sentence(row.label)}`,
      });
    }
    for (const frame of framesByEnd.get(row.row) ?? []) {
      entries.push({
        id: `${frame.id}:end`,
        text: `End ${frameKindLabel(frame.kind)} frame: ${sentence(frame.label)}`,
      });
    }
  }
  return entries;
}

function frameKindLabel(kind: SequenceFrame["kind"]): string {
  return kind === "alt" ? "alternative" : kind;
}

function noteToneLabel(tone: SequenceNote["tone"]): string {
  if (tone === "wait") return "Wait";
  if (tone === "exit") return "Exit";
  if (tone === "handoff") return "Asynchronous handoff";
  return "Guard";
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function SequenceSvg(props: {
  model: SequenceTimelineModel;
  layout: SequenceLayout;
  selection: NodeId | null;
  highlightedParticipants: ReadonlySet<string>;
}) {
  const { model, layout } = props;
  // The actual geometry is recoverable from row coordinates; actor bottom only needs to remain
  // above the first event, irrespective of density.
  const lifelineTop = Math.max(72, layout.yForRow(0) - 46);
  const lifelineBottom = layout.height - 24;
  return (
    <svg
      width={layout.width}
      height={layout.height}
      aria-hidden="true"
      focusable="false"
      data-sequence-svg="true"
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
    >
      {sequenceStructureMarkers(model).map((marker) => (
        <StructureMarkerLine key={`structure:${marker.row}`} marker={marker} layout={layout} />
      ))}
      {model.participants.map((participant) => {
        const selected = props.highlightedParticipants.has(participant.id);
        const dimmed = props.selection !== null && !selected;
        return (
          <line
            key={participant.id}
            data-sequence-lifeline={participant.id}
            x1={layout.xByParticipant.get(participant.id)}
            x2={layout.xByParticipant.get(participant.id)}
            y1={lifelineTop}
            y2={lifelineBottom}
            stroke={selected ? FLOW_COLORS.select : FLOW_COLORS.faint}
            strokeWidth={selected ? 2 : 1.2}
            strokeDasharray="6 7"
            opacity={dimmed ? 0.48 : 0.92}
          />
        );
      })}
      {model.rows.map((row) => row.type === "message"
        ? <MessageWire key={row.id} message={row} layout={layout} selected={props.selection} />
        : null)}
    </svg>
  );
}

function MessageWire({ message, layout, selected }: {
  message: SequenceMessage;
  layout: SequenceLayout;
  selected: NodeId | null;
}) {
  const x1 = layout.xByParticipant.get(message.from) ?? 0;
  const x2 = layout.xByParticipant.get(message.to) ?? 0;
  const y = layout.yForRow(message.row);
  const color = messageColor(message);
  const opacity = selected === null
    ? 0.96
    : message.target === selected
      ? 1
      : message.kind === "return"
        ? 0.58
        : 0.38;
  const dashed = message.kind === "return";

  if (x1 === x2) {
    const selfDirection = selfLoopDirection(x1, layout.width);
    const reach = 38;
    const endX = x1 + selfDirection * 2;
    return (
      <g data-sequence-message-kind={message.kind} opacity={opacity}>
        <path
          d={`M ${x1} ${y - 10} H ${x1 + selfDirection * reach} V ${y + 10} H ${endX}`}
          fill="none"
          stroke={color}
          strokeWidth={message.kind === "call" ? 1.8 : 1.4}
          strokeDasharray={dashed ? "7 6" : undefined}
        />
        <ArrowHead x={endX} y={y + 10} direction={selfDirection === 1 ? -1 : 1} color={color} open={dashed} />
      </g>
    );
  }

  const direction = x2 > x1 ? 1 : -1;
  return (
    <g data-sequence-message-kind={message.kind} opacity={opacity}>
      <line
        x1={x1}
        y1={y}
        x2={x2}
        y2={y}
        stroke={color}
        strokeWidth={message.kind === "call" ? 1.8 : 1.4}
        strokeDasharray={dashed ? "7 6" : undefined}
      />
      <ArrowHead x={x2} y={y} direction={direction} color={color} open={dashed} />
    </g>
  );
}

function ArrowHead(props: { x: number; y: number; direction: 1 | -1; color: string; open: boolean }) {
  const back = props.x - props.direction * 9;
  if (props.open) {
    return (
      <path
        d={`M ${back} ${props.y - 4.5} L ${props.x} ${props.y} L ${back} ${props.y + 4.5}`}
        fill="none"
        stroke={props.color}
        strokeWidth={1.5}
      />
    );
  }
  return <path d={`M ${props.x} ${props.y} L ${back} ${props.y - 4.5} L ${back} ${props.y + 4.5} Z`} fill={props.color} />;
}

function StructureMarkerLine({ marker, layout }: {
  marker: SequenceStructureMarker;
  layout: SequenceLayout;
}) {
  const label = structureMarkerLabel(marker);
  const frameKinds = [...new Set(marker.frames.map((frame) => frame.kind))];
  const color = marker.alternatives.length > 0 || frameKinds.includes("alt")
    ? FLOW_COLORS.branch
    : frameKinds.includes("callback")
      ? FLOW_COLORS.callback
      : FLOW_COLORS.loop;
  const y = layout.yForRow(marker.row) - STRUCTURE_MARKER_OFFSET;
  const left = 24;
  const right = layout.width - 24;
  const tagWidth = Math.min(right - left - 8, Math.max(88, label.length * 6.1 + 20));
  const tagCharacters = Math.max(10, Math.floor((tagWidth - 20) / 6.1));
  return (
    <g
      data-sequence-structure-row={marker.row}
      data-sequence-frame-kinds={frameKinds.join(" ") || undefined}
      data-sequence-alternative={marker.alternatives.length > 0 ? "true" : undefined}
      data-sequence-structure-y={y}
    >
      <title>{label}</title>
      <line
        x1={left}
        y1={y}
        x2={right}
        y2={y}
        stroke={`${color}70`}
        strokeWidth={1}
        strokeDasharray={marker.alternatives.length > 0 ? "5 6" : undefined}
      />
      <rect x={left + 8} y={y - 9} width={tagWidth} height={18} rx={3} fill={FLOW_COLORS.canvas} />
      <text x={left + 16} y={y + 4} fill={color} fontFamily={MONO} fontSize={9.5} fontWeight={700}>
        {shorten(label, tagCharacters)}
      </text>
    </g>
  );
}

function ParticipantHeader(props: {
  participant: SequenceParticipant;
  x: number;
  geometry: SequenceGeometry;
  selected: NodeId | null;
  highlighted: boolean;
  canDrill: boolean;
  onSelect: FlowViewProps["onSelect"];
  onDrill: FlowViewProps["onDrill"];
}) {
  const { participant, geometry } = props;
  const selected = participant.nodeId !== null && participant.nodeId === props.selected;
  const dimmed = props.selected !== null && !props.highlighted;
  const common: CSSProperties = {
    position: "absolute",
    zIndex: 3,
    left: props.x - geometry.actorWidth / 2,
    top: geometry.actorTop,
    width: geometry.actorWidth,
    height: geometry.actorHeight,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${props.highlighted ? FLOW_COLORS.select : participantBorder(participant)}`,
    borderRadius: 6,
    background: FLOW_COLORS.card,
    boxShadow: props.highlighted ? `0 0 0 1px ${FLOW_COLORS.select}` : "none",
    color: FLOW_COLORS.ink,
    fontFamily: MONO,
    opacity: dimmed ? (participant.changedStatus ? 0.82 : 0.52) : 1,
    overflow: "hidden",
    padding: "6px 10px",
  };
  const participantTitle = participant.detail ? `${participant.label} — ${participant.detail}` : participant.label;
  const content = <span style={ACTOR_LABEL} title={participantTitle}>{participant.label}</span>;
  if (participant.nodeId === null) {
    return <div data-sequence-participant-kind={participant.kind} style={common} title={participantTitle}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-sequence-participant-kind={participant.kind}
      aria-label={`Select ${participant.label}`}
      aria-pressed={selected}
      aria-keyshortcuts={props.canDrill ? "Shift+Enter" : undefined}
      title={props.canDrill ? `Shift+Enter to open this participant's logic flow — ${participantTitle}` : participantTitle}
      style={{ ...common, appearance: "none", margin: 0, cursor: "pointer" }}
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect(participant.nodeId);
      }}
      onDoubleClick={(event) => {
        if (!props.canDrill) return;
        event.stopPropagation();
        props.onDrill(participant.nodeId!);
      }}
      onKeyDown={(event) => {
        if (props.canDrill && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          props.onDrill(participant.nodeId!);
        }
      }}
    >
      {content}
    </button>
  );
}

function MessageLabel(props: {
  message: SequenceMessage;
  y: number;
  fromX: number;
  toX: number;
  surfaceWidth: number;
  selected: NodeId | null;
  targetStatus?: ChangeStatus;
  drillEnabled: boolean;
  onSelect: FlowViewProps["onSelect"];
  onDrill: FlowViewProps["onDrill"];
}) {
  const self = props.fromX === props.toX;
  const width = self ? 174 : Math.max(118, Math.min(244, Math.abs(props.toX - props.fromX) - 22));
  const selfDirection = selfLoopDirection(props.fromX, props.surfaceWidth);
  const center = self
    ? props.fromX + selfDirection * (56 + width / 2)
    : (props.fromX + props.toX) / 2;
  const selected = props.message.target !== null && props.message.target === props.selected;
  const dimmed = props.selected !== null && !selected;
  const targetChangeStatus = props.message.kind === "call" ? props.targetStatus : undefined;
  const labelOffset = self ? SELF_MESSAGE_LABEL_OFFSET : MESSAGE_LABEL_OFFSET;
  // The content box starts after the button's vertical padding. Position the pill in canvas space
  // at wire Y + gap while keeping it inside the same semantic/clickable message control.
  const targetChangeTop = labelOffset + TARGET_CHANGE_WIRE_GAP - MESSAGE_LABEL_PADDING_Y;
  const style: CSSProperties = {
    position: "absolute",
    zIndex: 4,
    left: center,
    top: props.y - labelOffset,
    width,
    minWidth: 0,
    transform: "translateX(-50%)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    boxSizing: "border-box",
    border: "none",
    borderRadius: 4,
    background: `${FLOW_COLORS.canvas}F2`,
    color: props.message.kind === "return" ? FLOW_COLORS.dim : messageColor(props.message),
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: props.message.kind === "call" ? 600 : 500,
    lineHeight: 1.25,
    padding: `${MESSAGE_LABEL_PADDING_Y}px 5px`,
    opacity: dimmed ? (props.targetStatus ? 0.82 : 0.48) : 1,
    overflow: "visible",
    whiteSpace: "nowrap",
  };
  const copy = (
    <span
      data-sequence-message-content="true"
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        minWidth: 0,
        overflow: "visible",
      }}
    >
      <span
        data-sequence-message-text="true"
        style={{ display: "block", width: "100%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}
        title={props.message.label}
      >
        {props.message.label}
      </span>
      {targetChangeStatus ? (
        <span
          data-sequence-target-change-line="true"
          data-sequence-target-change-placement="below-wire"
          data-sequence-target-change-y={props.y + TARGET_CHANGE_WIRE_GAP}
          style={{
            position: "absolute",
            left: 0,
            top: targetChangeTop,
            width: "100%",
            height: TARGET_CHANGE_TAG_HEIGHT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <TargetChangedTag status={targetChangeStatus} />
        </span>
      ) : null}
    </span>
  );
  if (props.message.kind === "return" || props.message.target === null) {
    return (
      <div
        data-sequence-message-label={props.message.kind}
        data-sequence-message-row={props.message.row}
        data-sequence-message-y={props.y}
        style={style}
      >
        {copy}
      </div>
    );
  }
  const canDrill = props.drillEnabled && props.message.drillable;
  return (
    <button
      type="button"
      data-sequence-message-label={props.message.kind}
      data-sequence-message-row={props.message.row}
      data-sequence-message-y={props.y}
      aria-label={`Select call target ${props.message.label}`}
      aria-pressed={selected}
      aria-keyshortcuts={canDrill ? "Shift+Enter" : undefined}
      title={canDrill ? "Shift+Enter to open this call's logic flow" : props.message.label}
      style={{ ...style, appearance: "none", margin: 0, cursor: "pointer", outline: selected ? `1px solid ${FLOW_COLORS.select}` : undefined }}
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect(props.message.target);
      }}
      onDoubleClick={(event) => {
        if (!canDrill) return;
        event.stopPropagation();
        props.onDrill(props.message.target!);
      }}
      onKeyDown={(event) => {
        if (canDrill && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          props.onDrill(props.message.target!);
        }
      }}
    >
      {copy}
    </button>
  );
}

function NoteLabel({ note, x, y, width }: { note: SequenceNote; x: number; y: number; width: number }) {
  const color = note.tone === "wait"
    ? FLOW_COLORS.awaited
    : note.tone === "exit"
      ? FLOW_COLORS.exitCap
      : note.tone === "handoff"
        ? FLOW_COLORS.detached
        : FLOW_COLORS.loop;
  return (
    <div
      data-sequence-note={note.tone}
      style={{
        position: "absolute",
        zIndex: 4,
        left: x,
        top: y,
        width: "max-content",
        maxWidth: width,
        minHeight: 20,
        transform: "translate(-50%, -50%)",
        boxSizing: "border-box",
        border: "none",
        borderLeft: `2px solid ${color}`,
        borderRadius: 2,
        background: `${FLOW_COLORS.canvas}EE`,
        color: FLOW_COLORS.dim,
        fontFamily: MONO,
        fontSize: 9,
        lineHeight: 1.3,
        padding: "3px 6px",
        textAlign: "left",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={note.label}
    >
      <span style={{ color, fontWeight: 700, marginRight: 5 }}>{note.tone.toUpperCase()}</span>
      {note.label}
    </div>
  );
}

function ZoomControls({ zoom, setZoom }: { zoom: number; setZoom: (value: number) => void }) {
  const change = (delta: number) => setZoom(clampZoom(zoom + delta));
  return (
    <div
      aria-label="Sequence diagram zoom"
      data-preserves-sequence-selection="true"
      style={ZOOM_BAR}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label="Zoom out" disabled={zoom <= 0.7} style={ZOOM_BUTTON} onClick={() => change(-0.1)}>
        <MinusIcon />
      </button>
      <button type="button" aria-label="Reset zoom" style={{ ...ZOOM_BUTTON, width: 68, gap: 5 }} onClick={() => setZoom(1)}>
        <ResetIcon /> {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={zoom >= 1.4} style={ZOOM_BUTTON} onClick={() => change(0.1)}>
        <PlusIcon />
      </button>
    </div>
  );
}

function clampZoom(value: number): number {
  return Math.round(Math.max(0.7, Math.min(1.4, value)) * 10) / 10;
}

function selectionIsVisible(model: SequenceTimelineModel, selected: NodeId): boolean {
  return model.participants.some((participant) => participant.nodeId === selected)
    || model.rows.some((row) => row.type === "message" && row.target === selected);
}

function selfLoopDirection(x: number, surfaceWidth: number): 1 | -1 {
  return x + 238 <= surfaceWidth ? 1 : -1;
}

function selectedParticipantIds(model: SequenceTimelineModel, selected: NodeId | null): Set<string> {
  if (selected === null) return new Set();
  const ids = new Set(model.participants
    .filter((participant) => participant.nodeId === selected)
    .map((participant) => participant.id));
  for (const row of model.rows) {
    if (row.type === "message" && row.kind === "call" && row.target === selected) ids.add(row.to);
  }
  return ids;
}

function participantBorder(participant: SequenceParticipant): string {
  if (participant.kind === "resource") return "#A78BFA";
  if (participant.kind === "callback") return FLOW_COLORS.callback;
  if (participant.kind === "overflow") return FLOW_COLORS.loop;
  if (participant.kind === "external" || participant.kind === "unresolved") return FLOW_COLORS.dim;
  return FLOW_COLORS.faint;
}

function messageColor(message: SequenceMessage): string {
  if (message.tone === "await") return FLOW_COLORS.awaited;
  if (message.tone === "detached") return FLOW_COLORS.detached;
  if (message.tone === "callback") return FLOW_COLORS.callback;
  return message.kind === "return" ? FLOW_COLORS.dim : FLOW_COLORS.call;
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

const ROOT: CSSProperties = {
  position: "relative",
  width: "100%",
  minWidth: 0,
  background: FLOW_COLORS.canvas,
  color: FLOW_COLORS.ink,
  fontFamily: MONO,
};

const SCROLLER: CSSProperties = {
  position: "relative",
  width: "100%",
  minWidth: 0,
  overflow: "auto",
  background: FLOW_COLORS.canvas,
};

const ZOOM_BAR: CSSProperties = {
  position: "relative",
  zIndex: 8,
  height: 38,
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: 4,
  padding: "0 10px",
  boxSizing: "border-box",
  borderBottom: `1px solid ${FLOW_COLORS.faint}`,
  background: FLOW_COLORS.card,
};

const ZOOM_BUTTON: CSSProperties = {
  width: 30,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${FLOW_COLORS.faint}`,
  borderRadius: 5,
  background: FLOW_COLORS.canvas,
  color: FLOW_COLORS.ink,
  fontFamily: MONO,
  fontSize: 9,
  cursor: "pointer",
};

const ACTOR_LABEL: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: FLOW_COLORS.ink,
  fontSize: 11,
  fontWeight: 700,
};

const EMPTY: CSSProperties = {
  position: "absolute",
  zIndex: 4,
  transform: "translate(-50%, -50%)",
  border: `1px dashed ${FLOW_COLORS.faint}`,
  borderRadius: 5,
  background: FLOW_COLORS.card,
  color: FLOW_COLORS.dim,
  fontFamily: MONO,
  fontSize: 10,
  padding: "8px 12px",
};

const SR_ONLY: CSSProperties = {
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
