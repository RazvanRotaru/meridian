export type ModuleGrouping = "packages" | "applications";

export const MODULE_GROUPINGS: readonly ModuleGrouping[] = ["packages", "applications"];

export const MODULE_GROUPING_LABEL: Record<ModuleGrouping, string> = {
  packages: "Packages",
  applications: "Applications",
};
