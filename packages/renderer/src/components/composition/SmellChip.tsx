/**
 * A design-smell pill — the chip drawn on the refactor-candidates worklist. Short glanceable label,
 * red for the structural hazards (HUB/PAIN), amber for the softer split/unused hints; the full
 * smell name rides the hover title.
 */

import type { Smell } from "@meridian/design-metrics";

export function SmellChip(props: { smell: Smell }) {
  return (
    <span style={SMELL_TONE[props.smell] === "red" ? CHIP_RED : CHIP_AMBER} title={props.smell}>
      {SMELL_LABEL[props.smell]}
    </span>
  );
}

const SMELL_LABEL: Record<Smell, string> = {
  "god-module": "HUB",
  "zone-of-pain": "PAIN",
  "zone-of-uselessness": "UNUSED",
  "low-cohesion": "SPLIT",
};
const SMELL_TONE: Record<Smell, "red" | "amber"> = {
  "god-module": "red",
  "zone-of-pain": "red",
  "zone-of-uselessness": "amber",
  "low-cohesion": "amber",
};

const CHIP_BASE: React.CSSProperties = {
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  borderRadius: 3,
  padding: "1px 5px",
  border: "1px solid",
};
const CHIP_RED: React.CSSProperties = { ...CHIP_BASE, color: "#F0787C", borderColor: "#5B2B2F", background: "rgba(229,72,77,0.14)" };
const CHIP_AMBER: React.CSSProperties = { ...CHIP_BASE, color: "#E6B84D", borderColor: "#5A4A24", background: "rgba(230,184,77,0.14)" };
