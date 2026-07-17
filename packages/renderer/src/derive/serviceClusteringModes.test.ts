import type { CouplingEdge, ServiceMemberFeature, UnitMetrics } from "@meridian/design-metrics";
import { describe, expect, it } from "vitest";
import {
  deriveServiceNodeGroups,
  SERVICE_GROUPING_OPTIONS,
} from "./serviceClusteringModes";
import type { ServiceClustering } from "./serviceComposition";

interface LeadFixture {
  id: string;
  name: string;
  path: string;
  methods?: Array<{ name: string; signature: string }>;
}

describe("deriveServiceNodeGroups", () => {
  it("orders all product modes by practical Service-lens relevance", () => {
    expect(SERVICE_GROUPING_OPTIONS).toEqual([
      { id: "domain", label: "Domain" },
      { id: "edge-cut", label: "Fewest links" },
      { id: "coupling-cut", label: "Least coupling" },
      { id: "leiden", label: "Leiden + CPM" },
      { id: "bunch", label: "Bunch MQ" },
      { id: "dependency", label: "Dependency" },
      { id: "api", label: "Similar API" },
      { id: "vocabulary", label: "Vocabulary" },
      { id: "folder", label: "Folder" },
    ]);
  });

  it("preserves the existing first-directory-below-root Folder partition", () => {
    const clustering = fixture([
      lead("analytics-a", "AnalyticsReportService", "src/aria/app/analytics/report.ts"),
      lead("backend-a", "BackendGatewayService", "src/aria/app/backend/gateway.ts"),
      lead("backend-b", "BackendSyncService", "src/aria/app/backend/sync.ts"),
      lead("components-a", "ConversationPanelService", "src/aria/app/components/panel.ts"),
    ]);

    expect(project(deriveServiceNodeGroups(clustering, "folder"))).toEqual([
      { label: "analytics", leadIds: ["analytics-a"] },
      { label: "backend", leadIds: ["backend-a", "backend-b"] },
      { label: "components", leadIds: ["components-a"] },
    ]);
  });

  it("finds disconnected dependency communities and covers every service exactly once", () => {
    const clustering = fixture(
      [
        lead("chat-a", "ConversationService", "src/a.ts"),
        lead("chat-b", "ChatHistoryService", "src/b.ts"),
        lead("chat-c", "MessageService", "src/c.ts"),
        lead("file-a", "FileSystemService", "src/d.ts"),
        lead("file-b", "PathService", "src/e.ts"),
        lead("file-c", "WorkspaceService", "src/f.ts"),
      ],
      [
        coupling("chat-a", "chat-b"), coupling("chat-b", "chat-c"), coupling("chat-c", "chat-a"),
        coupling("file-a", "file-b"), coupling("file-b", "file-c"), coupling("file-c", "file-a"),
      ],
    );

    const groups = deriveServiceNodeGroups(clustering, "dependency");
    expect(members(groups)).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
    expect(groups.flatMap((group) => group.leadIds).sort()).toEqual([
      "chat-a", "chat-b", "chat-c", "file-a", "file-b", "file-c",
    ]);
  });

  it("defaults to one semantic concept and opts into a stable two-part label", () => {
    const clustering = fixture(
      [
        lead("chat-reader", "ConversationMessageReader", "src/chat/reader.ts"),
        lead("chat-writer", "ConversationMessageWriter", "src/chat/writer.ts"),
        lead("chat-store", "ConversationMessageStore", "src/chat/store.ts"),
      ],
      [
        coupling("chat-reader", "chat-writer"),
        coupling("chat-writer", "chat-store"),
        coupling("chat-store", "chat-reader"),
      ],
    );

    const single = deriveServiceNodeGroups(clustering, "dependency");
    const pair = deriveServiceNodeGroups(clustering, "dependency", 12, "pair");

    expect(single).toHaveLength(1);
    expect(single[0]?.label).toBe("Conversation");
    expect(pair[0]?.label).toBe("Conversation / Message");
    expect(pair[0]?.id).toBe(single[0]?.id);
    expect(pair[0]?.leadIds).toEqual(single[0]?.leadIds);
  });

  it("does not spend both paired-label slots on singular and plural forms", () => {
    const clustering = fixture(
      [
        lead("skill-reader", "SkillSkillSkillsSkillsCatalogReader", "src/skills/reader.ts"),
        lead("skill-writer", "SkillSkillSkillsSkillsCatalogWriter", "src/skills/writer.ts"),
        lead("skill-store", "SkillSkillSkillsSkillsCatalogStore", "src/skills/store.ts"),
      ],
      [
        coupling("skill-reader", "skill-writer"),
        coupling("skill-writer", "skill-store"),
        coupling("skill-store", "skill-reader"),
      ],
    );

    const groups = deriveServiceNodeGroups(clustering, "dependency", 12, "pair");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Skill / Catalog");
  });

  it("uses the requested size for both balanced cut modes", () => {
    const leads = Array.from({ length: 12 }, (_, index) =>
      lead(`svc-${index}`, `Service${index}`, `src/services/${index}.ts`));
    const clustering = fixture(leads, Array.from({ length: 11 }, (_, index) =>
      coupling(`svc-${index}`, `svc-${index + 1}`)));

    for (const mode of ["edge-cut", "coupling-cut", "bunch"] as const) {
      const small = deriveServiceNodeGroups(clustering, mode, 3);
      const large = deriveServiceNodeGroups(clustering, mode, 6);
      expect(small).toHaveLength(4);
      expect(small.every((group) => group.leadIds.length >= 2 && group.leadIds.length <= 4)).toBe(true);
      expect(large).toHaveLength(2);
      expect(large.every((group) => group.leadIds.length >= 4 && group.leadIds.length <= 8)).toBe(true);
      expect(large.flatMap((group) => group.leadIds).sort()).toEqual(leads.map((item) => item.id).sort());
    }
  });

  it("keeps disconnected dependency regions separate with Leiden CPM and Bunch MQ", () => {
    const clustering = fixture(
      [
        lead("chat-a", "ConversationService", "src/chat/a.ts"),
        lead("chat-b", "ChatHistoryService", "src/chat/b.ts"),
        lead("chat-c", "MessageService", "src/chat/c.ts"),
        lead("file-a", "FileSystemService", "src/files/a.ts"),
        lead("file-b", "PathService", "src/files/b.ts"),
        lead("file-c", "WorkspaceService", "src/files/c.ts"),
      ],
      [
        coupling("chat-a", "chat-b"), coupling("chat-b", "chat-c"), coupling("chat-c", "chat-a"),
        coupling("file-a", "file-b"), coupling("file-b", "file-c"), coupling("file-c", "file-a"),
      ],
    );

    expect(members(deriveServiceNodeGroups(clustering, "leiden"))).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
    expect(members(deriveServiceNodeGroups(clustering, "bunch", 3))).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
  });

  it("clusters vocabulary across folders using names and method language", () => {
    const clustering = fixture([
      lead("chat-a", "ConversationHistoryService", "src/backend/history.ts", [
        { name: "loadConversation", signature: "loadConversation(id: string): Conversation" },
      ]),
      lead("chat-b", "ChatMessageStore", "src/components/message.ts", [
        { name: "saveConversationMessage", signature: "saveConversationMessage(message: ChatMessage): void" },
      ]),
      lead("chat-c", "ConversationTranscriptManager", "src/lib/transcript.ts", [
        { name: "conversationMessages", signature: "conversationMessages(): ChatMessage[]" },
      ]),
      lead("file-a", "FileSystemWatcherService", "src/backend/watcher.ts", [
        { name: "watchFilePath", signature: "watchFilePath(path: FilePath): void" },
      ]),
      lead("file-b", "WorkspaceFileStore", "src/components/file.ts", [
        { name: "readFilePath", signature: "readFilePath(path: FilePath): string" },
      ]),
      lead("file-c", "FilePathResolver", "src/lib/resolver.ts", [
        { name: "resolveFilePath", signature: "resolveFilePath(path: FilePath): FilePath" },
      ]),
    ]);

    expect(members(deriveServiceNodeGroups(clustering, "vocabulary"))).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
  });

  it("groups analogous APIs even when service and path vocabulary differ", () => {
    const clustering = fixture([
      lead("remote", "RemoteRunner", "src/backend/remote.ts", [
        { name: "open", signature: "open(endpoint: string, options?: ConnectOptions): Promise<void>" },
        { name: "close", signature: "close(): Promise<void>" },
      ]),
      lead("sandbox", "SandboxBridge", "src/tools/sandbox.ts", [
        { name: "open", signature: "open(host: string, config?: ConnectOptions): Promise<void>" },
        { name: "close", signature: "close(): Promise<void>" },
      ]),
      lead("vault", "CredentialVault", "src/auth/vault.ts", [
        { name: "read", signature: "read(key: string): Promise<string>" },
        { name: "write", signature: "write(key: string, value: string): Promise<void>" },
      ]),
      lead("cache", "ArtifactCache", "src/resources/cache.ts", [
        { name: "read", signature: "read(id: string): Promise<string>" },
        { name: "write", signature: "write(id: string, data: string): Promise<void>" },
      ]),
    ]);

    expect(members(deriveServiceNodeGroups(clustering, "api"))).toEqual([
      ["cache", "vault"],
      ["remote", "sandbox"],
    ]);
  });

  it("uses hybrid Domain evidence to overcome misleading folder placement", () => {
    const leads = [
      lead("chat-a", "ConversationHistoryService", "src/backend/history.ts"),
      lead("chat-b", "ConversationMessageService", "src/components/message.ts"),
      lead("chat-c", "ConversationTranscriptService", "src/lib/transcript.ts"),
      lead("file-a", "FileSystemWatcherService", "src/backend/watcher.ts"),
      lead("file-b", "WorkspaceFileService", "src/components/file.ts"),
      lead("file-c", "FilePathService", "src/lib/path.ts"),
    ];
    const clustering = fixture(leads, [
      coupling("chat-a", "chat-b", "calls", "instantiates"),
      coupling("chat-b", "chat-c", "calls", "instantiates"),
      coupling("chat-c", "chat-a", "calls"),
      coupling("file-a", "file-b", "calls", "instantiates"),
      coupling("file-b", "file-c", "calls", "instantiates"),
      coupling("file-c", "file-a", "calls"),
    ]);

    expect(members(deriveServiceNodeGroups(clustering, "domain"))).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
  });

  it("is deterministic under cluster, map, member, and coupling iteration reversal", () => {
    const leads = [
      lead("a", "ConversationService", "src/chat/a.ts", [
        { name: "sendMessage", signature: "sendMessage(message: ChatMessage): void" },
      ]),
      lead("b", "MessageHistory", "src/chat/b.ts", [
        { name: "readMessage", signature: "readMessage(id: string): ChatMessage" },
      ]),
      lead("c", "FileService", "src/files/c.ts", [
        { name: "readFile", signature: "readFile(path: string): string" },
      ]),
    ];
    const edges = [coupling("a", "b"), coupling("b", "a")];
    const forward = fixture(leads, edges);
    const reversed = reverseFixture(fixture([...leads].reverse(), [...edges].reverse()));
    const modes = SERVICE_GROUPING_OPTIONS.map((option) => option.id);

    for (const mode of modes) {
      expect(deriveServiceNodeGroups(forward, mode)).toEqual(deriveServiceNodeGroups(reversed, mode));
    }
  });

  it("returns no groups for an empty clustering", () => {
    const empty: ServiceClustering = {
      clusters: [], leadOf: new Map(), metrics: new Map(), membersByUnit: new Map(), couplings: [],
    };
    for (const { id } of SERVICE_GROUPING_OPTIONS) {
      expect(deriveServiceNodeGroups(empty, id)).toEqual([]);
    }
  });

  it("keeps services without API evidence separate instead of clustering boilerplate shapes", () => {
    const clustering = fixture([
      lead("a", "Alpha", "src/a.ts"),
      lead("b", "Beta", "src/b.ts"),
      lead("c", "Gamma", "src/c.ts"),
    ]);

    expect(members(deriveServiceNodeGroups(clustering, "api"))).toEqual([["a"], ["b"], ["c"]]);
  });
});

function fixture(leads: LeadFixture[], couplings: CouplingEdge[] = []): ServiceClustering {
  return {
    clusters: leads.map((item) => ({
      leadId: item.id,
      memberIds: [item.id],
      provenance: "named-service" as const,
    })),
    leadOf: new Map(leads.map((item) => [item.id, item.id])),
    metrics: new Map(leads.map((item) => [item.id, metric(item)])),
    membersByUnit: new Map(leads.map((item) => [item.id, methods(item)])),
    couplings,
  };
}

function reverseFixture(clustering: ServiceClustering): ServiceClustering {
  return {
    clusters: [...clustering.clusters].reverse(),
    leadOf: new Map([...clustering.leadOf].reverse()),
    metrics: new Map([...clustering.metrics].reverse()),
    membersByUnit: new Map([...clustering.membersByUnit].reverse().map(([id, nodes]) => [id, [...nodes].reverse()])),
    couplings: [...clustering.couplings].reverse(),
  };
}

function lead(
  id: string,
  name: string,
  path: string,
  methods: Array<{ name: string; signature: string }> = [],
): LeadFixture {
  return { id, name, path, methods };
}

function metric(item: LeadFixture): UnitMetrics {
  return {
    id: item.id,
    kind: "class",
    displayName: item.name,
    moduleFile: item.path,
    members: item.methods?.length ?? 0,
    cohesion: 1,
    lcomComponents: item.methods?.length ? 1 : 0,
    ce: 0,
    ca: 0,
    instability: 0,
    abstractness: 0,
    distance: 1,
    externalFanout: 0,
    smells: [],
  };
}

function methods(item: LeadFixture): ServiceMemberFeature[] {
  return (item.methods ?? []).map((method, index) => ({
    id: `${item.id}#${method.name}-${index}`,
    kind: "method",
    qualifiedName: `${item.name}.${method.name}`,
    displayName: method.name,
    signature: method.signature,
  }));
}

function coupling(source: string, target: string, ...kinds: string[]): CouplingEdge {
  const edgeKinds = kinds.length > 0 ? kinds : ["calls"];
  return {
    source,
    target,
    kinds: new Set(edgeKinds),
    inheritanceOnly: edgeKinds.every((kind) => kind === "extends" || kind === "implements"),
  };
}

function project(groups: ReturnType<typeof deriveServiceNodeGroups>): Array<{ label: string; leadIds: string[] }> {
  return groups.map(({ label, leadIds }) => ({ label, leadIds }));
}

function members(groups: ReturnType<typeof deriveServiceNodeGroups>): string[][] {
  return groups.map((group) => group.leadIds).sort((a, b) => a[0].localeCompare(b[0]));
}
