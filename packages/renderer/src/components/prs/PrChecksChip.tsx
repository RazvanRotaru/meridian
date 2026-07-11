import type { CSSProperties } from "react";
import type { PrChecks } from "../../state/prTypes";

export function PrChecksChip(props: { checks: PrChecks | null; compact?: boolean }) {
  if (props.checks === null) {
    return null;
  }
  const presentation = checksPresentation(props.checks);
  const style = {
    ...CHIP_STYLE,
    ...(props.compact ? COMPACT_STYLE : {}),
    color: presentation.color,
    borderColor: presentation.border,
    background: presentation.background,
  };
  if (props.checks.failed > 0 && props.checks.url !== null) {
    return (
      <a style={{ ...style, textDecoration: "none" }} href={props.checks.url} target="_blank" rel="noreferrer" title="Open the first failed check on GitHub">
        {presentation.label}
      </a>
    );
  }
  return <span style={style}>{presentation.label}</span>;
}

function checksPresentation(checks: PrChecks): { label: string; color: string; border: string; background: string } {
  if (checks.failed > 0) {
    return {
      label: `checks failing ${checks.failed}/${checks.total}`,
      color: "#FCA5A5",
      border: "#7F1D1D",
      background: "#1A0E12",
    };
  }
  if (checks.pending > 0) {
    return {
      label: "checks running…",
      color: "#FBBF24",
      border: "#92400E",
      background: "#1C1409",
    };
  }
  return {
    label: `checks ${checks.passed}/${checks.total}`,
    color: "#86EFAC",
    border: "#166534",
    background: "#0B1F13",
  };
}

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
  border: "1px solid",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 650,
  lineHeight: "16px",
  whiteSpace: "nowrap",
};

const COMPACT_STYLE: CSSProperties = { padding: "1px 6px", fontSize: 9.5, lineHeight: "14px" };
