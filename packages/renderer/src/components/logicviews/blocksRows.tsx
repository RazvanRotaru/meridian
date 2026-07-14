/**
 * The recursive body of the Blocks (structogram) view: one `FlowStep[]` rendered as a stack of rows
 * and nested scope blocks. Nesting mirrors the source — a branch/loop/try/callback is a bordered
 * block whose children recurse through the same `<Rows>`, so arbitrary depth just works. Calls carry
 * the SAME interaction contract as the exec graph (select-by-target, Shift+Enter/double-click to
 * drill); the selection/drill wiring rides down through `RowCtx` so this file needs no store access.
 */

import type { ChangeStatus, FlowStep, LogicFlows, NodeId } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import type { CallStep, ExitStep, BranchStep } from "../../derive/flowViewModel";
import { branchKindOf } from "@meridian/core";
import { FLOW_COLORS, callDisplay } from "../../derive/flowViewModel";
import { branchCompartments } from "../../derive/blocksModel";
import type { Compartment } from "../../derive/blocksModel";
import { TargetChangedTag } from "../nodes/logic/logicNodeTypes";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The navigation state every row needs — the exec-graph contract, passed down instead of read from a store. */
export interface RowCtx {
  flows: LogicFlows;
  index: GraphIndex;
  selected: NodeId | null;
  onSelect: (target: NodeId | null) => void;
  onDrill: (target: NodeId) => void;
  drillEnabled: boolean;
}

export function Rows({ steps, ctx }: { steps: FlowStep[]; ctx: RowCtx }) {
  return (
    <div style={STACK}>
      {steps.map((step, i) => (
        <RowNode key={i} step={step} ctx={ctx} />
      ))}
    </div>
  );
}

function RowNode({ step, ctx }: { step: FlowStep; ctx: RowCtx }) {
  switch (step.kind) {
    case "call":
      return <CallRow step={step} ctx={ctx} />;
    case "await":
      return <div style={AWAIT_ROW}><span style={AWAIT_GATE}>⌟</span><span>{step.label}</span></div>;
    case "exit":
      return <ExitChip step={step} />;
    case "loop":
      return <BlockShell accent={FLOW_COLORS.loop} header={`↻ ${step.label}`}><Rows steps={step.body} ctx={ctx} /></BlockShell>;
    case "callback":
      return (
        <BlockShell accent={FLOW_COLORS.callback} header={`⤳ ${step.label}`} note="handed over · runs later, maybe">
          <Rows steps={step.body} ctx={ctx} />
        </BlockShell>
      );
    case "branch":
      return <BranchBlock step={step} ctx={ctx} />;
  }
}

function BranchBlock({ step, ctx }: { step: BranchStep; ctx: RowCtx }) {
  const isTry = branchKindOf(step) === "try";
  const accent = isTry ? FLOW_COLORS.try : FLOW_COLORS.branch;
  const header = isTry ? "⚠ try / catch" : `? ${step.label}`;
  const comps: Compartment[] = isTry
    ? step.paths.map((path) => ({ caption: path.label, synthesized: false, body: path.body, note: null }))
    : branchCompartments(step);
  return (
    <BlockShell accent={accent} header={header}>
      <div style={COLS}>
        {comps.map((comp, i) => (
          <div key={i} style={{ ...COL, borderLeft: i === 0 ? "none" : `1px dashed ${accent}59` }}>
            <div style={comp.synthesized ? CAPTION_SYNTH : { ...CAPTION, color: accent }}>{comp.caption}</div>
            {comp.synthesized ? <div style={CONT}>{comp.note}</div> : <Rows steps={comp.body} ctx={ctx} />}
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

function BlockShell(props: { accent: string; header: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ ...BLOCK, borderColor: `${props.accent}8C`, background: `${props.accent}0F` }}>
      <div style={{ ...BLOCK_HD, color: props.accent, borderBottom: `1px dashed ${props.accent}59` }}>
        <span>{props.header}</span>
        {props.note ? <span style={BLOCK_NOTE}>{props.note}</span> : null}
      </div>
      <div style={BLOCK_BODY}>{props.children}</div>
    </div>
  );
}

function CallRow({ step, ctx }: { step: CallStep; ctx: RowCtx }) {
  const display = callDisplay(step, ctx.flows, ctx.index);
  const accent = display.method ? FLOW_COLORS.method : FLOW_COLORS.call;
  const hasTarget = step.target !== null;
  const targetChangedStatus: ChangeStatus | undefined = step.resolution === "resolved" && step.target
    ? ctx.index.changedStatus.get(step.target)
    : undefined;
  const isSelected = ctx.selected !== null && step.target === ctx.selected;
  const dimmed = ctx.selected !== null && !isSelected;
  const opacity = isSelected ? 1 : dimmed ? (targetChangedStatus ? 0.82 : 0.55) : 1;
  const canDrill = ctx.drillEnabled && display.navigable;
  const style: React.CSSProperties = {
    ...ROW,
    borderLeft: `3px solid ${accent}`,
    opacity,
    cursor: hasTarget ? "pointer" : "default",
    boxShadow: isSelected ? `0 0 0 2px ${FLOW_COLORS.select}` : "none",
  };
  const copy = (
    <>
      <span style={{ ...GLYPH, color: accent }}>{display.method ? "∷" : "ƒ"}</span>
      <span style={NAME}>{step.label}</span>
      {display.provenance ? <span style={PROV}>{display.provenance}</span> : null}
      {targetChangedStatus ? <TargetChangedTag status={targetChangedStatus} /> : null}
      <span style={SPRING} />
      {step.awaited ? <Badge accent={FLOW_COLORS.awaited} text="⏱ AWAIT" /> : null}
      {step.detached ? <Badge accent={FLOW_COLORS.detached} text="⤳ DETACHED" /> : null}
    </>
  );

  if (!hasTarget) {
    return <div style={style}>{copy}</div>;
  }
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-keyshortcuts={canDrill ? "Shift+Enter" : undefined}
      title={canDrill ? "Shift+Enter to open this call's logic flow" : undefined}
      style={{ ...style, width: "100%", appearance: "none", margin: 0, color: "inherit", textAlign: "left" }}
      onClick={(event) => {
        event.stopPropagation();
        ctx.onSelect(step.target);
      }}
      onDoubleClick={(event) => {
        if (!canDrill) return;
        event.stopPropagation();
        ctx.onDrill(step.target!);
      }}
      onKeyDown={(event) => {
        if (canDrill && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          ctx.onDrill(step.target!);
        }
      }}
    >
      {copy}
    </button>
  );
}

function Badge({ accent, text }: { accent: string; text: string }) {
  return <span style={{ ...BADGE, color: accent, borderColor: `${accent}8C` }}>{text}</span>;
}

function ExitChip({ step }: { step: ExitStep }) {
  const verb = step.variant === "return" ? "⏎ return" : "⚡ throw";
  return <div style={RET}>{step.label ? `${verb} ${step.label}` : verb}</div>;
}

const STACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };
const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: FLOW_COLORS.card,
  border: `1px solid ${FLOW_COLORS.faint}`,
  borderRadius: 5,
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: MONO,
};
const GLYPH: React.CSSProperties = { fontSize: 11, width: 15, textAlign: "center", flex: "none" };
const NAME: React.CSSProperties = { fontWeight: 600, color: FLOW_COLORS.ink };
const PROV: React.CSSProperties = { color: FLOW_COLORS.dim, fontSize: 10, marginLeft: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const SPRING: React.CSSProperties = { flex: 1 };
const BADGE: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", padding: "1px 6px", borderRadius: 3, border: "1px solid", flex: "none" };
const RET: React.CSSProperties = {
  alignSelf: "stretch",
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: `1px solid ${FLOW_COLORS.exitCap}`,
  borderRadius: 5,
  padding: "5px 10px",
  fontSize: 11.5,
  color: FLOW_COLORS.exitCap,
  background: `${FLOW_COLORS.exitCap}14`,
  fontWeight: 600,
  fontFamily: MONO,
};
const AWAIT_ROW: React.CSSProperties = {
  ...ROW,
  borderColor: `${FLOW_COLORS.awaited}99`,
  borderLeft: `3px solid ${FLOW_COLORS.awaited}`,
  color: FLOW_COLORS.ink,
  background: `${FLOW_COLORS.awaited}0D`,
};
const AWAIT_GATE: React.CSSProperties = { color: FLOW_COLORS.awaited, fontSize: 16, lineHeight: 1 };
const BLOCK: React.CSSProperties = { border: "1px solid", borderRadius: 7 };
const BLOCK_HD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 11px", fontSize: 11.5, fontWeight: 600, fontFamily: MONO };
const BLOCK_NOTE: React.CSSProperties = { color: FLOW_COLORS.dim, fontWeight: 400, fontSize: 10 };
const BLOCK_BODY: React.CSSProperties = { display: "block" };
const COLS: React.CSSProperties = { display: "flex" };
const COL: React.CSSProperties = { flex: 1, padding: 9, display: "flex", flexDirection: "column", gap: 7, minWidth: 0 };
const CAPTION: React.CSSProperties = { fontSize: 9, letterSpacing: "0.13em", textTransform: "uppercase", margin: "0 2px 1px" };
const CAPTION_SYNTH: React.CSSProperties = { fontSize: 10, color: FLOW_COLORS.dim, fontStyle: "italic", margin: "0 2px 1px" };
const CONT: React.CSSProperties = { fontSize: 10.5, color: FLOW_COLORS.dim, padding: "3px 4px", lineHeight: 1.5 };
