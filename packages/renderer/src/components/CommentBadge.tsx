/** The 💬 count chip a node header wears when open comments sit at-or-below it. */

export function CommentBadge(props: { count: number }) {
  return (
    <span style={BADGE_STYLE} title={`${props.count} open comment${props.count === 1 ? "" : "s"}`}>
      💬 {props.count}
    </span>
  );
}

const BADGE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "14px",
  padding: "0 6px",
  borderRadius: 8,
  border: "1px solid #4C3FA855",
  background: "rgba(28,24,48,0.85)",
  color: "#A78BFA",
  flex: "0 0 auto",
  fontVariantNumeric: "tabular-nums",
};
