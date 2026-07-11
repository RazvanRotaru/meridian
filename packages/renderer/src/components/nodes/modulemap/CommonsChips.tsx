/**
 * The chip row a card wears INSTEAD of its wires to demoted COMMONS hubs (commonsDemotion.ts):
 * "uses the logger" is one quiet glance on the card, not one more strand in the field. Shared by
 * file cards and package/directory cards — any dependent of a docked commons. Capped so a heavy
 * user stays tidy; the full list rides the hover title.
 */

export function CommonsChips({ chips }: { chips: string[] | undefined }) {
  if (!chips || chips.length === 0) {
    return null;
  }
  const shown = chips.slice(0, 3);
  const more = chips.length - shown.length;
  return (
    <span className="lod-hide" style={ROW} title={`Uses commons: ${chips.join(", ")}`}>
      {shown.map((chip) => (
        <span key={chip} style={CHIP}>
          {chip}
        </span>
      ))}
      {more > 0 ? <span style={MORE}>+{more}</span> : null}
    </span>
  );
}

const ROW: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden" };
const CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  color: "#8B95A3",
  border: "1px solid #2A313C",
  background: "#161C24",
  borderRadius: 3,
  padding: "1px 4px",
};
const MORE: React.CSSProperties = { fontSize: 8, color: "#565E68" };
