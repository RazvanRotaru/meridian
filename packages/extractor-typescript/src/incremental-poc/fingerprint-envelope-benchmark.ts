/**
 * Disposable microbenchmark for the two CPU-only optimizations on the revision-shard miss path:
 *
 *   1. decorate/sort/undecorate fingerprint records instead of canonicalizing both values from
 *      inside the O(n log n) comparator; and
 *   2. canonicalize an immutable-cache value once, then splice those exact bytes into the fixed
 *      canonical envelope instead of traversing the complete value once for its digest and again
 *      for the envelope.
 *
 * The benchmark creates its own real-Git fixture and cache below the OS temporary directory. It
 * opens no port, reads no service workspace, and cannot mutate the persistent web process.
 *
 * Run:
 *   pnpm --filter @meridian/extractor-typescript exec node --import tsx \
 *     src/incremental-poc/fingerprint-envelope-benchmark.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonSha256,
  compareCanonicalStrings,
  sha256Hex,
} from "./canonical-json";
import { extractRevisionCandidate } from "./extract-revision";
import { createGitMonorepoFixture } from "./git-fixture";
import {
  immutableJsonCachePath,
  writeImmutableJsonCache,
} from "./immutable-cache";
import { fixtureRequest } from "./test-support";

const CACHE_FORMAT = "meridian.incremental-poc.immutable-json.v1";
const SORT_RECORD_COUNT = 6_000;
const ENVELOPE_ITEM_COUNT = 12_000;
const TIMING_SAMPLES = 3;

const fixture = createGitMonorepoFixture();
const envelopeRoot = mkdtempSync(join(tmpdir(), "meridian-envelope-benchmark-"));

try {
  const candidate = await extractRevisionCandidate(
    fixtureRequest(fixture, fixture.seedRevision),
  );
  const fingerprintSeeds = candidate.unitShards.flatMap(({ unitId, value }) => [
    ...value.inputs.programInputs.map((input) => ({ kind: "program", input, unitId })),
    ...value.inputs.moduleResolutions.map((input) => ({ kind: "module", input, unitId })),
    ...value.inputs.typeReferenceResolutions.map((input) => ({
      kind: "type-reference",
      input,
      unitId,
    })),
    ...value.inputs.resolutionLookupInputs.map((input) => ({
      kind: "resolution-lookup",
      input,
      unitId,
    })),
  ]);
  assert(fingerprintSeeds.length > 0, "fixture produced no fingerprint records");

  const records = Array.from({ length: SORT_RECORD_COUNT }, (_, ordinal) => ({
    // A coprime stride makes the input deterministic and non-sorted without using ambient entropy.
    ordinal: (ordinal * 4_099) % SORT_RECORD_COUNT,
    seed: fingerprintSeeds[(ordinal * 97) % fingerprintSeeds.length],
  }));
  const legacySorted = legacyCanonicalSort(records);
  const optimizedSorted = decoratedCanonicalSort(records);
  assert.deepEqual(
    legacySorted.map(({ ordinal }) => ordinal),
    optimizedSorted.map(({ ordinal }) => ordinal),
    "optimized fingerprint ordering differs from the canonical comparator",
  );

  // Warm both implementations before collecting a small median. Timing is reported, never asserted:
  // CI scheduling noise must not turn this diagnostic harness into a flaky performance gate.
  legacyCanonicalSort(records.slice(0, 200));
  decoratedCanonicalSort(records.slice(0, 200));
  const legacySortMs = medianTiming(() => legacyCanonicalSort(records));
  const optimizedSortMs = medianTiming(() => decoratedCanonicalSort(records));

  const sourceShard = candidate.unitShards
    .map(({ value }) => value)
    .sort((left, right) => (
      canonicalJson(right.extraction).length - canonicalJson(left.extraction).length
    ))[0];
  assert(sourceShard !== undefined, "fixture produced no unit shard");
  const edgeSeeds = sourceShard.extraction.rawEdges;
  const nodeSeeds = sourceShard.extraction.nodes;
  assert(edgeSeeds.length + nodeSeeds.length > 0, "fixture shard contains no graph payload");

  const payload = {
    version: 1,
    shardKey: sourceShard.key,
    items: Array.from({ length: ENVELOPE_ITEM_COUNT }, (_, ordinal) => ({
      ordinal,
      programInput: fingerprintSeeds[ordinal % fingerprintSeeds.length],
      edge: edgeSeeds.length === 0 ? null : edgeSeeds[ordinal % edgeSeeds.length],
      node: nodeSeeds.length === 0 ? null : nodeSeeds[ordinal % nodeSeeds.length],
    })),
  };
  const address = sha256Hex("fingerprint-envelope-microbenchmark");
  const legacyBytes = legacyEnvelopeBytes(address, payload);
  const optimizedBytes = singlePassEnvelopeBytes(address, payload);
  assert(
    legacyBytes.equals(optimizedBytes),
    "single-pass immutable envelope differs from the canonical legacy bytes",
  );

  // Warm the serializers with a bounded prefix, then time the full fingerprint-shaped payload.
  const warmPayload = { ...payload, items: payload.items.slice(0, 100) };
  legacyEnvelopeBytes(address, warmPayload);
  singlePassEnvelopeBytes(address, warmPayload);
  const legacyEnvelopeMs = medianTiming(() => legacyEnvelopeBytes(address, payload));
  const optimizedEnvelopeMs = medianTiming(() => singlePassEnvelopeBytes(address, payload));

  const writerStarted = performance.now();
  const write = await writeImmutableJsonCache(envelopeRoot, address, payload);
  const writerMs = performance.now() - writerStarted;
  const persisted = readFileSync(immutableJsonCachePath(envelopeRoot, address));
  assert(persisted.equals(optimizedBytes), "production writer did not persist the expected bytes");

  process.stdout.write(`${JSON.stringify({
    version: 1,
    fixture: {
      units: candidate.metrics.totalUnits,
      rebuiltUnits: candidate.metrics.rebuiltUnits,
      fingerprintMs: rounded(candidate.metrics.fingerprintMs),
      postExtractionFingerprintMs: rounded(
        candidate.metrics.profile.postExtractionFingerprintMs,
      ),
      shardCodecMs: rounded(candidate.metrics.profile.shardCodecMs),
    },
    fingerprintCanonicalSort: {
      records: records.length,
      legacyComparatorMs: rounded(legacySortMs),
      decoratedSortMs: rounded(optimizedSortMs),
      speedup: ratio(legacySortMs, optimizedSortMs),
      exactOrder: true,
    },
    immutableEnvelope: {
      payloadBytes: Buffer.byteLength(canonicalJson(payload)),
      persistedBytes: persisted.byteLength,
      legacyTwoTraversalMs: rounded(legacyEnvelopeMs),
      singlePassMs: rounded(optimizedEnvelopeMs),
      speedup: ratio(legacyEnvelopeMs, optimizedEnvelopeMs),
      productionWriterMs: rounded(writerMs),
      exactBytes: true,
      created: write.created,
    },
    limitations: [
      "The scale is synthetic, although every repeated record comes from a real disposable extraction.",
      "This isolates CPU serialization; it does not predict an Autopilot end-to-end speedup.",
      "A full pre-change fingerprint comparison requires a separate baseline checkout or production hooks.",
    ],
  }, null, 2)}\n`);
} finally {
  fixture.cleanup();
  rmSync(envelopeRoot, { recursive: true, force: true });
}

function legacyCanonicalSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => (
    compareCanonicalStrings(canonicalJson(left), canonicalJson(right))
  ));
}

function decoratedCanonicalSort<T>(values: readonly T[]): T[] {
  return values
    .map((value) => ({ key: canonicalJson(value), value }))
    .sort((left, right) => compareCanonicalStrings(left.key, right.key))
    .map(({ value }) => value);
}

function legacyEnvelopeBytes(address: string, value: unknown): Buffer {
  const payloadDigest = canonicalJsonSha256(value);
  return canonicalJsonBytes({
    format: CACHE_FORMAT,
    address,
    payloadDigest,
    value,
  });
}

function singlePassEnvelopeBytes(address: string, value: unknown): Buffer {
  const canonicalValue = canonicalJson(value);
  const payloadDigest = sha256Hex(canonicalValue);
  return Buffer.from(
    `{"address":${JSON.stringify(address)},`
    + `"format":${JSON.stringify(CACHE_FORMAT)},`
    + `"payloadDigest":${JSON.stringify(payloadDigest)},`
    + `"value":${canonicalValue}}`,
    "utf8",
  );
}

function medianTiming(run: () => unknown): number {
  const samples: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(before: number, after: number): number | null {
  return after > 0 ? Math.round((before / after) * 100) / 100 : null;
}
