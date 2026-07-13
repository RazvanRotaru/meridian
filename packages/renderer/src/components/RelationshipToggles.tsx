/**
 * Lens-aware relationship filters, grouped by semantic family. Exact kinds stay flat/stable in the
 * artifact; the family hierarchy is presentation and policy, so a lens can tell a different story
 * without inventing new graph machinery.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { relationshipKindGroupsForPolicy } from "../theme/relationshipKinds";
import { Pill } from "./controlpanel/panelKit";
import { activeModuleSurfaceSpec } from "./canvas/surfaceSpec";
import { isRelationShown } from "../graph/relationVisibility";

export function RelationshipToggles({ kinds }: { kinds?: readonly string[] } = {}) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const overrides = useBlueprint((state) => state.relationVisibilityOverrides);
  const { toggleRelKind, resetRelationshipDefaults } = useBlueprintActions();
  const policy = activeModuleSurfaceSpec(viewMode).relations;
  const allowedKinds = kinds === undefined ? null : new Set(kinds);
  const groups = relationshipKindGroupsForPolicy(policy).flatMap((group) => {
    const visibleKinds = allowedKinds === null
      ? group.kinds
      : group.kinds.filter((kind) => allowedKinds.has(kind.key));
    return visibleKinds.length > 0 ? [{ ...group, kinds: visibleKinds }] : [];
  });
  const hasOverrides = Object.keys(overrides[policy.id] ?? {}).length > 0;

  return (
    <div style={GROUPS_STYLE} role="group" aria-label={`${policy.id} relationship kinds`}>
      {groups.map((group) => (
        <div key={group.family} style={GROUP_STYLE}>
          <div style={FAMILY_STYLE}>{group.label}</div>
          <div style={ROW_STYLE}>
            {group.kinds.map(({ key, label, color }) => {
              const shown = isRelationShown(policy, overrides, key);
              return (
                <Pill
                  key={key}
                  active={shown}
                  accent={color}
                  title={shown ? `Hide ${label}` : `Show ${label}`}
                  onClick={() => toggleRelKind(key)}
                >
                  {label}
                </Pill>
              );
            })}
          </div>
        </div>
      ))}
      <button
        type="button"
        style={{ ...DEFAULTS_STYLE, opacity: hasOverrides ? 1 : 0.45, cursor: hasOverrides ? "pointer" : "default" }}
        disabled={!hasOverrides}
        title={`Restore ${policy.id} lens relationship defaults`}
        onClick={resetRelationshipDefaults}
      >
        Restore lens defaults
      </button>
    </div>
  );
}

const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
const GROUPS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const GROUP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const FAMILY_STYLE: React.CSSProperties = {
  color: "#687382",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};
const DEFAULTS_STYLE: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#7B8695",
  font: "inherit",
  fontSize: 10,
};
