import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeServiceTopologySidecar,
  isServiceTopologySidecarDescriptor,
  MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES,
  readServiceTopologySidecar,
  serviceTopologySidecarPath,
  writeServiceTopologySidecar,
  type ServiceTopologySidecarDescriptor,
} from "./service-topology-sidecar";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-service-topology-"));
  roots.push(root);
  return root;
}

function node(id: string, kind: string, displayName: string, parentId: string | null = null): GraphNode {
  return {
    id,
    kind,
    displayName,
    qualifiedName: id,
    parentId,
    location: { file: "src/orders.ts", startLine: 1 },
  } as GraphNode;
}

const NODES = [
  node("module:orders", "module", "orders"),
  node("repo:orders", "class", "OrderRepository", "module:orders"),
  node("repo:orders#save", "method", "save", "repo:orders"),
  node("svc:orders", "class", "OrderService", "module:orders"),
  node("svc:orders#submit", "method", "submit", "svc:orders"),
];

const EDGES = [{
  id: "injects:orders",
  source: "svc:orders",
  target: "repo:orders",
  kind: "injects",
}] as GraphEdge[];

const ARTIFACT = { nodes: NODES, edges: EDGES } as unknown as GraphArtifact;

function descriptorFor(payload: Buffer): ServiceTopologySidecarDescriptor {
  return {
    version: 1,
    bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

describe("service topology sidecar", () => {
  it("writes and verifies canonical compact Service facts", () => {
    const root = temporaryRoot();
    const encoded = encodeServiceTopologySidecar(ARTIFACT);

    writeServiceTopologySidecar(root, encoded);

    expect(readServiceTopologySidecar(root, encoded.descriptor)).toEqual(encoded.topology);
    expect(readFileSync(serviceTopologySidecarPath(root))).toEqual(encoded.payload);
    expect(statSync(serviceTopologySidecarPath(root)).mode & 0o777).toBe(0o600);
    const json = encoded.payload.toString("utf8");
    expect(json).not.toContain("\"location\"");
    expect(json).not.toContain("\"parentId\"");
    expect(json).not.toContain("\"nodes\"");
  });

  it("rejects tampered bytes before parsing them", () => {
    const root = temporaryRoot();
    const encoded = encodeServiceTopologySidecar(ARTIFACT);
    writeServiceTopologySidecar(root, encoded);
    const tampered = Buffer.from(encoded.payload);
    tampered[tampered.length - 1] = 0x5d;
    writeFileSync(serviceTopologySidecarPath(root), tampered);

    expect(() => readServiceTopologySidecar(root, encoded.descriptor))
      .toThrow("failed integrity verification");
  });

  it("rejects integrity-valid JSON that violates the strict topology schema", () => {
    const root = temporaryRoot();
    const encoded = encodeServiceTopologySidecar(ARTIFACT);
    const invalid = Buffer.from(JSON.stringify({ ...encoded.topology, nodes: [] }), "utf8");
    writeFileSync(serviceTopologySidecarPath(root), invalid, { mode: 0o600 });

    expect(() => readServiceTopologySidecar(root, descriptorFor(invalid)))
      .toThrow("invalid serialized service topology");
  });

  it("validates descriptors and refuses an encoded payload/descriptor mismatch", () => {
    const encoded = encodeServiceTopologySidecar(ARTIFACT);
    expect(isServiceTopologySidecarDescriptor(encoded.descriptor)).toBe(true);
    expect(isServiceTopologySidecarDescriptor({ ...encoded.descriptor, debug: true })).toBe(false);
    expect(isServiceTopologySidecarDescriptor({
      ...encoded.descriptor,
      bytes: MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES + 1,
    })).toBe(false);

    const root = temporaryRoot();
    expect(() => writeServiceTopologySidecar(root, {
      ...encoded,
      descriptor: { ...encoded.descriptor, sha256: "0".repeat(64) },
    })).toThrow("does not match its descriptor");
  });
});
