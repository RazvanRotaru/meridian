/**
 * Process-private, disk-backed graph registrations for web mode.
 *
 * A store retains only its temporary root path. Every descriptor and artifact lookup goes back to
 * disk, so registering a graph never makes its object graph part of long-lived server state.
 */

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  syntheticScenarioDescriptorSchema,
  validateArtifact,
  type GraphArtifact,
  type SyntheticScenarioDescriptor,
} from "@meridian/core";
import type { SyntheticExecutionTrust } from "./web-boot";
import type { ArtifactSource } from "./web-source";

const DESCRIPTOR_FORMAT_VERSION = 1 as const;
const ARTIFACT_NAME = "artifact.json";
const DESCRIPTOR_NAME = "descriptor.json";
const SHA256 = /^[a-f0-9]{64}$/;
const MATERIAL_PROOF = Symbol("web graph artifact material proof");

export interface WebGraphArtifactSummary {
  schemaVersion: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

interface ProvenArtifactMaterial {
  readonly [MATERIAL_PROOF]: true;
  /** SHA-256 of the exact bytes served by `/api/graph`. */
  readonly byteDigest: string;
  readonly summary: WebGraphArtifactSummary;
}

export interface SerializedArtifactMaterial extends ProvenArtifactMaterial {
  readonly kind: "serialized";
  readonly bytes: Buffer;
}

export interface VerifiedFileArtifactMaterial extends ProvenArtifactMaterial {
  readonly kind: "verified-file";
  /** An immutable file that the caller already read, parsed, validated, and digest-checked. */
  readonly path: string;
}

export type WebGraphArtifactMaterial = SerializedArtifactMaterial | VerifiedFileArtifactMaterial;

/**
 * Serialize one graph that an upstream analysis boundary has already validated.
 *
 * Keeping validation at that boundary is important: zod validation clones the whole object graph.
 * This materializer performs one serialization and one digest pass over the resulting bytes, and
 * those exact bytes and digest are then reused for identity and publication.
 */
export function materializeValidatedArtifact(artifact: GraphArtifact): SerializedArtifactMaterial {
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  return {
    [MATERIAL_PROOF]: true,
    kind: "serialized",
    bytes,
    byteDigest: digest(bytes),
    summary: artifactSummary(artifact),
  };
}

/** O(1) descriptor data for an artifact that has already passed core validation. */
export function artifactSummary(artifact: GraphArtifact): WebGraphArtifactSummary {
  return {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    edgeCount: artifact.edges.length,
  };
}

/**
 * Create a proof for an immutable cache file that the caller has already verified.
 *
 * This deliberately checks only path shape and compact proof fields. It never reads, parses, or
 * validates the artifact again; doing so would turn cache-to-store publication into a second full
 * graph materialization boundary.
 */
export function verifiedArtifactFile(
  path: string,
  byteDigest: string,
  summary: WebGraphArtifactSummary,
): VerifiedFileArtifactMaterial {
  const digestValue = requireSha256(byteDigest, "verified artifact byte digest");
  const summaryValue = parseSummary(summary, "verified artifact summary");
  requirePlainFile(path, "verified artifact file");
  return {
    [MATERIAL_PROOF]: true,
    kind: "verified-file",
    path,
    byteDigest: digestValue,
    summary: summaryValue,
  };
}

export interface WebGraphDescriptor {
  formatVersion: 1;
  id: string;
  /** SHA-256 of the exact bytes stored and served for this graph. */
  byteDigest: string;
  summary: WebGraphArtifactSummary;
  sourceRoot: string;
  source: ArtifactSource;
  synthetic: {
    scenarios: SyntheticScenarioDescriptor[];
    sourceFingerprint: string | null;
    trust: SyntheticExecutionTrust | null;
  };
}

export interface WebGraphRegistration {
  id: string;
  material: WebGraphArtifactMaterial;
  metadata: {
    sourceRoot: string;
    source: ArtifactSource;
    synthetic: {
      scenarios: SyntheticScenarioDescriptor[];
      sourceFingerprint: string | null;
      trust: SyntheticExecutionTrust | null;
    };
  };
}

/**
 * An immutable graph registry whose only retained state is the path to its private temporary root.
 * All operations are synchronous so one publication is visible as a complete directory or not at
 * all to the request that follows it.
 */
export class WebGraphStore {
  readonly rootPath: string;
  #disposed = false;

  constructor() {
    this.rootPath = realpathSync.native(mkdtempSync(join(tmpdir(), "meridian-web-graphs-")));
  }

  publish(registration: WebGraphRegistration): WebGraphDescriptor {
    this.#assertActive();
    const id = requireNonEmptyString(registration.id, "graph id");
    const material = requireArtifactMaterial(registration.material, id);
    const descriptor = parseDescriptor({
      formatVersion: DESCRIPTOR_FORMAT_VERSION,
      id,
      byteDigest: material.byteDigest,
      summary: material.summary,
      sourceRoot: registration.metadata.sourceRoot,
      source: registration.metadata.source,
      synthetic: registration.metadata.synthetic,
    }, id);

    const existing = this.descriptor(id);
    if (existing !== undefined) {
      return this.#acceptExactRepublish(existing, descriptor);
    }

    const stage = mkdtempSync(join(this.rootPath, ".stage-"));
    const destination = this.#entryPath(id);
    try {
      publishArtifactMaterial(material, join(stage, ARTIFACT_NAME));
      writeFileSync(
        join(stage, DESCRIPTOR_NAME),
        `${JSON.stringify(descriptor, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      try {
        renameSync(stage, destination);
      } catch (error) {
        if (!existsSync(destination)) throw error;
        const raced = this.descriptor(id);
        if (raced === undefined) throw error;
        return this.#acceptExactRepublish(raced, descriptor);
      }
      return descriptor;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  descriptor(id: string): WebGraphDescriptor | undefined {
    this.#assertActive();
    // HTTP callers commonly normalize an absent query parameter to the empty string. It is a
    // cache miss, never a store-integrity failure; publication still rejects an empty id.
    if (id.length === 0) return undefined;
    const entry = this.#entryPath(id);
    if (!existsSync(entry)) return undefined;
    requirePlainDirectory(entry, `graph '${id}' entry`);
    const path = join(entry, DESCRIPTOR_NAME);
    requirePlainFile(path, `graph '${id}' descriptor`);
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`graph '${id}' descriptor is not valid JSON`, { cause: error });
    }
    return parseDescriptor(input, id);
  }

  has(id: string): boolean {
    return this.descriptor(id) !== undefined;
  }

  artifactPath(id: string): string | undefined {
    const descriptor = this.descriptor(id);
    if (descriptor === undefined) return undefined;
    const path = join(this.#entryPath(id), ARTIFACT_NAME);
    requirePlainFile(path, `graph '${id}' artifact`);
    return path;
  }

  /** Read, integrity-check, parse, and core-validate one artifact without retaining it. */
  loadArtifact(id: string): GraphArtifact | undefined {
    const descriptor = this.descriptor(id);
    if (descriptor === undefined) return undefined;
    const path = join(this.#entryPath(id), ARTIFACT_NAME);
    requirePlainFile(path, `graph '${id}' artifact`);
    const bytes = readFileSync(path);
    if (digest(bytes) !== descriptor.byteDigest) {
      throw new Error(`graph '${id}' artifact digest does not match its descriptor`);
    }
    const artifact = parseArtifact(bytes, `graph '${id}' stored artifact`);
    if (!isDeepStrictEqual(artifactSummary(artifact), descriptor.summary)) {
      throw new Error(`graph '${id}' artifact summary does not match its descriptor`);
    }
    return artifact;
  }

  dispose(): void {
    if (this.#disposed) return;
    rmSync(this.rootPath, { recursive: true, force: true });
    this.#disposed = true;
  }

  #acceptExactRepublish(
    existing: WebGraphDescriptor,
    candidate: WebGraphDescriptor,
  ): WebGraphDescriptor {
    if (!isDeepStrictEqual(existing, candidate)) {
      throw new Error(`graph id '${candidate.id}' is already registered with different immutable coordinates`);
    }
    requirePlainFile(join(this.#entryPath(candidate.id), ARTIFACT_NAME), `graph '${candidate.id}' artifact`);
    return existing;
  }

  #entryPath(id: string): string {
    return join(this.rootPath, createHash("sha256").update(id).digest("hex"));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("web graph store has been disposed");
  }
}

function publishArtifactMaterial(material: WebGraphArtifactMaterial, destination: string): void {
  if (material.kind === "serialized") {
    writeFileSync(destination, material.bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  // COPYFILE_FICLONE requests a copy-on-write clone where the filesystem supports it and falls
  // back to an ordinary copy otherwise. Unlike a hard link, either result gives the graph store an
  // independently owned inode: later cache-file writes cannot mutate bytes behind an immutable id.
  copyFileSync(material.path, destination, constants.COPYFILE_FICLONE);
}

function requireArtifactMaterial(material: WebGraphArtifactMaterial, id: string): WebGraphArtifactMaterial {
  if (material === null || typeof material !== "object" || material[MATERIAL_PROOF] !== true) {
    throw new Error(`graph '${id}' requires a proven artifact material`);
  }
  requireSha256(material.byteDigest, `graph '${id}' artifact byte digest`);
  parseSummary(material.summary, `graph '${id}' artifact summary`);
  if (material.kind === "serialized") {
    if (!Buffer.isBuffer(material.bytes)) throw new Error(`graph '${id}' serialized artifact bytes must be a buffer`);
    return material;
  }
  if (material.kind !== "verified-file") throw new Error(`graph '${id}' artifact material kind is invalid`);
  requirePlainFile(material.path, `graph '${id}' verified artifact`);
  return material;
}

function parseArtifact(bytes: Buffer, label: string): GraphArtifact {
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return validatedArtifact(input, label);
}

function validatedArtifact(input: unknown, label: string): GraphArtifact {
  const result = validateArtifact(input);
  if (!result.ok || result.artifact === undefined) {
    const details = result.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`${label} is not a valid graph artifact${details ? `: ${details}` : ""}`);
  }
  return result.artifact;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseDescriptor(input: unknown, expectedId: string): WebGraphDescriptor {
  const descriptor = requireRecord(input, `graph '${expectedId}' descriptor`);
  requireExactKeys(descriptor, [
    "byteDigest",
    "formatVersion",
    "id",
    "source",
    "sourceRoot",
    "summary",
    "synthetic",
  ], `graph '${expectedId}' descriptor`);
  if (descriptor.formatVersion !== DESCRIPTOR_FORMAT_VERSION) {
    throw new Error(`graph '${expectedId}' descriptor has an unsupported format version`);
  }
  const id = requireNonEmptyString(descriptor.id, `graph '${expectedId}' descriptor id`);
  if (id !== expectedId) throw new Error(`graph '${expectedId}' descriptor id does not match its lookup key`);
  const byteDigest = requireSha256(descriptor.byteDigest, `graph '${expectedId}' artifact byte digest`);
  const summary = parseSummary(descriptor.summary, `graph '${expectedId}' summary`);
  const synthetic = requireRecord(descriptor.synthetic, `graph '${expectedId}' synthetic metadata`);
  requireExactKeys(synthetic, ["scenarios", "sourceFingerprint", "trust"], `graph '${expectedId}' synthetic metadata`);
  if (!Array.isArray(synthetic.scenarios)) throw new Error(`graph '${expectedId}' synthetic scenarios must be an array`);

  return {
    formatVersion: DESCRIPTOR_FORMAT_VERSION,
    id,
    byteDigest,
    summary,
    sourceRoot: requireNonEmptyString(descriptor.sourceRoot, `graph '${expectedId}' source root`),
    source: parseSource(descriptor.source, expectedId),
    synthetic: {
      scenarios: synthetic.scenarios.map((scenario, index) => parseScenario(scenario, expectedId, index)),
      sourceFingerprint: nullableNonEmptyString(synthetic.sourceFingerprint, `graph '${expectedId}' synthetic source fingerprint`),
      trust: parseTrust(synthetic.trust, expectedId),
    },
  };
}

function parseSource(input: unknown, id: string): ArtifactSource {
  const source = requireRecord(input, `graph '${id}' source`);
  if (source.kind === "path" || source.kind === "other") {
    requireExactKeys(source, ["kind"], `graph '${id}' source`);
    return { kind: source.kind };
  }
  if (source.kind !== "github") throw new Error(`graph '${id}' source kind is invalid`);
  const keys = source.subdir === undefined ? ["kind", "owner", "repo"] : ["kind", "owner", "repo", "subdir"];
  requireExactKeys(source, keys, `graph '${id}' source`);
  const result: ArtifactSource = {
    kind: "github",
    owner: requireNonEmptyString(source.owner, `graph '${id}' source owner`),
    repo: requireNonEmptyString(source.repo, `graph '${id}' source repo`),
  };
  if (source.subdir !== undefined) result.subdir = requireNonEmptyString(source.subdir, `graph '${id}' source subdir`);
  return result;
}

function parseScenario(input: unknown, id: string, index: number): SyntheticScenarioDescriptor {
  const parsed = syntheticScenarioDescriptorSchema.safeParse(input);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, input)) {
    throw new Error(`graph '${id}' synthetic scenario ${index} is invalid`);
  }
  return parsed.data;
}

function parseTrust(input: unknown, id: string): SyntheticExecutionTrust | null {
  if (input === null) return null;
  const trust = requireRecord(input, `graph '${id}' synthetic trust`);
  if (trust.mode === "local") {
    requireExactKeys(trust, ["mode"], `graph '${id}' synthetic trust`);
    return { mode: "local" };
  }
  if (trust.mode !== "sandboxed-pr") throw new Error(`graph '${id}' synthetic trust mode is invalid`);
  requireExactKeys(trust, ["mode", "provenance"], `graph '${id}' synthetic trust`);
  const provenance = requireRecord(trust.provenance, `graph '${id}' synthetic trust provenance`);
  requireExactKeys(provenance, ["headSha", "repository"], `graph '${id}' synthetic trust provenance`);
  return {
    mode: "sandboxed-pr",
    provenance: {
      repository: requireNonEmptyString(provenance.repository, `graph '${id}' synthetic repository`),
      headSha: requireNonEmptyString(provenance.headSha, `graph '${id}' synthetic head SHA`),
    },
  };
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
  }
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requireSha256(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);
  if (!SHA256.test(value)) throw new Error(`${label} is not SHA-256`);
  return value;
}

function parseSummary(input: unknown, label: string): WebGraphArtifactSummary {
  const summary = requireRecord(input, label);
  requireExactKeys(summary, ["edgeCount", "generatedAt", "nodeCount", "schemaVersion"], label);
  return {
    schemaVersion: requireNonEmptyString(summary.schemaVersion, `${label} schema version`),
    generatedAt: requireNonEmptyString(summary.generatedAt, `${label} generated time`),
    nodeCount: requireCount(summary.nodeCount, `${label} node count`),
    edgeCount: requireCount(summary.edgeCount, `${label} edge count`),
  };
}

function nullableNonEmptyString(input: unknown, label: string): string | null {
  return input === null ? null : requireNonEmptyString(input, label);
}

function requireCount(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return input;
}

function requirePlainDirectory(path: string, label: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a plain directory`);
}

function requirePlainFile(path: string, label: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not a plain file`);
}
