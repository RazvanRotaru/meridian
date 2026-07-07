/**
 * The Timeline projection: pseudo-execution-time on x, lanes on y. It is a THIN renderer — all order
 * comes from `buildTimeline`; this file only maps the spec's [t0,t1]/lane coordinates to absolutely
 * positioned divs on a sized surface, draws the dashed return line + await/detach connectors, and
 * wires selection/drill. The point a reader takes away: background bars visibly cross the red return
 * line, so fire-and-forget work is seen to outlive the caller.
 */

import { useMemo } from "react";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { buildTimeline } from "../../derive/timelineModel";
import type { AltItem, Connector, TimelineItem } from "../../derive/timelineModel";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const PX = 130; // px per tick
const LEFT = 150; // lane-label gutter
const Y = { alt: 110, main: 210, task: 310, catch: 368 };
const BG_BASE = 420;
const BG_STEP = 70;

export function TimelineView(props: FlowViewProps) {
  const spec = useMemo(() => buildTimeline(props.steps, props.flows, props.index), [props.steps, props.flows, props.index]);
  const tx = (t: number) => LEFT + t * PX;
  const bgY = (i: number) => BG_BASE + i * BG_STEP;
  const axisY = Math.max(bgY(spec.bgRows.length), Y.catch + 60) + 20;
  const width = tx(spec.ticks) + 60;
  const dimmed = props.selected != null;

  const onPick = (item: TimelineItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.target) props.onSelect(item.target);
  };
  const onDrill = (item: TimelineItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.expandable && item.target) props.onDrill(item.target);
  };
  const node = (item: TimelineItem, y: number, key: string) => (
    <Node key={key} item={item} y={y} tx={tx} selected={props.selected} dimmed={dimmed} onPick={onPick} onDrill={onDrill} />
  );

  return (
    <div style={{ position: "relative", width, height: axisY + 70, minWidth: "100%" }}>
      {LANES(spec.bgRows.length, bgY)}
      {spec.returnsAt != null ? <ReturnLine x={tx(spec.returnsAt)} bottom={axisY} /> : null}
      {spec.ghostRegions.map((r, i) => (
        <div key={`g${i}`} style={ghostFrame(tx(r.t0), tx(r.t1))}>
          <span style={GHOST_TAG}>{r.label}</span>
        </div>
      ))}
      {spec.altRows.map((a, i) => <Alt key={`a${i}`} item={a} tx={tx} />)}
      {spec.connectors.map((c, i) => <Wire key={`w${i}`} c={c} tx={tx} bgY={bgY} />)}
      {spec.elseTicks.map((t, i) => (
        <div key={`e${i}`} style={{ position: "absolute", left: tx(t), top: Y.main - 34, color: FLOW_COLORS.branch }}>
          <div style={{ borderLeft: `1px solid ${FLOW_COLORS.branch}`, height: 18 }} />
          <span style={{ fontSize: 8, letterSpacing: "0.08em", whiteSpace: "nowrap", opacity: 0.85 }}>else · synthesized</span>
        </div>
      ))}
      {spec.mainRow.map((it, i) => node(it, Y.main, `m${i}`))}
      {spec.taskRow.map((it, i) => node(it, Y.task, `t${i}`))}
      {spec.catchRow.map((it, i) => node(it, Y.catch, `c${i}`))}
      {spec.bgRows.map((row, r) => row.map((it, i) => node(it, bgY(r), `b${r}-${i}`)))}
      <Axis ticks={spec.ticks} y={axisY} tx={tx} />
      <Legend y={axisY + 34} />
    </div>
  );
}

/** One item = one absolutely positioned div; chip/bar/suspend differ only in shape. */
function Node(props: {
  item: TimelineItem; y: number; tx: (t: number) => number; selected: string | null;
  dimmed: boolean; onPick: (i: TimelineItem, e: React.MouseEvent) => void; onDrill: (i: TimelineItem, e: React.MouseEvent) => void;
}) {
  const { item, y, tx } = props;
  const on = props.selected != null && item.target === props.selected;
  const opacity = props.dimmed && !on ? 0.55 : 1;
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

  if (item.kind === "bar") {
    return (
      <div {...handlers} style={{ ...barBox(tx(item.t0), tx(item.t1), y), border: `1px solid ${item.color}`, background: item.ghost ? "transparent" : `${item.color}20`, color: item.ghost ? FLOW_COLORS.dim : FLOW_COLORS.ink, ...common }}>
        <span style={{ color: item.color }}>{item.glyph}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
      </div>
    );
  }
  return (
    <div {...handlers} style={{ position: "absolute", left: tx(item.t0), top: y, transform: "translateY(-50%)", border: `1px solid ${item.color}`, borderRadius: 4, background: FLOW_COLORS.card, color: FLOW_COLORS.ink, fontSize: 10, padding: "3px 8px", whiteSpace: "nowrap", zIndex: 2, ...common }}>
      <span style={{ color: item.color }}>{item.glyph}</span> {item.text}
    </div>
  );
}

function Alt({ item, tx }: { item: AltItem; tx: (t: number) => number }) {
  return (
    <div style={{ ...barBox(tx(item.t0), tx(item.t1), Y.alt), border: `1px dashed ${item.color}`, background: "transparent", color: FLOW_COLORS.dim, opacity: 0.85 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
    </div>
  );
}

function Wire({ c, tx, bgY }: { c: Connector; tx: (t: number) => number; bgY: (i: number) => number }) {
  if (c.kind === "await") {
    const top = Y.main + 15;
    return <div style={{ position: "absolute", left: tx(c.t), top, height: Y.task - 15 - top, borderLeft: `1px dashed ${FLOW_COLORS.awaited}` }} />;
  }
  const top = Y.main + 12;
  return <div style={{ position: "absolute", left: tx(c.t) + 8, top, height: bgY(c.row ?? 0) - 15 - top, borderLeft: `1px dashed ${FLOW_COLORS.detached}` }} />;
}

function ReturnLine({ x, bottom }: { x: number; bottom: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: Y.alt - 34, height: bottom - (Y.alt - 34), borderLeft: `2px dashed ${FLOW_COLORS.exitCap}` }}>
      <span style={{ position: "absolute", top: -14, left: -6, transform: "translateX(-50%)", fontSize: 9, color: FLOW_COLORS.exitCap, whiteSpace: "nowrap", letterSpacing: "0.08em" }}>function returns</span>
    </div>
  );
}

function Axis({ ticks, y, tx }: { ticks: number; y: number; tx: (t: number) => number }) {
  const marks = Array.from({ length: Math.floor(ticks) + 1 }, (_, t) => t);
  return (
    <>
      <div style={{ position: "absolute", left: LEFT - 40, top: y, width: tx(ticks) - LEFT + 40, borderTop: `1px solid ${FLOW_COLORS.faint}` }} />
      {marks.map((t) => (
        <div key={t} style={{ position: "absolute", left: tx(t), top: y - 3 }}>
          <div style={{ width: 1, height: 6, background: FLOW_COLORS.faint }} />
          <span style={{ position: "absolute", top: 8, transform: "translateX(-50%)", fontSize: 9, color: FLOW_COLORS.dim, letterSpacing: "0.1em" }}>t{t}</span>
        </div>
      ))}
    </>
  );
}

function Legend({ y }: { y: number }) {
  const items: Array<[string, string]> = [
    [FLOW_COLORS.ink, "main thread"],
    [FLOW_COLORS.awaited, "⏸ suspended while ⏱ awaited task runs"],
    [FLOW_COLORS.dim, "ghost = conditional path"],
    [FLOW_COLORS.detached, "dashed violet = keeps running after return"],
  ];
  return (
    <div style={{ position: "absolute", left: LEFT - 40, top: y, display: "flex", gap: 18, fontFamily: MONO, fontSize: 9.5, color: FLOW_COLORS.dim }}>
      {items.map(([c, t]) => (
        <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 12, height: 3, background: c, borderRadius: 2 }} /> {t}
        </span>
      ))}
    </div>
  );
}

function LANES(bgCount: number, bgY: (i: number) => number) {
  const rows: Array<[number, string, boolean]> = [
    [Y.alt, "ALT PATH", false], [Y.main, "MAIN", true], [Y.task, "AWAITED TASK", false], [Y.catch, "ON THROW", false],
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

function ghostFrame(left: number, right: number): React.CSSProperties {
  return { position: "absolute", left: left - 6, top: Y.main - 26, width: right - left + 12, height: 52, border: `1px dashed ${FLOW_COLORS.faint}`, borderRadius: 8, background: `${FLOW_COLORS.branch}0A` };
}

const GHOST_TAG: React.CSSProperties = { position: "absolute", top: -8, left: 8, fontSize: 8, letterSpacing: "0.12em", color: FLOW_COLORS.branch, background: FLOW_COLORS.canvas, padding: "0 5px", textTransform: "uppercase" };
