/** The dense Service overview's parent-assignment strategy. All modes feed the same artificial
 * container nodes; this control changes only which services ELK places inside each parent. */

import { useEffect, useId, useRef, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import {
  SERVICE_GROUPING_OPTIONS,
  type ServiceGroupingLabelMode,
  type ServiceGroupingMode,
} from "../derive/serviceClusteringModes";
import {
  SERVICE_GROUPING_TARGET_SIZES,
  type ServiceGroupingTargetSize,
} from "../state/serviceGroupingTargetSize";
import { Pill, TOKENS } from "./controlpanel/panelKit";
import { ExternalLinkIcon, InfoIcon } from "./controlpanel/icons";

const DESCRIPTION: Record<ServiceGroupingMode, string> = {
  domain: "Experimental hybrid of dependencies, vocabulary, folders, and API shape.",
  "edge-cut": "Balanced groups intended to leave as few dependency links between parents as possible.",
  leiden: "Connected communities inferred from dependency affinity with a Leiden + CPM–inspired heuristic.",
  bunch: "Target-sized visual parents built from cohesion-first Bunch MQ communities.",
  "coupling-cut": "Balanced groups intended to leave as little weighted dependency coupling between parents as possible.",
  dependency: "Communities connected by extracted static dependency kinds.",
  folder: "The first directory below the dominant shared path prefix.",
  vocabulary: "Similar names, paths, member names, signatures, and summaries.",
  api: "Contract-level lookalikes; not proof of duplicate implementation.",
};
const HELP_ID = "service-grouping-help";
const SHARED_INFO = "This mode places already-derived service composition frames into artificial parent nodes; it does not change which helper units belong to each frame.";

interface GroupingSource {
  label: string;
  href: string;
}

export interface ServiceGroupingInfo {
  summary: string;
  evidence: string;
  optimization: string;
  implementation: string;
  caveat: string;
  badge: string;
  sources: readonly GroupingSource[];
}

const MODULARITY_SOURCE: GroupingSource = {
  label: "Newman — Modularity and community structure (2006)",
  href: "https://doi.org/10.1073/pnas.0601602103",
};
const LOUVAIN_SOURCE: GroupingSource = {
  label: "Blondel et al. — Fast unfolding of communities (2008)",
  href: "https://arxiv.org/abs/0803.0476",
};
const MERIDIAN_CLUSTERING_SOURCE: GroupingSource = {
  label: "Meridian clustering implementation",
  href: "https://github.com/RazvanRotaru/meridian/blob/main/packages/renderer/src/derive/serviceClusteringModes.ts",
};
const MERIDIAN_FOLDER_SOURCE: GroupingSource = {
  label: "Meridian folder-domain implementation",
  href: "https://github.com/RazvanRotaru/meridian/blob/main/packages/renderer/src/derive/pathDomains.ts",
};
const BUNCH_SOURCE: GroupingSource = {
  label: "Mitchell & Mancoridis — Software modularization with Bunch (2006)",
  href: "https://doi.org/10.1109/TSE.2006.31",
};
const LEIDEN_SOURCE: GroupingSource = {
  label: "Traag, Waltman & van Eck — From Louvain to Leiden (2019)",
  href: "https://doi.org/10.1038/s41598-019-41695-z",
};
const CPM_SOURCE: GroupingSource = {
  label: "Traag, Van Dooren & Nesterov — Constant Potts Model (2011)",
  href: "https://doi.org/10.1103/PhysRevE.84.016114",
};
const MULTILEVEL_PARTITION_SOURCE: GroupingSource = {
  label: "Karypis & Kumar — Multilevel graph partitioning (1998)",
  href: "https://doi.org/10.1137/S1064827595287997",
};
const KERNIGHAN_LIN_SOURCE: GroupingSource = {
  label: "Kernighan & Lin — Graph partitioning heuristic (1970)",
  href: "https://doi.org/10.1002/j.1538-7305.1970.tb01770.x",
};
const FIDUCCIA_MATTHEYSES_SOURCE: GroupingSource = {
  label: "Fiduccia & Mattheyses — Linear-time partition refinement (1982)",
  href: "https://doi.org/10.1145/800263.809204",
};

/** User-facing documentation for the exact deterministic heuristics implemented in
 * serviceClusteringModes.ts. Keep these claims narrower than a general code-clustering survey. */
export const SERVICE_GROUPING_INFO: Record<ServiceGroupingMode, ServiceGroupingInfo> = {
  domain: {
    summary: "An experimental architectural overview that combines several weak signals instead of trusting one convention.",
    evidence: "50% typed dependency coupling, 25% developer vocabulary, 15% folder proximity, and 10% API-role similarity.",
    optimization: "Meridian runs deterministic modularity optimization over the combined affinity graph, with finer resolution for larger or denser systems.",
    implementation: "A custom deterministic Meridian heuristic. It borrows the modularity objective, but it is not the reference Louvain implementation.",
    caveat: "Useful for exploration, but the groups are inferred themes—not declared bounded contexts or ownership boundaries.",
    badge: "Meridian heuristic",
    sources: [MODULARITY_SOURCE, LOUVAIN_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  "edge-cut": {
    summary: "Creates size-bounded parents while directly trying to minimize the number of static dependency links that cross between them.",
    evidence: "An undirected service graph aggregates extracted construction, call, inheritance, implementation, and reference relationships. Each connected service pair counts as one link for the primary cut objective.",
    optimization: "The selected target size determines a feasible number and range of parent sizes. Deterministic seeding and region growth are followed by local moves and swaps that reduce cut-link count and, secondarily, the number of connected parent pairs without worsening group connectivity.",
    implementation: "A custom Meridian balanced-partition approximation inspired by multilevel partitioning and local refinement. It is not METIS, Kernighan–Lin, or Fiduccia–Mattheyses itself and does not compute an exact minimum cut.",
    caveat: "A smaller cut can hide semantically meaningful boundaries, and strict balance can split a natural large community. Results depend on what static relationships extraction can observe.",
    badge: "Custom approximation",
    sources: [MULTILEVEL_PARTITION_SOURCE, KERNIGHAN_LIN_SOURCE, FIDUCCIA_MATTHEYSES_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  leiden: {
    summary: "Finds dependency communities using the Constant Potts Model objective and Leiden-style refinement so strongly connected services tend to share a parent.",
    evidence: "The same normalized, typed static dependency affinity used by Dependency grouping supplies the weighted undirected graph.",
    optimization: "Custom fast-moving, refinement, and aggregation stages improve a CPM-style quality function. The selected target adjusts CPM resolution; graph structure still determines the uneven final sizes.",
    implementation: "A custom deterministic implementation of the published Leiden three-phase structure with CPM and seeded positive-temperature refinement. It is not a binding to the reference leidenalg/igraph implementation and does not claim every formal guarantee of published Leiden.",
    caveat: "Target size is a soft resolution guide, not a balance bound. Communities can remain uneven and isolated services may stand alone.",
    badge: "Reference-inspired",
    sources: [LEIDEN_SOURCE, CPM_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  bunch: {
    summary: "Treats service clustering as software modularization and searches for parents with high internal cohesion and low external coupling.",
    evidence: "Typed static dependency affinity becomes a weighted module-dependency graph; relationships inside a proposed parent and relationships leaving it contribute differently to modularization quality.",
    optimization: "A deterministic hill climb first optimizes Bunch’s published weighted cluster-factor MQ (TurboMQ) under a target-derived maximum. Those intact fine communities are then affinity-packed into the requested number of visual parents.",
    implementation: "Meridian implements the TurboMQ objective directly but uses a custom deterministic hill-climb search; it does not run the Bunch tool. The size cap and packing are separate presentation constraints, not part of the Bunch objective.",
    caveat: "The search may settle in a local optimum, and packing can combine separate fine modules to keep the overview readable. It never makes target size look like part of TurboMQ itself.",
    badge: "Reference-inspired",
    sources: [BUNCH_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  "coupling-cut": {
    summary: "Creates size-bounded parents while directly trying to minimize the strength of static dependency coupling that crosses between them.",
    evidence: "Extracted service relationships are aggregated and weighted by kind: construction and calls carry more weight than inheritance, implementation, and references. Runtime call frequency has already been collapsed.",
    optimization: "The selected target size sets balance bounds. Meridian uses deterministic region growth and local moves and swaps to reduce total cross-parent coupling weight, with cut-link count and quotient-graph links as secondary signals.",
    implementation: "A custom Meridian balanced-partition approximation inspired by multilevel partitioning and local refinement; it is not METIS and does not guarantee the global minimum weighted cut.",
    caveat: "Weights encode an architectural opinion and extraction collapses runtime frequency. Balance can still split a natural community to respect the requested parent size.",
    badge: "Custom approximation",
    sources: [MULTILEVEL_PARTITION_SOURCE, KERNIGHAN_LIN_SOURCE, FIDUCCIA_MATTHEYSES_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  dependency: {
    summary: "Groups services connected by extracted static construction, call, inheritance, implementation, and reference relationships.",
    evidence: "Relation-kind presence is aggregated to service leads: instantiates and calls count most; implements/extends count less; references are weaker. Direction and repeated call frequency are collapsed, then endpoint strength is normalized so hubs do not absorb the graph.",
    optimization: "A deterministic modularity pass favors communities with more internal affinity than expected from their total graph degree.",
    implementation: "A custom deterministic Meridian modularity heuristic, not the reference Louvain implementation.",
    caveat: "This reduces cross-community dependency affinity indirectly; it does not solve an exact minimum-edge-cut problem and may isolate weakly connected services.",
    badge: "Meridian heuristic",
    sources: [BUNCH_SOURCE, MODULARITY_SOURCE, LOUVAIN_SOURCE, MERIDIAN_CLUSTERING_SOURCE],
  },
  folder: {
    summary: "Uses repository organization as an explicit, predictable architecture prior.",
    evidence: "Meridian infers a dominant shared path prefix, then assigns each service to the first directory below it; path outliers retain their own first directory.",
    optimization: "No graph optimization is performed. The result is a stable path partition and mirrors how Map lens folders behave.",
    implementation: "A Meridian path rule rather than an external clustering algorithm.",
    caveat: "Useful when paths encode ownership or domains; misleading in layer-first trees such as components/, services/, and utils/.",
    badge: "Deterministic rule",
    sources: [MERIDIAN_FOLDER_SOURCE],
  },
  vocabulary: {
    summary: "Groups services that use similar developer language, even when they live in different folders.",
    evidence: "TF–IDF features come from service and member names, paths, signatures, and summaries. Cosine similarity connects each service to its strongest lexical neighbors.",
    optimization: "The sparse similarity graph is partitioned with the same deterministic modularity optimizer used by the dependency mode.",
    implementation: "Custom Meridian feature extraction and modularity optimization; not a reference text-clustering package.",
    caveat: "Shared naming can reveal a domain, but generic terminology and naming conventions can also create false affinity.",
    badge: "Meridian heuristic",
    sources: [
      {
        label: "Salton & Buckley — Term-weighting approaches (1988)",
        href: "https://doi.org/10.1016/0306-4573(88)90021-0",
      },
      MODULARITY_SOURCE,
      MERIDIAN_CLUSTERING_SOURCE,
    ],
  },
  api: {
    summary: "Surfaces services with similar public shape and dependency roles as candidates for closer comparison.",
    evidence: "A weighted-Jaccard fingerprint combines normalized method signatures, arity, member roles, unit shape, tags, and typed incoming/outgoing dependency profiles.",
    optimization: "Strong nearest-neighbor similarities form a sparse graph, then deterministic modularity optimization turns it into groups.",
    implementation: "Custom Meridian fingerprints and modularity optimization; weighted Jaccard is the similarity measure, not a complete clustering algorithm here.",
    caveat: "Candidate signal only: this is not AST clone detection and does not prove duplicated behavior or implementation.",
    badge: "Meridian heuristic",
    sources: [
      {
        label: "Ioffe — Weighted MinHash and weighted Jaccard (2010)",
        href: "https://doi.org/10.1109/ICDM.2010.80",
      },
      MODULARITY_SOURCE,
      MERIDIAN_CLUSTERING_SOURCE,
    ],
  },
};

export function ServiceGroupingSelect() {
  const mode = useBlueprint((state) => state.serviceGroupingMode);
  const targetSize = useBlueprint((state) => state.serviceGroupingTargetSize);
  const labelMode = useBlueprint((state) => state.serviceGroupingLabelMode);
  const scoped = useBlueprint((state) => state.serviceScope !== null);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const layoutPending = useBlueprint((state) => state.moduleLayoutStatus === "laying-out");
  const layoutActivity = useBlueprint((state) => state.moduleLayoutActivity);
  const {
    setServiceGroupingMode: setMode,
    setServiceGroupingTargetSize: setTargetSize,
    setServiceGroupingLabelMode: setLabelMode,
  } = useBlueprintActions();
  const disabled = scoped || minimalOpen || layoutPending;
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  const headingId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const option = SERVICE_GROUPING_OPTIONS.find((candidate) => candidate.id === mode)!;
  const reason = layoutPending
    ? layoutActivity?.label ?? "Updating graph…"
    : scoped
    ? "Exit the scoped Service view to change whole-system grouping"
    : minimalOpen
      ? "Close the extracted graph to change whole-system grouping"
      : undefined;

  useEffect(() => {
    if (!infoOpen) {
      return;
    }
    function closeFromOutside(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setInfoOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setInfoOpen(false);
        infoButtonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [infoOpen]);

  return (
    <div ref={wrapRef} style={WRAP_STYLE}>
      <div style={CONTROL_ROW_STYLE}>
        <select
          aria-label="Cluster services by"
          aria-describedby={HELP_ID}
          value={mode}
          disabled={disabled}
          style={selectStyle(disabled)}
          onChange={(event) => {
            setInfoOpen(false);
            setMode(event.currentTarget.value as ServiceGroupingMode);
          }}
        >
          {SERVICE_GROUPING_OPTIONS.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id === "domain" ? `${candidate.label} — hybrid` : candidate.label}
            </option>
          ))}
        </select>
        <button
          ref={infoButtonRef}
          type="button"
          style={infoButtonStyle(infoOpen)}
          aria-label={`How ${option.label} service clustering works`}
          aria-controls={infoId}
          aria-expanded={infoOpen}
          title={`How ${option.label} clustering works`}
          onClick={() => setInfoOpen((open) => !open)}
        >
          <InfoIcon size={15} />
        </button>
      </div>
      <span id={HELP_ID} style={HELP_STYLE}>{reason ?? DESCRIPTION[mode]}</span>
      <ServiceGroupingLabelModeControl
        mode={mode}
        labelMode={labelMode}
        disabled={disabled}
        onChange={setLabelMode}
      />
      <ServiceGroupingTargetSizeControl
        mode={mode}
        targetSize={targetSize}
        disabled={disabled}
        onChange={setTargetSize}
      />
      {infoOpen ? (
        <ServiceGroupingInfoPanel mode={mode} id={infoId} headingId={headingId} />
      ) : null}
    </div>
  );
}

/** Semantic techniques can name a generated parent with either their strongest shared concept or
 * multiple distinct concepts. Folder labels come directly from paths, so the switch stays
 * visible but unavailable there rather than suggesting that it changes path-derived names. */
export function ServiceGroupingLabelModeControl(props: {
  mode: ServiceGroupingMode;
  labelMode: ServiceGroupingLabelMode;
  disabled: boolean;
  onChange(mode: ServiceGroupingLabelMode): void;
}) {
  const pair = props.labelMode === "pair";
  const available = props.mode !== "folder";
  const disabled = props.disabled || !available;
  const title = !available
    ? "Folder grouping uses repository path labels"
    : pair
      ? "Use only the strongest shared concept in each generated label"
      : "Add multiple distinct shared concepts to each generated label";
  return (
    <>
      <div style={SIZE_ROW_STYLE} role="group" aria-label="Cluster label detail">
        <span style={SIZE_LABEL_STYLE}>Labels</span>
        <Pill
          active={pair}
          indicator="square"
          disabled={disabled}
          title={title}
          onClick={() => props.onChange(pair ? "single" : "pair")}
        >
          Multi-part labels
        </Pill>
      </div>
      <span style={SIZE_HELP_STYLE}>
        {!available
          ? "Folder names come directly from repository paths."
          : pair
            ? "Shows multiple distinct concepts, separated by slashes."
            : "Shows only the strongest shared concept."}
      </span>
    </>
  );
}

export function serviceGroupingUsesTargetSize(mode: ServiceGroupingMode): boolean {
  return mode === "edge-cut" || mode === "coupling-cut" || mode === "leiden" || mode === "bunch";
}

/** Kept as a small presentational component so the size constraint remains visible—even for
 * community techniques whose objectives infer their own (often intentionally uneven) sizes. */
export function ServiceGroupingTargetSizeControl(props: {
  mode: ServiceGroupingMode;
  targetSize: ServiceGroupingTargetSize;
  disabled: boolean;
  onChange(size: ServiceGroupingTargetSize): void;
}) {
  const selectId = useId();
  const helpId = useId();
  const adjustable = serviceGroupingUsesTargetSize(props.mode);
  const option = SERVICE_GROUPING_OPTIONS.find((candidate) => candidate.id === props.mode)!;
  const disabled = props.disabled || !adjustable;
  return (
    <>
      <div style={SIZE_ROW_STYLE}>
        <label htmlFor={selectId} style={SIZE_LABEL_STYLE}>Target size</label>
        <select
          id={selectId}
          aria-label="Target services per cluster"
          aria-describedby={helpId}
          value={adjustable ? props.targetSize : "auto"}
          disabled={disabled}
          style={sizeSelectStyle(disabled)}
          onChange={(event) => {
            props.onChange(Number(event.currentTarget.value) as ServiceGroupingTargetSize);
          }}
        >
          {!adjustable ? <option value="auto">Automatic</option> : null}
          {SERVICE_GROUPING_TARGET_SIZES.map((size) => (
            <option key={size} value={size}>{size} services</option>
          ))}
        </select>
      </div>
      <span id={helpId} style={SIZE_HELP_STYLE}>
        {adjustable
          ? props.mode === "bunch"
            ? "Preferred services per visual parent; fine MQ communities stay intact while packing."
            : props.mode === "leiden"
              ? "Soft size target mapped to CPM resolution; communities can remain uneven."
            : "Preferred services per parent; balance bounds can vary slightly for feasibility."
          : `${option.label} infers cluster sizes from its objective.`}
      </span>
    </>
  );
}

export function ServiceGroupingInfoPanel(props: {
  mode: ServiceGroupingMode;
  id: string;
  headingId: string;
}) {
  const option = SERVICE_GROUPING_OPTIONS.find((candidate) => candidate.id === props.mode)!;
  const info = SERVICE_GROUPING_INFO[props.mode];
  return (
    <section
      id={props.id}
      role="region"
      aria-labelledby={props.headingId}
      style={INFO_PANEL_STYLE}
    >
      <div style={INFO_HEADER_STYLE}>
        <strong id={props.headingId} style={INFO_TITLE_STYLE}>{option.label}</strong>
        <span style={HEURISTIC_BADGE_STYLE}>{info.badge}</span>
      </div>
      <p style={INFO_SCOPE_STYLE}>{SHARED_INFO}</p>
      <p style={INFO_SUMMARY_STYLE}>{info.summary}</p>
      <dl style={INFO_LIST_STYLE}>
        <InfoItem term="Uses">{info.evidence}</InfoItem>
        <InfoItem term="Groups">{info.optimization}</InfoItem>
        <InfoItem term="Implementation">{info.implementation}</InfoItem>
        <InfoItem term="Watch for">{info.caveat}</InfoItem>
      </dl>
      <div style={SOURCE_LABEL_STYLE}>Sources</div>
      <ul style={SOURCE_LIST_STYLE}>
        {info.sources.map((source) => (
          <li key={source.href}>
            <a
              href={source.href}
              target="_blank"
              rel="noreferrer"
              style={SOURCE_LINK_STYLE}
            >
              <span>{source.label}</span>
              <ExternalLinkIcon size={11} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InfoItem(props: { term: string; children: React.ReactNode }) {
  return (
    <div style={INFO_ITEM_STYLE}>
      <dt style={INFO_TERM_STYLE}>{props.term}</dt>
      <dd style={INFO_DEFINITION_STYLE}>{props.children}</dd>
    </div>
  );
}

const WRAP_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  position: "relative",
};
const CONTROL_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "stretch", gap: 6 };
function selectStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "auto",
    flex: "1 1 auto",
    minWidth: 0,
    boxSizing: "border-box",
    border: `1px solid ${TOKENS.surfaceBorder}`,
    borderRadius: 8,
    background: TOKENS.surface,
    color: TOKENS.text,
    padding: "7px 9px",
    font: "inherit",
    fontSize: 12.5,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
  };
}
const HELP_STYLE: React.CSSProperties = {
  color: TOKENS.textDim,
  fontSize: 11,
  lineHeight: 1.35,
};
const SIZE_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginTop: 2,
};
const SIZE_LABEL_STYLE: React.CSSProperties = {
  color: TOKENS.textMuted,
  fontSize: 11.5,
  fontWeight: 600,
};
function sizeSelectStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 118,
    boxSizing: "border-box",
    border: `1px solid ${TOKENS.surfaceBorder}`,
    borderRadius: 7,
    background: TOKENS.surface,
    color: TOKENS.text,
    padding: "5px 7px",
    font: "inherit",
    fontSize: 11.5,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.62 : 1,
  };
}
const SIZE_HELP_STYLE: React.CSSProperties = {
  color: TOKENS.textDim,
  fontSize: 10.5,
  lineHeight: 1.35,
};

function infoButtonStyle(open: boolean): React.CSSProperties {
  return {
    width: 32,
    flex: "0 0 32px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${open ? "#4C78A8" : TOKENS.surfaceBorder}`,
    borderRadius: 8,
    background: open ? "rgba(76, 120, 168, 0.16)" : TOKENS.surface,
    color: open ? TOKENS.text : TOKENS.textMuted,
    cursor: "pointer",
  };
}

const INFO_PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  zIndex: 30,
  top: "calc(100% + 6px)",
  left: 0,
  width: "100%",
  boxSizing: "border-box",
  maxHeight: "min(520px, calc(100vh - 210px))",
  overflowY: "auto",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 10,
  background: "#0E1218",
  boxShadow: "0 14px 34px rgba(0, 0, 0, 0.48)",
  padding: 12,
  color: TOKENS.text,
};
const INFO_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const INFO_TITLE_STYLE: React.CSSProperties = { fontSize: 13, lineHeight: 1.2 };
const HEURISTIC_BADGE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid #344253",
  borderRadius: 999,
  padding: "2px 6px",
  color: "#9DB1C8",
  fontSize: 9.5,
  lineHeight: 1.2,
};
const INFO_SCOPE_STYLE: React.CSSProperties = {
  margin: "9px 0 0",
  color: TOKENS.textDim,
  fontSize: 10.5,
  lineHeight: 1.4,
};
const INFO_SUMMARY_STYLE: React.CSSProperties = {
  margin: "7px 0 10px",
  color: TOKENS.text,
  fontSize: 11.5,
  lineHeight: 1.45,
};
const INFO_LIST_STYLE: React.CSSProperties = { display: "grid", gap: 8, margin: 0 };
const INFO_ITEM_STYLE: React.CSSProperties = { display: "grid", gap: 2 };
const INFO_TERM_STYLE: React.CSSProperties = {
  color: TOKENS.label,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const INFO_DEFINITION_STYLE: React.CSSProperties = {
  margin: 0,
  color: TOKENS.textMuted,
  fontSize: 10.5,
  lineHeight: 1.42,
};
const SOURCE_LABEL_STYLE: React.CSSProperties = {
  marginTop: 12,
  paddingTop: 9,
  borderTop: `1px solid ${TOKENS.divider}`,
  color: TOKENS.label,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const SOURCE_LIST_STYLE: React.CSSProperties = {
  display: "grid",
  gap: 6,
  margin: "7px 0 0",
  padding: 0,
  listStyle: "none",
};
const SOURCE_LINK_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "flex-start",
  gap: 5,
  color: "#72A7DF",
  fontSize: 10.5,
  lineHeight: 1.35,
  textDecoration: "none",
};
