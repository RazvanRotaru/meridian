/**
 * The Wire INSPECTOR: click a wire and see the EVIDENCE behind it. Every Map wire is an aggregate
 * (a claim: "these two are coupled, calls ×7"); the inspector pins a panel that lists the concrete
 * symbol→symbol links it stands for — resolved through the wire's `underlyingEdgeIds` back to the
 * artifact's real edges and their `callSites` — so any line on the canvas is attributable down to
 * file:line. It inspects the clicked strand's WHOLE ordered pair (one section per relationship
 * kind, clicked kind first): parallel same-pair strands overlap on canvas, so whichever one wins
 * the click, the panel tells the pair's complete story. Endpoint names REVEAL the symbol on the
 * map (the ghost double-click gesture, reused). A bundle highway inspects too: its constituent
 * wires list first, each drillable into its own links. Wires with no artifact trail (flow chains,
 * IPC joins) show their section header alone.
 */

import { useMemo, useState } from "react";
import type { Edge } from "@xyflow/react";
import type { GraphEdge } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { unitLabel } from "../derive/blockDeps";
import { relColor } from "../theme/mapPalette";
import { BUNDLE_EDGE_TYPE, bundleLabel, type BundleEdgeData } from "../layout/edgeBundling";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { MONO } from "./nodes/modulemap/frameChrome";

interface WireInspectorProps {
  /** The clicked strand's full ordered-pair stack, clicked strand FIRST (see `pairOf`). */
  pair: Edge[];
  /** The drawn label for an on-canvas node id (the level's cards); symbol ids fall back to `unitLabel`. */
  labelOf: (id: string) => string | undefined;
  onClose: () => void;
  /** A bundle's constituent row drills the inspector into that single wire. */
  onDrill: (edge: Edge) => void;
}

const ROW_CAP = 12;
const SITE_CAP = 6;

export function WireInspector({ pair, labelOf, onClose, onDrill }: WireInspectorProps) {
  useClearOnEscape(onClose, true);
  return (
    <div style={PANEL}>
      {pair[0].type === BUNDLE_EDGE_TYPE ? (
        <BundleBody edge={pair[0]} labelOf={labelOf} onClose={onClose} onDrill={onDrill} />
      ) : (
        <PairBody pair={pair} labelOf={labelOf} onClose={onClose} />
      )}
    </div>
  );
}

/** The pair's story: endpoints once in the header, then one evidence section per strand (kind). */
function PairBody({ pair, labelOf, onClose }: Omit<WireInspectorProps, "onDrill">) {
  const index = useBlueprint((state) => state.index);
  const name = (id: string) => labelOf(id) ?? unitLabel(id, index);
  const first = pair[0];
  return (
    <>
      <div style={HEADER}>
        <span style={HEADER_ENDS}>
          <RevealName id={first.source} label={name(first.source)} onRevealed={onClose} />
          <span style={ARROW}> → </span>
          <RevealName id={first.target} label={name(first.target)} onRevealed={onClose} />
        </span>
        <CloseButton onClose={onClose} />
      </div>
      {pair.map((edge) => (
        <KindSection key={edge.id} edge={edge} name={name} onRevealed={onClose} />
      ))}
    </>
  );
}

/** One strand's evidence: its kind (coloured) × weight, then the concrete links with call sites. */
function KindSection({ edge, name, onRevealed }: { edge: Edge; name: (id: string) => string; onRevealed: () => void }) {
  const index = useBlueprint((state) => state.index);
  const data = edge.data as { depKind?: string; category?: string; weight?: number; underlyingEdgeIds?: string[] } | undefined;
  const kind = data?.depKind ?? data?.category ?? "wire";
  const links = useMemo(() => resolveLinks(data?.underlyingEdgeIds, index.edgesById), [data?.underlyingEdgeIds, index.edgesById]);
  return (
    <div style={SECTION}>
      <div style={SECTION_HEAD}>
        <span style={{ ...KIND_DOT, background: relColor(kind) ?? "#8B95A3" }} />
        <span style={SECTION_KIND}>
          {kind}
          {(data?.weight ?? 1) > 1 ? <span style={HEADER_WEIGHT}> ×{data?.weight}</span> : null}
        </span>
      </div>
      {links.length === 0 ? (
        <div style={EMPTY_NOTE}>No per-site attribution for this wire kind.</div>
      ) : (
        <CappedRows
          count={links.length}
          render={(shown) =>
            links.slice(0, shown).map((link) => <LinkRow key={link.id} link={link} name={name} onRevealed={onRevealed} />)
          }
        />
      )}
    </div>
  );
}

/** A bundle highway's inspector: the member wires, each drillable into its own evidence. */
function BundleBody({ edge, labelOf, onClose, onDrill }: Omit<WireInspectorProps, "pair"> & { edge: Edge }) {
  const index = useBlueprint((state) => state.index);
  const bundle = edge.data as unknown as BundleEdgeData;
  const name = (id: string) => labelOf(id) ?? unitLabel(id, index);
  return (
    <>
      <Header kind={`highway · ${bundleLabel(bundle.breakdown)}`} weight={bundle.count} onClose={onClose} />
      <div style={ENDS}>
        {name(bundle.sourceParent)} <span style={ARROW}>→</span> {name(bundle.targetParent)}
      </div>
      <CappedRows
        count={bundle.constituents.length}
        render={(shown) =>
          bundle.constituents.slice(0, shown).map((member) => {
            const data = member.data as { depKind?: string; category?: string; weight?: number } | undefined;
            return (
              <button key={member.id} type="button" style={ROW_BUTTON} title="Inspect this wire" onClick={() => onDrill(member)}>
                <span style={{ ...KIND_DOT, background: relColor(data?.depKind ?? "") ?? "#8B95A3" }} />
                <span style={ROW_MAIN}>
                  {name(member.source)} <span style={ARROW}>→</span> {name(member.target)}
                </span>
                <span style={ROW_KIND}>
                  {data?.depKind ?? data?.category}
                  {(data?.weight ?? 1) > 1 ? ` ×${data?.weight}` : ""}
                </span>
              </button>
            );
          })
        }
      />
    </>
  );
}

/** One concrete artifact link: source symbol → target symbol, with its call-site chips. The kind
 * is the SECTION's story (its coloured header) — repeating it per row would be noise. */
function LinkRow({ link, name, onRevealed }: { link: GraphEdge; name: (id: string) => string; onRevealed: () => void }) {
  const sites = link.callSites ?? [];
  return (
    <div style={ROW}>
      <div style={ROW_TOP}>
        <span style={ROW_MAIN}>
          <RevealName id={link.source} label={name(link.source)} onRevealed={onRevealed} />
          <span style={ARROW}> → </span>
          <RevealName id={link.target} label={name(link.target)} onRevealed={onRevealed} />
        </span>
      </div>
      {sites.length > 0 ? (
        <div style={SITES}>
          {sites.slice(0, SITE_CAP).map((site, i) => (
            <span key={i} style={SITE_CHIP} title={`${site.file}:${site.line}`}>
              {site.file.split("/").pop()}:{site.line}
            </span>
          ))}
          {sites.length > SITE_CAP ? <span style={SITE_MORE}>+{sites.length - SITE_CAP} more</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A clickable endpoint name: reveals the symbol on the map (refocus + select), closing the panel —
 * the level under it is about to change, so a stale inspector must not linger. */
function RevealName({ id, label, onRevealed }: { id: string; label: string; onRevealed: () => void }) {
  const { revealModule } = useBlueprintActions();
  return (
    <button
      type="button"
      style={NAME_BUTTON}
      title="Reveal on map"
      onClick={() => {
        revealModule(id);
        onRevealed();
      }}
    >
      {label}
    </button>
  );
}

function Header({ kind, weight, onClose }: { kind: string; weight: number; onClose: () => void }) {
  return (
    <div style={HEADER}>
      <span style={HEADER_KIND}>
        {kind}
        {weight > 1 ? <span style={HEADER_WEIGHT}> ×{weight}</span> : null}
      </span>
      <CloseButton onClose={onClose} />
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" style={CLOSE} title="Close (Esc)" onClick={onClose}>
      ✕
    </button>
  );
}

/** Long evidence lists start capped; one click un-caps (never paginate a reader mid-trail). */
function CappedRows({ count, render }: { count: number; render: (shown: number) => React.ReactNode }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? count : Math.min(count, ROW_CAP);
  return (
    <div style={ROWS}>
      {render(shown)}
      {shown < count ? (
        <button type="button" style={SHOW_ALL} onClick={() => setShowAll(true)}>
          Show all {count}
        </button>
      ) : null}
    </div>
  );
}

/** The wire's artifact edges, deduped (defensive — an id should appear once) and heaviest first. */
function resolveLinks(ids: string[] | undefined, edgesById: ReadonlyMap<string, GraphEdge>): GraphEdge[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  const links = [...new Set(ids)].map((id) => edgesById.get(id)).filter((edge): edge is GraphEdge => edge !== undefined);
  return links.sort((a, b) => (b.callSites?.length ?? b.weight ?? 1) - (a.callSites?.length ?? a.weight ?? 1));
}

const PANEL: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 20,
  width: 360,
  maxHeight: "62%",
  overflowY: "auto",
  background: "rgba(22, 27, 34, 0.97)",
  border: "1px solid #30363d",
  borderRadius: 8,
  padding: "8px 10px",
  fontFamily: MONO,
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const HEADER_KIND: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: "#E6EDF3" };
const HEADER_WEIGHT: React.CSSProperties = { fontWeight: 400, color: "#9AA4B2" };
// The pair header IS the endpoints — bold card ink, one line, symmetric truncation via ellipsis.
const HEADER_ENDS: React.CSSProperties = { minWidth: 0, fontSize: 11.5, fontWeight: 700, color: "#E6EDF3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const SECTION: React.CSSProperties = { marginTop: 8 };
const SECTION_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const SECTION_KIND: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#C9D1D9" };
const CLOSE: React.CSSProperties = { border: "none", background: "none", color: "#9AA4B2", cursor: "pointer", fontSize: 12, padding: 2 };
const ENDS: React.CSSProperties = { fontSize: 10.5, color: "#9AA4B2", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ARROW: React.CSSProperties = { color: "#565E68" };
const ROWS: React.CSSProperties = { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 };
const ROW: React.CSSProperties = { borderTop: "1px solid #21262d", paddingTop: 6 };
const ROW_TOP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const ROW_MAIN: React.CSSProperties = { minWidth: 0, flex: 1, fontSize: 10.5, color: "#C9D1D9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ROW_KIND: React.CSSProperties = { flexShrink: 0, fontSize: 9.5, color: "#7A8290" };
const ROW_BUTTON: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  border: "none",
  borderTop: "1px solid #21262d",
  background: "none",
  padding: "6px 0 0",
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
};
const KIND_DOT: React.CSSProperties = { flexShrink: 0, width: 7, height: 7, borderRadius: "50%" };
const NAME_BUTTON: React.CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textDecorationColor: "#3B434E",
  textUnderlineOffset: 2,
};
const SITES: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4, marginLeft: 13 };
const SITE_CHIP: React.CSSProperties = {
  fontSize: 9,
  color: "#9AA4B2",
  background: "#1A212B",
  border: "1px solid #262D38",
  borderRadius: 4,
  padding: "1px 5px",
};
const SITE_MORE: React.CSSProperties = { fontSize: 9, color: "#565E68", alignSelf: "center" };
const SHOW_ALL: React.CSSProperties = {
  marginTop: 2,
  border: "1px solid #30363d",
  borderRadius: 6,
  background: "none",
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 10,
  padding: "3px 8px",
};
const EMPTY_NOTE: React.CSSProperties = { marginTop: 8, fontSize: 10, color: "#565E68" };
