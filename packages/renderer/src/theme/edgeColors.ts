/**
 * Wire styling, in one place so the edge component and the markers built at layout time agree.
 *
 * Every edge kind gets its own line language — colour AND dash pattern — so a reader can tell
 * a call from an instantiation from an inheritance link without a legend lookup: calls are
 * neutral steel solids, `instantiates` borrows the class amber as fine dots, `extends` /
 * `implements` borrow the interface purple as long dashes, `references` is a dim short dash,
 * and React `renders` wires keep their distinct cyan.
 *
 * When a path highlight is active, direction takes over the colour story: wires flowing OUT
 * of the selected node are teal, wires flowing IN are violet — the dash pattern still tells
 * the kind.
 */

export interface WireStyle {
  color: string;
  dash?: string;
}

const WIRE_STYLES: Record<string, WireStyle> = {
  calls: { color: "#8A94A6" },
  renders: { color: "#61DAFB" },
  instantiates: { color: "#E0A33E", dash: "2 5" },
  extends: { color: "#C57BD6", dash: "11 5" },
  implements: { color: "#C57BD6", dash: "7 5" },
  references: { color: "#6E7681", dash: "4 4" },
};

const DEFAULT_WIRE: WireStyle = { color: "#7C8696" };

/** Downstream of the selection: what the selected node reaches. */
export const PATH_DOWNSTREAM = "#4EE1C4";
/** Upstream of the selection: what reaches the selected node. */
export const PATH_UPSTREAM = "#A78BFA";
/** A wire whose BOTH endpoints the change lens marked — the seam the range flowed through. */
export const HOT_WIRE = "#E5534B";

export function wireStyleForKind(kind: string): WireStyle {
  return WIRE_STYLES[kind] ?? DEFAULT_WIRE;
}

export function wireColorForKind(kind: string): string {
  return wireStyleForKind(kind).color;
}
