/** A centered full-screen message for the loading and boot-error states. */

export function BootSplash(props: { message: string; tone?: "info" | "error" }) {
  const color = props.tone === "error" ? "#E5534B" : "#9AA4B2";
  return (
    <div style={WRAP_STYLE}>
      <div style={{ ...MESSAGE_STYLE, color }}>{props.message}</div>
    </div>
  );
}

const WRAP_STYLE: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0E1116",
};
const MESSAGE_STYLE: React.CSSProperties = { fontSize: 14, maxWidth: 520, textAlign: "center", padding: 24 };
