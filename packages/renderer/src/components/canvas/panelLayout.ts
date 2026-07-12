/** Shared dimensions for independent React Flow panels that can coexist in the top-right anchor. */
export const COVERAGE_PANEL_WIDTH = 340;
export const TOP_RIGHT_PANEL_GAP = 12;

export function requestPanelRightOffset(coveragePanelOpen: boolean): number | undefined {
  return coveragePanelOpen ? COVERAGE_PANEL_WIDTH + TOP_RIGHT_PANEL_GAP : undefined;
}
