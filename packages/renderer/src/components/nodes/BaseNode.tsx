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

export interface BaseNodeModel {
  /** React Flow/layout identity; expansion is always keyed by this id. */
  instanceId: string;
  /** Canonical artifact/source identity. Null for structural view-only nodes. */
  targetId: string | null;
  /** React Flow node type, retained for surface-specific navigation policies. */
  nodeType?: string;
  /** Semantic identity shown by this node (`file`, `class`, `method`, ...). */
  kind: string;
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
  leading?: React.ReactNode;
  /** Status/source/coverage actions. Disclosure is always appended after this slot. */
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
  const disclosure = model.canExpand && model.childCount > 0 && controller.toggleExpand !== null
    ? <NodeDisclosure model={model} onToggle={controller.toggleExpand} />
    : null;
  const navigate = model.canNavigate ? controller.navigateInto : null;
  const content = (
    <>
      <div style={headerStyle} data-base-node-header="true">
        {leading}
        <span style={labelStyle} title={labelTitle ?? model.label}>{labelContent ?? model.label}</span>
        {(actions !== undefined || disclosure !== null) ? (
          <span style={ACTION_RAIL} data-base-node-actions="true">
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
      onClick={(event) => {
        event.stopPropagation();
        onToggle(model);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {model.expanded ? "▾" : "▸"}
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
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  borderRadius: 3,
  background: "transparent",
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 11,
};
