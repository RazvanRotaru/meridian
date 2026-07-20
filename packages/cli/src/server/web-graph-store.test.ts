import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import {
  artifactSummary,
  materializeValidatedArtifact,
  verifiedArtifactFile,
  WebGraphStore,
  type WebGraphRegistration,
} from "./web-graph-store";

const NODE_ID = "ts:src/order.ts#placeOrder";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-20T00:00:00.000Z",
  generator: { name: "meridian-test", version: "1" },
  target: { name: "shop", root: ".", language: "typescript" },
  nodes: [{
    id: NODE_ID,
    kind: "function",
    qualifiedName: "placeOrder",
    displayName: "placeOrder",
    location: { file: "src/order.ts", startLine: 1, endLine: 3 },
  }],
  edges: [],
};

const stores: WebGraphStore[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WebGraphStore", () => {
  it("hashes untrusted ids instead of using them as filesystem paths", () => {
    const store = createStore();
    const id = "../../outside/graph?x=1";
    store.publish(registration(id));

    const path = store.artifactPath(id);
    expect(path).toBeDefined();
    expect(relative(store.rootPath, path!)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(dirname(path!)).not.toContain("outside");
    expect(readdirSync(store.rootPath)).toHaveLength(1);
    expect(store.has("")).toBe(false);
    expect(store.has("../../outside/other")).toBe(false);
  });

  it("persists only a bounded descriptor beside the artifact", () => {
    const store = createStore();
    const descriptor = store.publish(registration("graph-1"));
    const path = store.artifactPath("graph-1")!;
    const raw = JSON.parse(readFileSync(join(dirname(path), "descriptor.json"), "utf8")) as Record<string, unknown>;

    expect(descriptor).toEqual({
      formatVersion: 1,
      id: "graph-1",
      byteDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary: {
        schemaVersion: ARTIFACT.schemaVersion,
        generatedAt: ARTIFACT.generatedAt,
        nodeCount: 1,
        edgeCount: 0,
      },
      sourceRoot: "/workspace/shop",
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    });
    expect(raw).toEqual(descriptor);
    expect(raw).not.toHaveProperty("artifact");
    expect(raw).not.toHaveProperty("nodes");
    expect(JSON.stringify(raw)).not.toContain(NODE_ID);
  });

  it("accepts an exact republish and rejects every conflicting immutable coordinate", () => {
    const store = createStore();
    const first = store.publish(registration("graph-1"));
    const second = store.publish(registration("graph-1"));

    expect(second).toEqual(first);
    expect(readdirSync(store.rootPath)).toHaveLength(1);
    expect(() => store.publish(registration("graph-1", {
      metadata: {
        sourceRoot: "/workspace/other",
        source: { kind: "path" },
        synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
      },
    }))).toThrow(/different immutable coordinates/);
    expect(() => store.publish(registration("graph-1", {
      material: materializeValidatedArtifact({ ...ARTIFACT, generatedAt: "2026-07-20T00:00:01.000Z" }),
    }))).toThrow(/different immutable coordinates/);
  });

  it("owns exact artifact bytes independently of later source writes or removal", () => {
    const store = createStore();
    const sourceRoot = temporaryRoot();
    const sourcePath = join(sourceRoot, "artifact.json");
    const bytes = Buffer.from(`${JSON.stringify(ARTIFACT)}\n`, "utf8");
    writeFileSync(sourcePath, bytes);
    store.publish(registration("graph-file", {
      material: verifiedArtifactFile(
        sourcePath,
        createHash("sha256").update(bytes).digest("hex"),
        artifactSummary(ARTIFACT),
      ),
    }));

    writeFileSync(sourcePath, "source was replaced after publication\n", "utf8");
    expect(store.loadArtifact("graph-file")).toEqual(ARTIFACT);
    expect(readFileSync(store.artifactPath("graph-file")!, "utf8")).toBe(`${JSON.stringify(ARTIFACT)}\n`);

    unlinkSync(sourcePath);
    rmSync(sourceRoot, { recursive: true, force: true });

    expect(store.loadArtifact("graph-file")).toEqual(ARTIFACT);
    expect(readFileSync(store.artifactPath("graph-file")!, "utf8")).toBe(`${JSON.stringify(ARTIFACT)}\n`);
  });

  it("publishes a verified-file proof without reading, parsing, validating, or hashing it again", () => {
    const store = createStore();
    const sourcePath = join(temporaryRoot(), "opaque-artifact.json");
    writeFileSync(sourcePath, "not JSON and not the claimed digest", "utf8");
    const claimedDigest = "a".repeat(64);

    const descriptor = store.publish(registration("proof-only", {
      material: verifiedArtifactFile(sourcePath, claimedDigest, artifactSummary(ARTIFACT)),
    }));

    expect(descriptor.byteDigest).toBe(claimedDigest);
    expect(readFileSync(store.artifactPath("proof-only")!, "utf8")).toBe("not JSON and not the claimed digest");
    expect(() => store.loadArtifact("proof-only")).toThrow(/digest does not match/);
  });

  it("loads a fresh validated artifact and fails closed on descriptor or artifact corruption", () => {
    const store = createStore();
    store.publish(registration("graph-1"));
    const first = store.loadArtifact("graph-1")!;
    first.nodes.length = 0;
    expect(store.loadArtifact("graph-1")?.nodes).toHaveLength(1);

    const artifactPath = store.artifactPath("graph-1")!;
    const descriptorPath = join(dirname(artifactPath), "descriptor.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Record<string, unknown>;
    const invalidArtifact = Buffer.from(JSON.stringify({ ...ARTIFACT, nodes: [{ ...ARTIFACT.nodes[0], id: "invalid" }] }));
    descriptor.byteDigest = createHash("sha256").update(invalidArtifact).digest("hex");
    writeFileSync(artifactPath, invalidArtifact);
    writeFileSync(descriptorPath, JSON.stringify(descriptor), "utf8");
    expect(() => store.loadArtifact("graph-1")).toThrow(/not a valid graph artifact/);

    writeFileSync(artifactPath, "{broken", "utf8");
    expect(() => store.loadArtifact("graph-1")).toThrow(/digest does not match/);

    descriptor.id = "other-id";
    writeFileSync(descriptorPath, JSON.stringify(descriptor), "utf8");
    expect(() => store.descriptor("graph-1")).toThrow(/id does not match/);
  });

  it("disposes its private root once and rejects later access", () => {
    const store = createStore();
    store.publish(registration("graph-1"));
    const rootPath = store.rootPath;

    store.dispose();
    store.dispose();

    expect(existsSync(rootPath)).toBe(false);
    expect(typeof store.rootPath).toBe("string");
    expect(() => store.has("graph-1")).toThrow(/disposed/);
  });
});

function createStore(): WebGraphStore {
  const store = new WebGraphStore();
  stores.push(store);
  return store;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-graph-store-test-"));
  temporaryRoots.push(root);
  return root;
}

function registration(
  id: string,
  overrides: Partial<WebGraphRegistration> = {},
): WebGraphRegistration {
  return {
    id,
    material: materializeValidatedArtifact(ARTIFACT),
    metadata: {
      sourceRoot: "/workspace/shop",
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
    ...overrides,
  };
}
