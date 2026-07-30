# Revision-safe file-grained TypeScript shard POC

Status: **validated POC; revise before production use**
Date: 2026-07-28

This note supersedes the earlier SCC-oriented semantic-region section in
`revision-safe-incremental-extraction-poc.md`. The package-shard and admission machinery described
there still applies. This follow-up changes the inner reuse boundary to one selected TypeScript
source file and measures that design on a real Autopilot merge-base/HEAD pair.

## Recommendation

Proceed with the architecture, but revise the proof and performance boundary before production.

The POC proves that immutable file-grained semantic contributions can be shared across revisions,
materialized through the same canonical extraction/stitch path, and match a clean-cache extraction
byte for byte. On the final controlled Autopilot pair it reduced a 3m16.5s clean-cache HEAD
extraction to 2m02.6s while reusing 93.57% of selected files.

It does **not** prove that the current manually maintained compiler-observation transcript covers
every future extractor query. It also still constructs the exact target TypeScript program and
runs several fresh whole-unit lanes, leaving a 68.7s extraction lane plus a 30.4s
semantic-addressing lane on the measured warm run. Peak RSS remained about 7.86 GiB. Those are
production blockers, not polish items.

## Correctness model

Extraction remains a pure function of:

- the exact Git tree OID and verified checkout bytes;
- the realized TypeScript program and resolution observations;
- selected source blobs and workspace/package topology observations;
- the effective TypeScript configuration and compiler options;
- extractor, graph schema, shard, TypeScript, and ts-morph versions;
- the complete analysis policy.

No previous `GraphArtifact` is read, patched, or mutated. A clean build is the same contribution,
materialization, stitch, and finalization pipeline with no eligible cache entries.

The current formats are deliberately versioned and disposable:

| Contract | Version |
|---|---:|
| Unit shard | 12 |
| Revision manifest | 4 |
| Compiler-observation transcript | 3 |
| Semantic-region input | 6 |
| Semantic-region cache envelope | 6 |
| Semantic contribution codec | 3 |

### Revision manifest

The content-addressed manifest is bound to one exact Git tree OID. It records ordered unit shard
addresses, source blobs, reuse eligibility, each unit's exact semantic plan, analysis policy,
provenance, workspace digest, and normalized result digest. Timing, process IDs, RSS, and cache
statistics are observational only.

### Unit shard

A full-unit key covers the exact selected source blobs, selected and inherited configuration
inputs, effective compiler options, realized program inputs, module/type-reference resolution
targets, complete positive and negative lookup evidence, observed package manifests, workspace
boundary decisions, analysis policy, and extractor/runtime provenance.

An exact admitted full-unit hit is preferred. Otherwise the target unit is loaded normally and the
file-grained layer is considered.

### File-grained semantic shard

Each selected source file is independently addressed by:

- its exact Git blob and complete local program-input digest;
- a target-recomputed compiler decision transcript;
- the exact input digest of every directly observed declaration or local-barrel provider;
- the unit's configuration, unattributed compiler/resolver inputs, workspace digest, policy, and
  provenance context.

The transcript observes a conservative superset of decisions used by cached lanes: identifier,
private-identifier, and string-literal bindings; aliases and shorthand value symbols; module
exports; `.register`/`.get` receiver types; and the local re-export files traversed by the same
target-reference seam used during edge resolution. The transcript, not a Git diff or stored
dependency graph, is the propagation fixed point: a provider change rebuilds a consumer only when
the target compiler's actual decision transcript or direct-provider input changes.

Any missing source, incomplete compiler input, unsupported observation, exception, corrupt or
oversized cache entry, or ambiguous ownership falls back to the canonical whole-unit path.

## Cached and fresh lanes

The immutable file payload may supply:

- behavioural and inheritance raw edges;
- value-reference edges;
- export summaries and pending re-exports;
- behavioural, inheritance, and value-reference diagnostics.

The following are always recomputed from the exact target revision:

- structural nodes and final IDs;
- import edges and workspace resolver observations;
- implementation-member edges;
- Promise-resource correlation;
- logic flows;
- ports and RPC/message correlation;
- file and phase ordering;
- cross-package stitching and final graph finalization.

Cached resolved edge targets and export IDs must exist in the freshly built target structure.
Pending re-export ownership must still match the target file. A mismatch fails closed rather than
overlaying stale semantic data. Imports are intentionally absent from the persisted semantic
payload and are reattached from the fresh target pass.

## Invalidation rules

| Target change | Result |
|---|---|
| File content, add, delete, or rename | New or absent file address; rebuild affected file, or the unit if exact ownership cannot be proved |
| Binding, type, exported symbol, alias, or receiver-type decision changes | Compiler transcript changes; rebuild that consumer |
| Direct declaration provider changes | Provider input digest changes; rebuild the observing consumer |
| Recursive local re-export path changes | Every visited barrel is a provider; rebuild affected consumers |
| `tsconfig`, extends chain, compiler options, resolver lookup, or relevant manifest changes | Context or program input changes; rebuild every affected file/unit |
| Workspace/dependency-boundary observation changes | Exact resolver/context input changes; rebuild affected file/unit |
| Provider body-only edit that leaves observed decisions unchanged | Rebuild provider; reuse independent consumers |
| Unobserved non-TypeScript file changes | No TypeScript shard invalidation; revision manifest still binds the target tree |
| Incomplete, external, corrupt, ambiguous, or oversized proof | Rebuild conservatively; publish no reusable miss |

Two different edit sequences reaching the same target tree derive the same addresses. A merge-base
can therefore admit shards once and multiple sibling PR heads can share them without loading the
base and HEAD graphs concurrently.

## Cold oracle and admission

Persistent reuse requires an Ed25519 admission receipt. Shadow mode materializes the candidate and
an isolated empty-cache oracle through the same pipeline, normalizes only explicitly non-semantic
metadata, and compares literal canonical bytes for nodes, edges, call sites, flows, ports, and
diagnostics. Admission also rejects an alleged oracle whose metrics report any reused unit or
region, or anything other than all units/regions rebuilt.

Staged bytes remain untrusted until exact graph, manifest, unit, and semantic evidence parity
succeeds. Admitted mode can read authenticated hits but cannot publish new misses. Corrupt,
receipt-less, forged, or mismatched data is a miss.

This cold extraction is the semantic authority. Hashes, structural invariants, compiler
transcripts, and admission receipts are mechanisms for locating already-proven immutable work;
none independently establish semantic freshness.

## Soundness audit

The audit found and fixed two real omissions:

1. External-edge resolution could recursively traverse a local barrel chain while the initial
   observation recorded only the final declaration. Changing an intermediate re-export from one
   alias to another could preserve the old file key while changing the cold edge. Observation now
   uses the resolver's shared traversal and records every visited local barrel.
2. Target resolution could follow a shorthand property's `getValueSymbol()` inside an unchanged
   provider. Adding an ambient/global declaration could change that value symbol and the resolved
   edge without changing the consumer's ordinary binding observation. The shared target-derivation
   seam now exposes every recursively consumed shorthand lookup, including a missing value, and
   observation binds each result and declaration provider.

Focused regressions and end-to-end admitted-versus-cold cases cover both failures. A separate
materialization/admission audit found no third concrete defect.

The remaining risk is architectural: the observation inventory is manually synchronized with
extractor/checker calls. A new checker query in a cached lane could bypass it. Productionization
should replace this inventory with one shared, instrumented semantic-query facade or an
automatically captured read transcript.

## Real Autopilot benchmark

The final report is
`/private/tmp/meridian-admitted-pr4551-observation-v12-final-report.json`.
It compares base tree `c78cb141a252ae58b4164925aba2f3838e8e104b` with HEAD tree
`ebd2c85d0a03be404a9ad744bcd194975e0b8a09`. Base shadow admission, admitted HEAD, and clean-cache
HEAD ran in separate processes. The signer-bearing request was deleted before the HEAD worker.
The cold HEAD used an empty Meridian cache but inherited the operating system's page cache.

```text
NODE_OPTIONS=--max-old-space-size=8192 \
pnpm --dir packages/extractor-typescript exec tsx \
  src/incremental-poc/real-shared-base-admission-benchmark.ts \
  /private/tmp/meridian-semantic-pr4510-clean.gLOtVe/base \
  c78cb141a252ae58b4164925aba2f3838e8e104b - \
  /private/tmp/meridian-semantic-pr4551-clean.3rGI1T/head \
  ebd2c85d0a03be404a9ad744bcd194975e0b8a09 \
  /private/tmp/meridian-semantic-pr4551-clean.3rGI1T/supplemental-head.json \
  /private/tmp/meridian-admitted-pr4551-observation-v12-final \
  compiler-observations-v12-final --cold-head
```

| Measurement | Result |
|---|---:|
| Clean-cache HEAD extraction | 196.499 s |
| Admitted warm HEAD extraction | 122.596 s |
| Time reduction | 37.61% |
| Speedup | 1.60x |
| Full-unit hits | 25 / 27 (92.59%) |
| Physical file-region hits inside two rebuilt units | 4,342 / 4,728 (91.84%) |
| Effective file reuse across the revision | 5,613 / 5,999 (93.57%) |
| Source-byte reuse inside rebuilt units | 79.67% |
| Warm semantic addressing | 30.358 s |
| Warm canonical fresh extraction lanes | 68.727 s |
| Warm peak RSS | 8,437,317,632 bytes (7.86 GiB) |
| Clean peak RSS | 8,966,144,000 bytes (8.35 GiB) |
| Cache after base admission | 736,696,208 bytes (702.57 MiB) |
| Additional cache bytes published by admitted HEAD | 0 |
| Exact canonical category-byte parity | Passed |
| Concurrent full graphs across revisions | None |

The base shadow itself took 7m15.8s because it intentionally ran and compared both candidate and
cold oracle before signing. That cost remains unacceptable on an interactive path. It is
validation and admission work, not evidence that inline shadowing is production-ready.

The first benchmark attempt exhausted Node's default approximately 4 GiB V8 heap. The successful
run required an enlarged heap and still reached the RSS values above, reinforcing the memory
production blocker.

The earlier package-only benchmark is not a controlled comparison with this final source/runtime.
The valid performance claim is the same-code, same-target admitted HEAD versus its clean-cache HEAD
oracle above.

## Validation

Recorded commands and final outcomes:

| Command | Outcome |
|---|---|
| `pnpm --dir packages/extractor-typescript test` | 50 files, 450 tests passed |
| `pnpm --dir packages/extractor-typescript exec vitest run src/incremental-poc/semantic-compiler-observations.test.ts` | 16 tests passed |
| `pnpm --dir packages/extractor-typescript exec vitest run src/incremental-poc/revision-parity.test.ts src/incremental-poc/revision-sharing.test.ts src/incremental-poc/admitted-reuse.test.ts` | 3 files, 67 tests passed |
| `pnpm --dir packages/extractor-typescript exec vitest run src/unit-contributions.test.ts` | 8 tests passed |
| `pnpm --dir packages/core test` | 23 files, 208 tests passed |
| Focused CLI PR preparation/cache/progress run | 9 files, 180 tests passed |
| `pnpm --dir packages/cli test` with required localhost/process access | 74 files, 808 passed, 3 intentionally skipped |
| `pnpm --filter @meridian/cli exec vitest run --config vitest.e2e.config.ts e2e/pr-review-progress-layout.e2e.ts` | 5 browser tests passed |
| `pnpm --dir packages/renderer test` | 236 files, 2,221 tests passed |
| `pnpm typecheck` | All six workspace packages passed |
| `pnpm build` | Production build and renderer copy passed; existing large-chunk warning only |
| `git diff --check` | Passed |

The parity matrix includes ordinary modification, add, delete, rename, dependency/re-export
boundaries, configuration changes, cold/warm processes, and two histories reaching the same tree.

## Productionization sequence

1. Run shadow differential validation over a broad, version-pinned repository and mutation corpus;
   retain exact mismatch evidence and disable admission on any mismatch.
2. Replace the manual observation inventory with a shared instrumented semantic-query facade/read
   trace used by every cached extractor lane.
3. Profile and shard the remaining 68.7s fresh extraction lanes. Structure/ID construction,
   Promise, flow, and port/RPC work need their own immutable proofs or an explicitly accepted floor.
4. Reduce the 30.4s target-observation/addressing cost and avoid constructing a full Project when an
   exact full-unit manifest hit already proves it unnecessary.
5. Bring peak memory below an operational budget; add cancellation, quotas, lock recovery,
   retention, corruption telemetry, and multi-process/distributed cache behavior.
6. Keep shadow admission off the interactive path. Establish an offline/async admission service
   and a safe policy for revisions without a receipt.
7. Only then design a separate production PR-serving rollout. Do not couple this POC to graph
   registration, leases, renderer hydration, or provisional-graph serving.

Until those steps are complete, keep the feature opt-in and experimental.
