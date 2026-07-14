/**
 * The Timeline projection: pseudo-execution-time on x, lanes on y. It is a THIN renderer — all order
 * comes from `buildTimeline`; this file only maps the spec's [t0,t1]/lane coordinates to absolutely
 * positioned divs on a sized surface, draws the dashed return line + await/detach connectors, and
 * wires selection/drill. The point a reader takes away: background bars visibly cross the red return
 * line, so fire-and-forget work is seen to outlive the caller.
 */

import { useMemo } from "react";
import type { ChangeStatus } from "@meridian/core";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { buildTimeline } from "../../derive/timelineModel";
import type { AltItem, Connector, TimelineItem } from "../../derive/timelineModel";
import { TargetChangedTag } from "../nodes/logic/logicNodeTypes";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

interface TimelineGeometry {
  px: number;
  left: number;
  y: { alt: number; main: number; task: number; catch: number };
  bgBase: number;
  bgStep: number;
}

const FULL_GEOMETRY: TimelineGeometry = {
  px: 130,
  left: 150,
  y: { alt: 110, main: 210, task: 310, catch: 368 },
  bgBase: 420,
  bgStep: 70,
};

// The PR review drawer is only 30% of the canvas. Put its main thread above the fold while keeping
// catch/background lanes available by scrolling; the standalone Logic view retains the roomier
// geometry above.
const COMPACT_GEOMETRY: TimelineGeometry = {
  px: 108,
  left: 112,
  // alt >= 48 keeps ReturnLine's label above the line without crossing the scroll clip.
  y: { alt: 52, main: 88, task: 140, catch: 192 },
  bgBase: 244,
  bgStep: 52,
};

export function TimelineView(props: FlowViewProps & { density?: "full" | "compact"; drillEnabled?: boolean }) {
  const geometry = props.density === "compact" ? COMPACT_GEOMETRY : FULL_GEOMETRY;
  const drillEnabled = props.drillEnabled !== false;
  const spec = useMemo(() => buildTimeline(props.steps, props.flows, props.index), [props.steps, props.flows, props.index]);
  const tx = (t: number) => geometry.left + t * geometry.px;
  const bgY = (i: number) => geometry.bgBase + i * geometry.bgStep;
  const axisY = Math.max(bgY(spec.bgRows.length), geometry.y.catch + 60) + 20;
  const width = tx(spec.ticks) + 60;
  // Timeline intentionally summarizes loop/callback/terminated-path internals into bars. The
  // review navigator can still focus one of those exact targets in the upper graph; because there
  // is no individual Timeline item to select, do not dim every visible item around an absent match.
  const visibleTargets = [spec.mainRow, spec.taskRow, spec.catchRow, ...spec.bgRows]
    .flatMap((row) => row.map((item) => item.target).filter((target): target is string => typeof target === "string"));
  const dimmed = props.selected != null && visibleTargets.includes(props.selected);

  const onPick = (item: TimelineItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.target) props.onSelect(item.target);
  };
  const onDrill = (item: TimelineItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (drillEnabled && item.expandable && item.target) props.onDrill(item.target);
  };
  const onKeyboardDrill = (item: TimelineItem) => {
    if (drillEnabled && item.expandable && item.target) props.onDrill(item.target);
  };
  const node = (item: TimelineItem, y: number, key: string) => (
    <Node
      key={key}
      item={item}
      y={y}
      tx={tx}
      targetChangedStatus={item.target ? props.index.changedStatus.get(item.target) : undefined}
      selected={props.selected}
      dimmed={dimmed}
      drillEnabled={drillEnabled}
      onPick={onPick}
      onDrill={onDrill}
      onKeyboardDrill={onKeyboardDrill}
    />
  );

  return (
    <div style={{ position: "relative", width, height: axisY + 70, minWidth: "100%" }}>
      {LANES(spec.bgRows.length, bgY, geometry.y)}
      {spec.returnsAt != null ? <ReturnLine x={tx(spec.returnsAt)} bottom={axisY} y={geometry.y} /> : null}
      {spec.ghostRegions.map((r, i) => (
        <div key={`g${i}`} style={ghostFrame(tx(r.t0), tx(r.t1), geometry.y.main)}>
          <span style={GHOST_TAG}>{r.label}</span>
        </div>
      ))}
      {spec.altRows.map((a, i) => <Alt key={`a${i}`} item={a} tx={tx} y={geometry.y.alt} />)}
      {spec.connectors.map((c, i) => <Wire key={`w${i}`} c={c} tx={tx} bgY={bgY} y={geometry.y} />)}
      {spec.elseTicks.map((t, i) => (
        <div key={`e${i}`} style={{ position: "absolute", left: tx(t), top: geometry.y.main - 34, color: FLOW_COLORS.branch }}>
          <div style={{ borderLeft: `1px solid ${FLOW_COLORS.branch}`, height: 18 }} />
          <span style={{ fontSize: 8, letterSpacing: "0.08em", whiteSpace: "nowrap", opacity: 0.85 }}>else · synthesized</span>
        </div>
      ))}
      {spec.mainRow.map((it, i) => node(it, geometry.y.main, `m${i}`))}
      {spec.taskRow.map((it, i) => node(it, geometry.y.task, `t${i}`))}
      {spec.catchRow.map((it, i) => node(it, geometry.y.catch, `c${i}`))}
      {spec.bgRows.map((row, r) => row.map((it, i) => node(it, bgY(r), `b${r}-${i}`)))}
      <Axis ticks={spec.ticks} y={axisY} tx={tx} left={geometry.left} />
      <Legend y={axisY + 34} left={geometry.left} />
    </div>
  );
}

/** One item = one absolutely positioned element; target-bearing items are native buttons so the
 * same linked-graph selection available by mouse is reachable by keyboard and assistive tech. */
function Node(props: {
  item: TimelineItem; y: number; tx: (t: number) => number; selected: string | null;
  targetChangedStatus?: ChangeStatus;
  dimmed: boolean; drillEnabled: boolean;
  onPick: (i: TimelineItem, e: React.MouseEvent) => void;
  onDrill: (i: TimelineItem, e: React.MouseEvent) => void;
  onKeyboardDrill: (i: TimelineItem) => void;
}) {
  const { item, y, tx } = props;
  const on = props.selected != null && item.target === props.selected;
  const opacity = props.dimmed && !on ? (props.targetChangedStatus ? 0.82 : 0.55) : 1;
  const clickable = !!item.target;

  if (item.kind === "suspend") {
    return (
      <div style={{ ...barBox(tx(item.t0), tx(item.t1), y), justifyContent: "center", border: `1px dashed ${item.color}80`, background: hatch(item.color), color: item.color, fontSize: 9, letterSpacing: "0.1em", opacity }}>
        {item.glyph} {item.text}
      </div>
    );
  }
  const common = {
    opacity, cursor: clickable ? "pointer" : "default",
    boxShadow: on ? `0 0 0 1.5px ${FLOW_COLORS.select}` : undefined,
    borderStyle: item.ghost ? "dashed" : "solid",
  } as React.CSSProperties;
  const handlers = { onClick: (e: React.MouseEvent) => props.onPick(item, e), onDoubleClick: (e: React.MouseEvent) => props.onDrill(item, e) };
  const keyboardDrill = props.drillEnabled && item.expandable
    ? () => props.onKeyboardDrill(item)
    : undefined;

  if (item.kind === "bar") {
    return (
      <ItemElement
        clickable={clickable}
        selected={on}
        handlers={handlers}
        onKeyboardDrill={keyboardDrill}
        style={{ ...barBox(tx(item.t0), tx(item.t1), y), border: `1px solid ${item.color}`, background: item.ghost ? "transparent" : `${item.color}20`, color: item.ghost ? FLOW_COLORS.dim : FLOW_COLORS.ink, ...common }}
      >
        <span style={{ color: item.color }}>{item.glyph}</span>
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
        {props.targetChangedStatus ? <TimelineTargetChanged status={props.targetChangedStatus} /> : null}
      </ItemElement>
    );
  }
  return (
    <ItemElement
      clickable={clickable}
      selected={on}
      handlers={handlers}
      onKeyboardDrill={keyboardDrill}
      style={{ position: "absolute", left: tx(item.t0), top: y, transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 6, border: `1px solid ${item.color}`, borderRadius: 4, background: FLOW_COLORS.card, color: FLOW_COLORS.ink, fontFamily: MONO, fontSize: 10, padding: "3px 8px", whiteSpace: "nowrap", zIndex: 2, ...common }}
    >
      <span style={{ color: item.color }}>{item.glyph}</span>
      <span>{item.text}</span>
      {props.targetChangedStatus ? <TimelineTargetChanged status={props.targetChangedStatus} /> : null}
    </ItemElement>
  );
}

/** Status is pinned below the 30px event card instead of extending its measured width. Compact
 * timeline ticks are intentionally close together; an in-row label would overlap the next event. */
function TimelineTargetChanged({ status }: { status: ChangeStatus }) {
  return <span style={TIMELINE_TARGET_CHANGED}><TargetChangedTag status={status} /></span>;
}

function ItemElement(props: {
  clickable: boolean;
  selected: boolean;
  handlers: {
    onClick: (event: React.MouseEvent) => void;
    onDoubleClick: (event: React.MouseEvent) => void;
  };
  onKeyboardDrill?: () => void;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  if (!props.clickable) {
    return <div style={props.style}>{props.children}</div>;
  }
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-keyshortcuts={props.onKeyboardDrill ? "Shift+Enter" : undefined}
      title={props.onKeyboardDrill ? "Shift+Enter to open this call's logic flow" : undefined}
      {...props.handlers}
      onKeyDown={(event) => {
        if (props.onKeyboardDrill && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          props.onKeyboardDrill();
        }
      }}
      style={{ ...props.style, appearance: "none", margin: 0, textAlign: "left" }}
    >
      {props.children}
    </button>
  );
}

function Alt({ item, tx, y }: { item: AltItem; tx: (t: number) => number; y: number }) {
  return (
    <div style={{ ...barBox(tx(item.t0), tx(item.t1), y), border: `1px dashed ${item.color}`, background: "transparent", color: FLOW_COLORS.dim, opacity: 0.85 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
    </div>
  );
}

function Wire(props: {
  c: Connector;
  tx: (t: number) => number;
  bgY: (i: number) => number;
  y: TimelineGeometry["y"];
}) {
  const { c, tx, bgY, y } = props;
  if (c.kind === "await") {
    const top = y.main + 15;
    return <div style={{ position: "absolute", left: tx(c.t), top, height: y.task - 15 - top, borderLeft: `1px dashed ${FLOW_COLORS.awaited}` }} />;
  }
  const top = y.main + 12;
  return <div style={{ position: "absolute", left: tx(c.t) + 8, top, height: bgY(c.row ?? 0) - 15 - top, borderLeft: `1px dashed ${FLOW_COLORS.detached}` }} />;
}

function ReturnLine({ x, bottom, y }: { x: number; bottom: number; y: TimelineGeometry["y"] }) {
  return (
    <div style={{ position: "absolute", left: x, top: y.alt - 34, height: bottom - (y.alt - 34), borderLeft: `2px dashed ${FLOW_COLORS.exitCap}` }}>
      <span style={{ position: "absolute", top: -14, left: -6, transform: "translateX(-50%)", fontSize: 9, color: FLOW_COLORS.exitCap, whiteSpace: "nowrap", letterSpacing: "0.08em" }}>function returns</span>
    </div>
  );
}

function Axis({ ticks, y, tx, left }: { ticks: number; y: number; tx: (t: number) => number; left: number }) {
  const marks = Array.from({ length: Math.floor(ticks) + 1 }, (_, t) => t);
  return (
    <>
      <div style={{ position: "absolute", left: left - 40, top: y, width: tx(ticks) - left + 40, borderTop: `1px solid ${FLOW_COLORS.faint}` }} />
      {marks.map((t) => (
        <div key={t} style={{ position: "absolute", left: tx(t), top: y - 3 }}>
          <div style={{ width: 1, height: 6, background: FLOW_COLORS.faint }} />
          <span style={{ position: "absolute", top: 8, transform: "translateX(-50%)", fontSize: 9, color: FLOW_COLORS.dim, letterSpacing: "0.1em" }}>t{t}</span>
        </div>
      ))}
    </>
  );
}

function Legend({ y, left }: { y: number; left: number }) {
  const items: Array<[string, string]> = [
    [FLOW_COLORS.ink, "main thread"],
    [FLOW_COLORS.awaited, "⏸ suspended while ⏱ awaited task runs"],
    [FLOW_COLORS.dim, "ghost = conditional path"],
    [FLOW_COLORS.detached, "dashed violet = keeps running after return"],
  ];
  return (
    <div style={{ position: "absolute", left: left - 40, top: y, display: "flex", gap: 18, fontFamily: MONO, fontSize: 9.5, color: FLOW_COLORS.dim }}>
      {items.map(([c, t]) => (
        <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 12, height: 3, background: c, borderRadius: 2 }} /> {t}
        </span>
      ))}
    </div>
  );
}

function LANES(bgCount: number, bgY: (i: number) => number, y: TimelineGeometry["y"]) {
  const rows: Array<[number, string, boolean]> = [
    [y.alt, "ALT PATH", false], [y.main, "MAIN", true], [y.task, "AWAITED TASK", false], [y.catch, "ON THROW", false],
  ];
  for (let i = 0; i < bgCount; i++) rows.push([bgY(i), "BACKGROUND", false]);
  return rows.map(([y, label, bold]) => (
    <div key={`${label}${y}`} style={{ position: "absolute", left: 16, top: y - 6, fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: bold ? FLOW_COLORS.ink : FLOW_COLORS.dim, fontWeight: bold ? 700 : 400 }}>
      {label}
    </div>
  ));
}

function barBox(left: number, right: number, y: number): React.CSSProperties {
  return { position: "absolute", left, top: y - 15, width: Math.max(right - left, 12), height: 30, borderRadius: 5, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", fontSize: 10.5, whiteSpace: "nowrap", fontFamily: MONO };
}

/** The cyan diagonal hatch that reads as "suspended, someone else has the thread". */
function hatch(color: string): string {
  return `repeating-linear-gradient(-45deg, transparent 0 5px, ${color}20 5px 9px)`;
}

function ghostFrame(left: number, right: number, mainY: number): React.CSSProperties {
  return { position: "absolute", left: left - 6, top: mainY - 26, width: right - left + 12, height: 52, border: `1px dashed ${FLOW_COLORS.faint}`, borderRadius: 8, background: `${FLOW_COLORS.branch}0A` };
}

const GHOST_TAG: React.CSSProperties = { position: "absolute", top: -8, left: 8, fontSize: 8, letterSpacing: "0.12em", color: FLOW_COLORS.branch, background: FLOW_COLORS.canvas, padding: "0 5px", textTransform: "uppercase" };
const TIMELINE_TARGET_CHANGED: React.CSSProperties = {
  position: "absolute",
  right: 0,
  bottom: -20,
  height: 16,
  pointerEvents: "none",
  zIndex: 3,
};
