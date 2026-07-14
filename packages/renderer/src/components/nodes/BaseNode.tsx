/**
 * The surface-agnostic graph-node chassis shared by the codebase and Logic canvases.
 *
 * A rendered node has two deliberately separate identities:
 *   - `instanceId` is the React Flow/layout occurrence and is what expand/collapse toggles;
 *   - `targetId` is the canonical artifact and is what navigation/source actions open.
 *
 * Map nodes normally use the same id for both. Logic calls do not: the same function can occur
 * several times in one flow, and each occurrence must expand independently while every occurrence
 * still navigates to the same callable.
 *
 * The active canvas supplies actions through `BaseNodeActionScope`. The component owns the DOM
 * contract: one disclosure in the title tail, propagation guards, ARIA state, and double-click
 * navigation. Surface/store semantics remain in the mount that owns the canvas.
 */

import { createContext, useContext, useMemo } from "react";
import type { NodeSemanticModel } from "../../nodeSemantics";
import { NODE_DISCLOSURE_SIZE } from "../../theme/nodeChrome";
import { NodeKindBadge, NodeSemanticRail } from "./NodeSemanticRail";

export interface BaseNodeModel {
  /** React Flow/layout identity; expansion is always keyed by this id. */
  instanceId: string;
  /** Canonical artifact/source identity. Null for structural view-only nodes. */
  targetId: string | null;
  /** React Flow node type, retained for surface-specific navigation policies. */
  nodeType?: string;
  /** Semantic identity shown by this node (`file`, `class`, `method`, ...). */
  kind: string;
  /** Declaration and call-occurrence facts rendered by the shared semantic rail. */
  semantics?: NodeSemanticModel;
  label: string;
  childCount: number;
  canExpand: boolean;
  expanded: boolean;
  canNavigate: boolean;
  /** Original serializable node data, available to the surface navigation adapter. */
  data: Record<string, unknown>;
}

export interface BaseNodeActions {
  toggleExpand: ((model: BaseNodeModel) => void) | null;
  navigateInto: ((model: BaseNodeModel, event: React.MouseEvent<HTMLDivElement>) => void) | null;
}

const NO_ACTIONS: BaseNodeActions = { toggleExpand: null, navigateInto: null };
const BaseNodeActionContext = createContext<BaseNodeActions>(NO_ACTIONS);

export function BaseNodeActionScope({
  toggleExpand,
  navigateInto,
  children,
}: Partial<BaseNodeActions> & { children: React.ReactNode }) {
  const value = useMemo<BaseNodeActions>(
    () => ({ toggleExpand: toggleExpand ?? null, navigateInto: navigateInto ?? null }),
    [navigateInto, toggleExpand],
  );
  return <BaseNodeActionContext.Provider value={value}>{children}</BaseNodeActionContext.Provider>;
}

export function useBaseNodeActions(): BaseNodeActions {
  return useContext(BaseNodeActionContext);
}

export interface BaseNodeProps {
  model: BaseNodeModel;
  style: React.CSSProperties;
  headerStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  /** Optional visual label treatment; interaction/ARIA text continues to use `model.label`. */
  labelContent?: React.ReactNode;
  /** Optional non-kind visual mark. BaseNode renders the readable kind marker itself. */
  leading?: React.ReactNode;
  /** Coverage/change/runtime indicators, rendered after semantics and before utility actions. */
  indicators?: React.ReactNode;
  /** Source and other utility actions. Disclosure is always appended after this slot. */
  actions?: React.ReactNode;
  /** Handles and other elements that must be direct children of the node shell. */
  ports?: React.ReactNode;
  children?: React.ReactNode;
  /** Optional wrapper around the header/body (for padded stacked card bodies). */
  contentStyle?: React.CSSProperties;
  className?: string;
  title?: string;
  labelTitle?: string;
  /** Extra attributes used by request/review paint without forking the chassis. */
  domAttributes?: React.HTMLAttributes<HTMLDivElement>;
}

export function BaseNode({
  model,
  style,
  headerStyle,
  labelStyle,
  labelContent,
  leading,
  indicators,
  actions,
  ports,
  children,
  contentStyle,
  className,
  title,
  labelTitle,
  domAttributes,
}: BaseNodeProps) {
  const controller = useBaseNodeActions();
  // `canExpand` is the authoritative content contract. A local callable may have zero graph
  // children yet still own the shared empty-flow expansion; inferring capability from childCount
  // would make those real source entities look like a different leaf component.
  const disclosure = model.canExpand && controller.toggleExpand !== null
    ? <NodeDisclosure model={model} onToggle={controller.toggleExpand} />
    : null;
  const navigate = model.canNavigate ? controller.navigateInto : null;
  const content = (
    <>
      <div style={headerStyle} data-base-node-header="true">
        {leading}
        <NodeKindBadge kind={model.kind} />
        <span style={labelStyle} title={labelTitle ?? model.label}>{labelContent ?? model.label}</span>
        {(model.semantics !== undefined || indicators !== undefined || actions !== undefined || disclosure !== null) ? (
          <span style={ACTION_RAIL} data-base-node-actions="true">
            <NodeSemanticRail semantics={model.semantics} />
            {indicators}
            {actions}
            {disclosure}
          </span>
        ) : null}
      </div>
      {children}
    </>
  );

  return (
    <div
      {...domAttributes}
      className={className}
      style={style}
      title={title}
      data-base-node="true"
      data-base-node-kind={model.kind}
      data-base-node-expanded={model.expanded ? "true" : "false"}
      onDoubleClick={navigate === null ? domAttributes?.onDoubleClick : (event) => {
        domAttributes?.onDoubleClick?.(event);
        if (event.defaultPrevented || isInteractiveTarget(event.target)) {
          // Nested source/status/disclosure controls own their gesture. Do not let the same native
          // double-click continue to React Flow's wrapper-level navigation handler.
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        navigate(model, event);
      }}
    >
      {ports}
      {contentStyle === undefined ? content : <div style={contentStyle}>{content}</div>}
    </div>
  );
}

/** The one disclosure vocabulary for every entity node, always rendered by BaseNode in the tail. */
export function NodeDisclosure({
  model,
  onToggle,
}: {
  model: BaseNodeModel;
  onToggle: NonNullable<BaseNodeActions["toggleExpand"]>;
}) {
  const label = model.expanded ? "Collapse" : "Expand";
  return (
    <button
      type="button"
      style={DISCLOSURE}
      title={`${label} — ${model.label}`}
      aria-label={`${label} ${model.label}`}
      aria-expanded={model.expanded}
      data-base-node-disclosure="true"
      data-node-disclosure-state={model.expanded ? "expanded" : "collapsed"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(model);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={DISCLOSURE_ICON}>
        <path d={model.expanded ? "M3.5 6 L8 10.5 L12.5 6" : "M6 3.5 L10.5 8 L6 12.5"} />
      </svg>
    </button>
  );
}

function isInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea") !== null;
}

const ACTION_RAIL: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flexShrink: 0,
  marginLeft: "auto",
};

const DISCLOSURE: React.CSSProperties = {
  flexShrink: 0,
  width: NODE_DISCLOSURE_SIZE,
  height: NODE_DISCLOSURE_SIZE,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  marginLeft: 2,
  border: "1px solid rgba(200, 211, 224, 0.5)",
  borderRadius: 5,
  background: "rgba(7, 11, 17, 0.72)",
  color: "#EDF4FC",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.035), 0 1px 4px rgba(0,0,0,0.32)",
  cursor: "pointer",
};

const DISCLOSURE_ICON: React.CSSProperties = {
  display: "block",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  vectorEffect: "non-scaling-stroke",
};
