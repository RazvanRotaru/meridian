# Revision-safe incremental TypeScript extraction POC

Status: **implemented and validated as an opt-in POC; revise before production cutover**  
POC baseline: fetched `origin/main` commit
`44cb54a29d03e28f9971e7f1902bc28a8200a7f4`, tree
`5fcce84a69da7de2b09cfb64263989ed1de88205` (2026-07-23)

## Recommendation

Proceed with corpus-scale shadow evaluation of the package-shard model, but revise it before
production serving.

The POC proves two useful behaviors:

- an exact cached Autopilot revision is 4.73 times faster in a new process and produces the same
  semantic digest as its cold extraction;
- a real PR HEAD reuses 25 of 28 package shards from its merge base and produces the same manifest,
  unit keys, and semantic digest as an isolated empty-cache oracle.

The same PR also exposes the next limit. Its changed `src/aria/app` unit contains 4,528 files and
74% of selected source bytes, so safely reusing 89% of units reuses only 22% of bytes. The
incremental run is 28% faster, not instant. A production design needs a smaller compiler-derived
semantic unit inside such packages; a Git changed-file list plus ad-hoc neighbor BFS is not a
sound replacement.

## Current pipeline and seam

Current main already has a plain-data boundary suitable for reuse:

1. `extractor.ts` derives the canonical workspace, including PR supplemental source scope.
2. `project-loader.ts` creates one short-lived `ts-morph` `Project` per workspace unit.
3. `extract-per-package.ts` reduces a loaded unit to immutable plain data: nodes, raw edges and
   call sites, pending cross-package references, implementation members, flows, ports, export
   summaries, diagnostics, and file count.
4. `stitchUnitExtractions` always reruns over the complete current set of unit contributions. It
   joins cross-package references and performs the ordinary finalization/collapse/stats tail.
5. The CLI continues through its existing mixed-language merge, review fingerprinting, artifact
   validation, and atomic artifact-writing path.

No prior `GraphArtifact` is loaded, patched, or mutated. A full build is this pipeline with no
eligible cache entries.

## Model

```text
exact clean Git tree + fixed policy/build/runtime provenance
  -> derive the current ordered workspace
  -> for each unit, sequentially:
       construct the ordinary short-lived Project
       fingerprint exact observed compiler/config/filesystem inputs
       enumerate small immutable candidates for that base input
       replay each candidate's recorded workspace-resolver observations
       unique exact match: decode the immutable unit shard
       no match/ineligible: run the ordinary unit extractor with a tracing resolver
       re-fingerprint and reject any input movement
       encode and decode the exact persisted representation
       stage the new shard and candidate reference
  -> run the ordinary canonical stitch/finalization
  -> reverify exact tree and HEAD commit
  -> publish staged immutable data
```

### Revision manifest

Manifest schema v1 is content-addressed and bound to the exact Git tree OID. It records:

- workspace topology digest;
- analysis policy and implementation/runtime provenance;
- ordered unit IDs, shard keys, source blob identities, and eligibility;
- the normalized semantic result digest.

Timing, process ID, RSS, cache size, and reuse counters never enter identity.

### Unit shard schema v6

The base unit fingerprint contains:

- workspace unit directory, package name, entry point, source root, include, and exclude identity;
- selected source paths with exact Git blob OID, mode, size, and verified checkout bytes;
- the complete realized TypeScript program: portable address, source-text digest, tracked OID,
  default/external flags, and implied Node format;
- the unit/root `tsconfig` selection probes plus every tracked local file in the selected
  `extends` chain; package-name, escaping, untracked, malformed, cyclic, symlinked, or unresolved
  config inputs conservatively deny reuse;
- effective compiler options with checkout-root paths normalized;
- module and type-reference resolution results, target metadata, failed lookup paths, affecting
  locations, and exact present/absent state;
- present/absent ancestor package manifests observed by external-import classification;
- the structural npm-package membership outcome for every emitted package path;
- analysis policy, graph/extractor/shard versions, TypeScript and `ts-morph` versions, and the
  server's deterministic analysis-build fingerprint.

Unobserved README, workflow, lock, image, CSS, and other non-TypeScript blobs are not copied into
every unit key. Imported JSON/JavaScript, relevant manifests, configs, and resolver reads remain in
the realized input set. The exact tree OID still binds the revision as a whole.

External or untracked non-default program inputs and resolution targets are ineligible. Negative
module results are reusable only when TypeScript exposes a complete failed-lookup proof and every
lookup remains absent. A dependency appearing at a previously failed path therefore invalidates
the unit.

### Workspace topology without global invalidation

Workspace topology remains in the revision manifest, but it is not blindly included in every unit
key. Each extracted unit records every observation made through the pure
`CrossPackageResolver`:

- `matches(specifier) -> boolean`;
- `resolveRelative(from, specifier) -> workspace path | null`;
- `resolveFile(from, target) -> workspace path | null`.

The trace is sorted, deduplicated, schema-validated, and replayed against the current workspace.
False and null are important negative observations. An unrelated new package can reuse a unit; a
new package that satisfies an old import or changes path ownership cannot. External path inputs,
inconsistent resolver results, and resolver exceptions make the shard non-reusable.

The immutable cache has two levels:

- a small candidate reference indexed by the base input key, containing the resolver trace and
  shard key;
- the larger content-addressed shard, read only after exactly one trace matches.

This avoids loading every historical large shard merely to test its topology. Multiple topology
variants may coexist for the same base inputs, so A -> B -> A selects the original immutable
variant.

### Storage and admission boundaries

Reusable shard addresses hash base inputs plus the resolver trace. Ineligible diagnostic shards
also include serialized output in their address and are never referenced as hits. Writes use
canonical JSON, payload digests, atomic no-overwrite links, and collision checks. Cache paths are
resolved through existing ancestors and rejected if a lexical path or symlink lands inside the
exact checkout. Every descendant directory is also walked with `lstat`; cache-controlled
directory symlinks and non-regular final entries are rejected, and reads open the final entry with
`O_NOFOLLOW`. This relies on the server owning the canonical cache root; it is not a defense
against a hostile same-user process racing directory replacement.

`extractRevisionCandidate` stages writes. The differential harness compares the complete
incremental result with a new empty-cache run and publishes only after exact parity and a second
tree/commit verification. A deliberately poisoned but structurally valid cached output is caught
by the cold oracle, and newly rebuilt shards are not admitted.

The web integration is server-owned and off by default:

- `empty`: the same shard pipeline with a disposable empty cache;
- `shadow`: builds incremental and cold, requires parity, serves the cold result, and admits only
  the compared candidate;
- `verified-experimental`: directly exercises the persistent cache for local performance testing.

The HTTP client cannot provide tree, cache, build, runtime, or policy identity. The private worker
transport receives those fields only after the server resolves an exact repository root and Git
tree. `verified-experimental` is not part of the semantic-guarantee claim: integrity hashes prove
storage integrity, not authenticity of a previously admitted output. Production reads need an
oracle-admission receipt/trusted writer boundary.

## Invalidation behavior

| Change or condition | Behavior |
|---|---|
| Modify/add/delete/rename selected TypeScript | Rebuild the owning unit and any unit whose realized program/resolution inputs change. |
| Provider export changes while consumer has a stable pending reference | Reuse the consumer contribution and rerun the current global stitch. |
| New unrelated supplemental package | Build only the new unit; reuse existing units whose structural and resolver observations still match. |
| New package satisfies an old bare/relative/alias lookup | Rebuild the observing unit because trace replay differs. |
| Root config used by all units changes | Rebuild all consumers of that config. |
| Package-local config or local extends file changes | Rebuild only units selecting that chain. |
| Imported tracked JSON changes | Rebuild units whose realized program contains it. |
| Unobserved non-TypeScript file or irrelevant tracked symlink changes | Reuse unit shards; the target revision remains separately tree-bound. |
| External/untracked compiler, config, manifest, or resolution input | Rebuild every run; never admit a reusable candidate. |
| Dirty/wrong tree, unsafe Git mode/link, corrupt/colliding cache, cache path inside checkout | Fail closed without a provisional graph. |

## Differential and adversarial coverage

Normalization compares complete nodes, edges, call-site ranges, flows, ports, diagnostics, and
stats. It normalizes only non-semantic collection order/absent values. Negative controls mutate
each major category and require a mismatch.

Disposable real Git fixtures cover:

- cold, warm, and fresh-process reuse;
- ordinary modify/add/delete/rename;
- provider re-export/dependency-boundary changes;
- root and package-local config/extends changes;
- imported JSON changes and ignored dependency appearance/remapping;
- supplemental scope, unrelated topology, newly matched bare/relative imports, and A -> B -> A
  resolver variants;
- irrelevant and unsafe symlink cases;
- unobserved non-TypeScript changes beside selected sources;
- two histories reaching one exact target tree;
- sibling PR-like heads sharing a base without retaining both full graphs;
- corruption, poisoned outputs, dirty checkouts, cache-root symlink escape, and nested
  cache-prefix symlink escape.

## Real Autopilot evidence

Environment: macOS arm64, Node 26.2.0, production 8 GB heap, separate exiting processes, product
TypeScript policy. The shared-cache runs never held the base and HEAD full graphs concurrently.

Exact revisions:

- merge base commit `9569676c8c7bd5d3573773113643fdf2c5fd9270`, tree
  `140d4d93f1d5564219c46ba1ebbc586a6bcb8e99`;
- PR #4472 HEAD commit `91ad7ee0cd1d954e4f278354efb2240ea206834d`, tree
  `0c4d903fcbeaee0c6aa9a95e876e96d6044a1649`;
- 43 non-deleted supplemental TypeScript paths, yielding 27 base units and 28 HEAD units.

| Scenario | Total | Fingerprint | Extraction | Reuse | Byte reuse | Peak RSS | Cache |
|---|---:|---:|---:|---:|---:|---:|---:|
| Base cold | 230.9 s | 33.2 s | 155.9 s | 0/27 | 0% | 7.74 GB | 474.3 MB |
| Base warm, new process | 48.8 s | 32.6 s | 0 s | 27/27 | 100% | 7.06 GB | 474.3 MB |
| HEAD from warm base | 203.2 s | 37.4 s | 120.8 s | 25/28 | 21.8% | 7.34 GB | 858.4 MB shared |
| HEAD empty-cache oracle | 283.2 s | 47.5 s | 176.8 s | 0/28 | 0% | 7.47 GB | 488.6 MB |
| HEAD warm, new process | 64.0 s | 47.3 s | 0 s | 28/28 | 100% | 6.62 GB | 858.4 MB shared |

Base warm is 78.9% faster (4.73x). Cross-revision HEAD is 28.3% faster (1.39x) than its exact cold
oracle. Warm HEAD is 77.4% faster (4.43x). The shared base-plus-HEAD cache saves 104.4 MB versus
storing two isolated caches.

The base digest is
`24ef0007583ddc22a243a6b0247fb1fe2691a8c6a44616f4894da433b819a45f`.
Both HEAD runs produce
`cbe4625e63b35788b2fd2e5bf5077bb6d67f6481cbcf852cb7a044ce44d31840`,
the same manifest address, and the same 28 shard keys.

The three rebuilt HEAD units are exactly:

- changed `src/aria/app`;
- unchanged `src/packages/autopilot-delegate-iframe`, whose compiler program observes changed app
  inputs;
- newly admitted `src/packages/autopilot-delegate-web`.

The other 25 existing units reuse the base shards. This matches the independent workspace-input
audit.

## Proven versus assumed

Proven by tests and the real benchmark:

- immutable unit reuse across processes and revisions;
- complete cold-oracle parity for the fixture mutation matrix;
- real base/HEAD convergence on exact semantic digests, manifests, and shard keys;
- unrelated topology does not invalidate every unit, while observed topology does;
- canonical cold and incremental paths use the same reducer, codec, stitcher, and finalization;
- two revisions share on-disk shards without concurrent full-graph residency.

Still assumptions or production blockers:

- a mutable checkout has a residual ABA race despite start/end tree, byte, and commit checks;
- a hit still constructs the full short-lived TypeScript Project to prove its fingerprint, so warm
  runs retain 6-7 GB peak RSS and 33-47 seconds of work;
- the large app unit is too coarse for small PRs;
- external package-manager state, generated declarations, plugins, and custom hosts are
  conservatively ineligible rather than hermetically modeled;
- CAS integrity is not trusted admission/authenticity; the direct experimental mode is not a
  production safety boundary;
- there is no quota, retention, garbage collection, or multi-process admission singleflight;
- corpus-wide parity and operational failure rates are not yet known.

The cold extraction remains the semantic authority. Hashes, trace replay, and invariants are reuse
proof inputs, not a substitute for differential evidence.

## Productionization sequence

1. Run `shadow` across representative repositories and persist categorized parity/admission
   results. Do not serve candidate-derived graphs during this phase.
2. Extract from an owned immutable Git/dependency snapshot and close the mutable-checkout ABA
   window.
3. Add trusted-writer/oracle admission receipts, quarantine, concurrent admission coordination,
   quotas, retention, and garbage collection.
4. Replace hit-time Project construction with a Git/config/dependency manifest that proves the
   same inputs without loading compiler state.
5. For dominant packages, derive smaller immutable compiler-semantic regions and reverse
   dependencies from actual resolution/checker observations. Rebuild to a fixed point and keep the
   full cold oracle. Do not infer safety from textual Git neighbors alone.
6. Extend corpus coverage for project references, package managers, generated files, ambient
   types, custom resolution, flows, and ports.
7. Only after zero unexplained shadow mismatches and acceptable latency/memory/disk results, plan a
   separate production PR-serving and cache-admission cutover.

## Validation log

Focused final validation:

```text
pnpm --dir packages/extractor-typescript typecheck
  passed

pnpm --dir packages/extractor-typescript exec vitest run \
  src/incremental-poc/immutable-cache.test.ts \
  src/incremental-poc/config-inputs.test.ts \
  src/incremental-poc/workspace-resolver-trace.test.ts \
  src/incremental-poc/revision-parity.test.ts \
  src/incremental-poc/revision-sharing.test.ts
  5 files, 48 tests passed

Real Autopilot base cold/warm, HEAD shared-base, HEAD isolated oracle, and HEAD warm
  5 separate process runs passed with the metrics above

pnpm --filter @meridian/extractor-typescript test
  35 files, 280 tests passed

pnpm --filter @meridian/core test
  23 files, 204 tests passed

pnpm --filter @meridian/extractor-python test
  9 files, 54 tests passed

pnpm --filter @meridian/cli exec vitest run ...
  68 files, 657 tests passed and 3 intentionally skipped

pnpm --filter @meridian/renderer test
  234 files, 2,108 tests passed

PR progress layout browser E2E
  1 file, 2 tests passed
```

The complete workspace validation commands and outcomes are also recorded in
`docs/pr-review-loading-optimization.md`.
