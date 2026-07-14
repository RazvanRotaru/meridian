import type { ObservedRequestRoute, ObservedRouteObservation, ObservedRouteRelation } from "../../derive/requestObservedRoute";

export function ObservedRouteStrip({
  route,
  labelForNode,
}: {
  route: ObservedRequestRoute;
  labelForNode?: (nodeId: string) => string | undefined;
}) {
  if (route.runs.length === 0) return null;
  const accessibleRoute = route.runs.map((run, index) => {
    const label = routeRunLabel(run.nodeId, run.spanName, labelForNode);
    const observations = run.observations.map(observationText).join(", ");
    return `${index === 0 ? "" : connectorText(run.relation)}${label}${observations ? `: ${observations}` : ""}`;
  }).join(" ");

  return (
    <section style={STRIP} aria-label={`Observed request route${route.complete ? "" : ", partial capture"}: ${accessibleRoute}`}>
      <div style={LABEL_BLOCK}>
        <span style={LABEL}>OBSERVED ROUTE</span>
        {route.complete ? null : <span style={PARTIAL}>PARTIAL</span>}
      </div>
      <ol style={TRACK} className="mrd-scroll" aria-label="Observed request route" tabIndex={0}>
        {route.runs.map((run, index) => {
          const label = routeRunLabel(run.nodeId, run.spanName, labelForNode);
          const title = [label, ...run.observations.map((observation) => observation.detail)].join("\n");
          return (
            <li key={run.key} style={ITEM}>
              {index === 0 ? null : <span style={connectorStyle(run.relation)} aria-hidden="true">{connectorGlyph(run.relation)}</span>}
              <span style={RUN} title={title}>
                <strong style={RUN_LABEL}>{label}</strong>
                {run.observations.map((observation) => (
                  <span key={observation.key} style={observationStyle(observation)}>
                    <span style={OUTCOME}>{observation.outcome}</span>
                    {observation.evidence === null ? null : <span style={EVIDENCE}>{observation.evidence}</span>}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function routeRunLabel(
  nodeId: string | null,
  spanName: string,
  labelForNode: ((nodeId: string) => string | undefined) | undefined,
): string {
  if (nodeId !== null) {
    const resolved = labelForNode?.(nodeId);
    if (resolved) return resolved;
  }
  const separator = spanName.lastIndexOf(".");
  return separator < 0 ? spanName : spanName.slice(separator + 1);
}

function observationText(observation: ObservedRouteObservation): string {
  return `${observation.outcome}${observation.evidence === null ? "" : ` (${observation.evidence})`}`;
}

function connectorText(relation: ObservedRouteRelation): string {
  if (relation === "catch") return "caught by ";
  if (relation === "resume") return "resumes ";
  if (relation === "separate") return "then separately ";
  return "then ";
}

function connectorGlyph(relation: ObservedRouteRelation): string {
  if (relation === "catch" || relation === "resume") return "↪";
  if (relation === "separate") return "·";
  return "›";
}

function connectorStyle(relation: ObservedRouteRelation): React.CSSProperties {
  return {
    color: relation === "catch" ? "#E89374" : relation === "resume" ? "#D6B66B" : "#566577",
    fontSize: relation === "catch" || relation === "resume" ? 14 : 11,
    lineHeight: 1,
  };
}

function observationStyle(observation: ObservedRouteObservation): React.CSSProperties {
  const color = observation.tone === "error"
    ? "#F0787C"
    : observation.tone === "caught"
      ? "#E9A06D"
      : observation.tone === "loop"
        ? "#61C4D8"
        : "#D9B85C";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    paddingLeft: 6,
    borderLeft: `1px solid ${color}66`,
    color,
  };
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const STRIP: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  fontFamily: MONO,
};
const LABEL_BLOCK: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 };
const LABEL: React.CSSProperties = { color: "#58C9A3", fontSize: 8.5, fontWeight: 750, letterSpacing: "0.09em" };
const PARTIAL: React.CSSProperties = { color: "#D6B66B", fontSize: 7.5, fontWeight: 750, letterSpacing: "0.07em" };
const TRACK: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
  maxWidth: "100%",
  overflowX: "auto",
  overscrollBehaviorX: "contain",
  whiteSpace: "nowrap",
  scrollbarWidth: "thin",
  listStyle: "none",
  margin: 0,
  padding: "0 0 2px",
};
const ITEM: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 };
const RUN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  minWidth: 0,
  padding: "3px 7px",
  border: "1px solid #2A3742",
  borderRadius: 5,
  background: "#090D12",
  color: "#B7C2CF",
  fontSize: 9,
};
const RUN_LABEL: React.CSSProperties = { color: "#DCE4EC", fontSize: 9.5, fontWeight: 700 };
const OUTCOME: React.CSSProperties = { fontWeight: 750, textTransform: "uppercase" };
const EVIDENCE: React.CSSProperties = { maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", color: "#8D99A7" };
