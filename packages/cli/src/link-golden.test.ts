/**
 * Golden: the full IPC story over real fixtures. `generate` on desktop-notes materializes its
 * intra-repo electron channels; `link` on checkout-web + orders-api joins two artifacts through
 * shared HTTP channels (concrete paths unified onto route templates), keeping the dangling ends.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PORTS_EXTENSION, linkArtifacts, validateArtifact } from "@meridian/core";
import type { GraphArtifact, Port } from "@meridian/core";
import { extractToArtifact } from "./extract-pipeline";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function generateFixture(fixture: string): Promise<GraphArtifact> {
  const root = join(REPO, "examples", fixture);
  const result = await extractToArtifact({
    absoluteRoot: root,
    cwd: REPO,
    project: join(root, "tsconfig.json"),
    materializeBoundary: true,
  });
  return result.artifact;
}

function sourceOf(artifact: GraphArtifact) {
  return {
    name: artifact.target.name,
    nodes: artifact.nodes,
    edges: artifact.edges,
    ports: ((artifact.extensions?.[PORTS_EXTENSION] as unknown) ?? []) as Port[],
  };
}

describe("generate over desktop-notes (intra-repo electron channels)", () => {
  it("materializes matched channels with sends and handles edges, and keeps the dangling ones", async () => {
    const artifact = await generateFixture("desktop-notes");
    const channels = artifact.nodes.filter((node) => node.kind === "channel");
    const names = channels.map((node) => node.displayName).sort();
    expect(names).toEqual(["notes:changed", "notes:delete", "notes:export", "notes:load", "notes:save"]);
    const loadId = channels.find((node) => node.displayName === "notes:load")!.id;
    expect(artifact.edges.some((edge) => edge.kind === "sends" && edge.target === loadId)).toBe(true);
    expect(artifact.edges.some((edge) => edge.kind === "handles" && edge.source === loadId)).toBe(true);
    // notes:export has a handler and no sender — the dangling edge set is honest.
    const exportId = channels.find((node) => node.displayName === "notes:export")!.id;
    expect(artifact.edges.some((edge) => edge.kind === "sends" && edge.target === exportId)).toBe(false);
    expect(artifact.edges.some((edge) => edge.kind === "handles" && edge.source === exportId)).toBe(true);
  });
});

describe("link over checkout-web + orders-api (cross-repo http)", () => {
  it("joins the two systems through template-unified channels and validates clean", async () => {
    const web = await generateFixture("checkout-web");
    const api = await generateFixture("orders-api");
    const linked = linkArtifacts([sourceOf(web), sourceOf(api)]);

    expect(linked.stats.systems).toBe(2);
    expect(linked.stats.httpTemplateJoins).toBe(1); // /api/orders/123 → /api/orders/:id
    // GET+POST /api/orders and GET /api/orders/:id join; recommendations + DELETE dangle.
    expect(linked.stats.crossSystemChannels).toBe(3);
    expect(linked.stats.danglingChannels).toBe(2);

    const byName = new Map(linked.nodes.filter((n) => n.kind === "channel").map((n) => [n.displayName, n.id]));
    const templated = byName.get("GET /api/orders/:id")!;
    expect(linked.edges.some((e) => e.kind === "sends" && e.target === templated && e.source.startsWith("ts:checkout-web/"))).toBe(true);
    expect(linked.edges.some((e) => e.kind === "handles" && e.source === templated && e.target.startsWith("ts:orders-api/"))).toBe(true);

    // The merged system graph must round-trip strict validation (systems, channels, namespacing).
    const artifact: GraphArtifact = {
      ...web,
      target: { name: "system", root: ".", language: "mixed" },
      nodes: linked.nodes,
      edges: linked.edges,
      extensions: { [PORTS_EXTENSION]: linked.ports as never },
    };
    const validation = validateArtifact(artifact);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
