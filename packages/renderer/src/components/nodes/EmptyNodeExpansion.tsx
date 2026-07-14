/**
 * One honest expanded state for any expandable entity whose extractor produced no drawable detail.
 *
 * Source-only files, memberless units, empty structural bodies, and empty/computation/return-only
 * callables are all useful navigation targets, but none has a nested graph to lay out. Keeping this
 * state shared lets every surface retain the same expandable node without inventing a fake child
 * edge or showing a disclosure that appears to do nothing.
 */

export function EmptyNodeExpansion({
  message = "No charted calls or control flow",
}: {
  message?: string;
}) {
  return (
    <div style={EMPTY_STATE} data-node-empty-expansion="true" role="note">
      <span style={EMPTY_MARK} aria-hidden="true">•</span>
      <span>{message}</span>
    </div>
  );
}

const EMPTY_STATE: React.CSSProperties = {
  minHeight: 42,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: "10px 14px",
  color: "#8390A0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 9.5,
  fontStyle: "italic",
  lineHeight: 1.35,
  textAlign: "center",
};

const EMPTY_MARK: React.CSSProperties = {
  flexShrink: 0,
  color: "#657282",
  fontSize: 13,
  fontStyle: "normal",
};
