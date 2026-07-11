import type { UnitMetrics } from "@meridian/design-metrics";
import { describe, expect, it } from "vitest";
import { SERVICE_GROUPING_OPTIONS } from "./serviceClusteringModes";
import type { ServiceClustering } from "./serviceComposition";
import { deriveServiceDomains, serviceDomainLabel, UNASSIGNED_SERVICE_DOMAIN_ID } from "./serviceDomains";

describe("deriveServiceDomains", () => {
  it("keeps every service in exactly one artificial parent for every mode", () => {
    const clustering = fixture();
    const expected = clustering.clusters.map((cluster) => cluster.leadId).sort();

    for (const option of SERVICE_GROUPING_OPTIONS) {
      const model = deriveServiceDomains(clustering, option.id);
      expect(model.domains.flatMap((domain) => domain.leadIds).sort()).toEqual(expected);
      expect(new Set(model.domains.map((domain) => domain.id)).size).toBe(model.domains.length);
      expect(model.domains.every((domain) => option.id === "folder"
        ? serviceDomainLabel(domain.id) === domain.label
        : serviceDomainLabel(domain.id) === null)).toBe(true);
    }
  });

  it("preserves the original path-based ids in Folder mode", () => {
    const domains = deriveServiceDomains(fixture(), "folder").domains;
    expect(domains.map((domain) => domain.id)).toEqual([
      "service-domain:src%2Fchat",
      "service-domain:src%2Ffiles",
    ]);
  });

  it("folds similarity isolates into one honest catch-all parent", () => {
    const clustering = fixture(false);
    const api = deriveServiceDomains(clustering, "api").domains;
    expect(api).toHaveLength(1);
    expect(api[0].label).toBe("Other API shapes");
    expect(api[0].leadIds).toEqual(["chat-a", "chat-b", "file-a", "file-b"]);
  });

  it("keeps semantic ids independent of generated label wording", () => {
    const domains = deriveServiceDomains(fixture(), "domain").domains;
    expect(domains.every((domain) => /^service-domain:domain:[0-9a-f]{8}$/.test(domain.id))).toBe(true);
  });

  it("caches the full-system model by clustering object, mode, and balanced target size", () => {
    const clustering = fixture();
    expect(deriveServiceDomains(clustering, "domain")).toBe(deriveServiceDomains(clustering, "domain"));
    expect(deriveServiceDomains(clustering, "domain")).not.toBe(deriveServiceDomains(clustering, "folder"));
    expect(deriveServiceDomains(clustering, "edge-cut", 6)).toBe(deriveServiceDomains(clustering, "edge-cut", 6));
    expect(deriveServiceDomains(clustering, "edge-cut", 6)).not.toBe(deriveServiceDomains(clustering, "edge-cut", 12));
  });

  it("keeps unreachable folder fallbacks behind one honest Unassigned parent", () => {
    const clustering = fixture();
    const fallback = "src/ui/ActionChipView.tsx";
    clustering.clusters.push({ leadId: fallback, memberIds: [fallback, `${fallback}#Props`], provenance: "unassigned" });
    clustering.leadOf.set(fallback, fallback);
    clustering.leadOf.set(`${fallback}#Props`, fallback);
    clustering.metrics.set(fallback, metric(fallback, "ActionChipView.tsx", fallback));
    clustering.metrics.set(`${fallback}#Props`, metric(`${fallback}#Props`, "Props", fallback));

    for (const option of SERVICE_GROUPING_OPTIONS) {
      const model = deriveServiceDomains(clustering, option.id);
      const unassigned = model.domainById.get(UNASSIGNED_SERVICE_DOMAIN_ID);
      expect(unassigned).toMatchObject({
        label: "Unassigned code",
        kind: "unassigned",
        leadIds: [fallback],
      });
      expect(model.domains.filter((domain) => domain.kind === "services").flatMap((domain) => domain.leadIds))
        .not.toContain(fallback);
    }
  });
});

function fixture(withCouplings = true): ServiceClustering {
  const leads = [
    ["chat-a", "ConversationService", "src/chat/conversation.ts"],
    ["chat-b", "MessageHistoryService", "src/chat/history.ts"],
    ["file-a", "FileWatcherService", "src/files/watcher.ts"],
    ["file-b", "PathResolverService", "src/files/path.ts"],
  ] as const;
  const couplings = withCouplings
    ? [
        { source: "chat-a", target: "chat-b", kinds: new Set(["calls"]), inheritanceOnly: false },
        { source: "file-a", target: "file-b", kinds: new Set(["calls"]), inheritanceOnly: false },
      ]
    : [];
  return {
    clusters: leads.map(([id]) => ({ leadId: id, memberIds: [id] })),
    leadOf: new Map(leads.map(([id]) => [id, id])),
    metrics: new Map(leads.map(([id, name, path]) => [id, metric(id, name, path)])),
    membersByUnit: new Map(leads.map(([id]) => [id, []])),
    couplings,
  };
}

function metric(id: string, displayName: string, moduleFile: string): UnitMetrics {
  return {
    id,
    kind: "class",
    displayName,
    moduleFile,
    members: 0,
    cohesion: 0,
    lcomComponents: 0,
    ce: 0,
    ca: 0,
    instability: 0,
    abstractness: 0,
    distance: 1,
    externalFanout: 0,
    smells: [],
  };
}
