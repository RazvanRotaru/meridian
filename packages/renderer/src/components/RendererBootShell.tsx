/**
 * The first committed renderer frame. It mirrors the real toolbar/canvas geometry while the first
 * bounded projection is hydrating, so boot never falls back to a detached centered splash.
 */
export function RendererBootShell() {
  return (
    <main style={SHELL} data-testid="renderer-boot-shell" aria-busy="true" aria-label="Loading blueprint">
      <aside style={RAIL} aria-hidden="true">
        <div style={BRAND}>M</div>
        {Array.from({ length: 5 }, (_value, index) => <div key={index} style={RAIL_BUTTON} />)}
      </aside>
      <section style={WORKSPACE}>
        <header style={TOOLBAR}>
          <div style={TITLE_GROUP}>
            <div style={{ ...BAR, width: 112 }} />
            <div style={{ ...BAR, width: 64, opacity: 0.55 }} />
          </div>
          <div style={TOOLBAR_ACTIONS}>
            <div style={{ ...PILL, width: 74 }} />
            <div style={{ ...PILL, width: 92 }} />
            <div style={{ ...PILL, width: 34 }} />
          </div>
        </header>
        <div style={CANVAS} role="status" aria-live="polite">
          <div style={{ ...NODE, left: "12%", top: "19%", width: 230, height: 116 }} />
          <div style={{ ...NODE, left: "41%", top: "36%", width: 260, height: 132 }} />
          <div style={{ ...NODE, right: "10%", top: "18%", width: 210, height: 104 }} />
          <div style={{ ...NODE, left: "20%", bottom: "13%", width: 250, height: 94 }} />
          <div style={STATUS_CARD}>
            <span style={SPINNER} aria-hidden="true" />
            <span>Loading the first bounded graph view…</span>
          </div>
        </div>
      </section>
    </main>
  );
}

const SHELL: React.CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  display: "flex",
  overflow: "hidden",
  color: "#E6EDF3",
  background: "#080B10",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
};
const RAIL: React.CSSProperties = {
  width: 58,
  flex: "0 0 58px",
  borderRight: "1px solid #202630",
  background: "#0D1117",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 13,
  padding: "13px 0",
};
const BRAND: React.CSSProperties = {
  width: 32,
  height: 32,
  display: "grid",
  placeItems: "center",
  borderRadius: 9,
  background: "linear-gradient(145deg, #F59E0B, #EA580C)",
  color: "#111827",
  fontWeight: 900,
  marginBottom: 7,
};
const RAIL_BUTTON: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: "1px solid #2B3440",
  background: "#151B23",
};
const WORKSPACE: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" };
const TOOLBAR: React.CSSProperties = {
  height: 54,
  flex: "0 0 54px",
  borderBottom: "1px solid #202630",
  background: "rgba(13,17,23,0.96)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 18px",
};
const TITLE_GROUP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const TOOLBAR_ACTIONS: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const BAR: React.CSSProperties = { height: 10, borderRadius: 999, background: "#303946" };
const PILL: React.CSSProperties = { height: 28, borderRadius: 8, border: "1px solid #2B3440", background: "#151B23" };
const CANVAS: React.CSSProperties = {
  position: "relative",
  flex: 1,
  overflow: "hidden",
  backgroundColor: "#090D12",
  backgroundImage: "radial-gradient(circle, #2B3440 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};
const NODE: React.CSSProperties = {
  position: "absolute",
  border: "1px solid #293442",
  borderRadius: 12,
  background: "linear-gradient(180deg, #151B23, #10151C)",
  boxShadow: "0 14px 34px rgba(0,0,0,0.24)",
  opacity: 0.72,
};
const STATUS_CARD: React.CSSProperties = {
  position: "absolute",
  left: 18,
  bottom: 18,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 13px",
  border: "1px solid #334155",
  borderRadius: 10,
  background: "rgba(15,23,32,0.94)",
  color: "#CBD5E1",
  fontSize: 12,
  fontWeight: 600,
};
const SPINNER: React.CSSProperties = {
  width: 12,
  height: 12,
  border: "2px solid #475569",
  borderTopColor: "#F59E0B",
  borderRadius: "50%",
};
