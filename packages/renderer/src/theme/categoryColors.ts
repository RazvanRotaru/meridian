/**
 * The Module-map CATEGORY palette — one hue per toggleable file role, shared by the control-panel
 * category pills so the filter reads the same colour the map card's chip wears. Reuses the structural
 * kind hues (package blue, module teal); config takes its own violet so it never collides with the
 * diff amber (reserved) or the warm wire hues.
 */

import type { ModuleCategory } from "../derive/moduleCategory";

export const CATEGORY_COLORS: Record<ModuleCategory, string> = {
  entry: "#56C271", // the blast-radius root — green, matching the ENTRY badge
  ui: "#5B9BE3", // blue — presentation code
  util: "#3FB7C4", // teal — shared helpers/utilities
  config: "#9B7BE0", // violet — configuration/constants/types (the config KIND glyph keeps its amber)
  app: "#7A8290", // neutral — ordinary domain code
};

export function categoryColor(category: ModuleCategory): string {
  return CATEGORY_COLORS[category];
}
