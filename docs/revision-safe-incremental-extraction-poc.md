# Revision-safe incremental TypeScript extraction POC

Status: **implemented and validated as an opt-in POC; revise before production cutover**  
POC baseline: fetched `origin/main` commit
`72c38728cc5d6bb2bef98899ff82546f400b54f7`, tree
`33d6af7b3087ac18980cfacc638433da648cf83b` (2026-07-24)
Performance follow-up baseline: fetched `origin/main` commit
`c4f8d6988d90a08d61d6a9f588be868316ab7b9d`, tree
`766feb757de9186c6e0260d545916d7964f1a32c` (2026-07-27).

> **2026-07-28 follow-up:** the file-grained compiler-observation experiment, current format
> versions, and final Autopilot benchmark supersede this note's earlier shard-version numbers,
> SCC-oriented semantic-region design, and measurements. See
> [revision-safe-file-shard-poc.md](./revision-safe-file-shard-poc.md). The package-shard,
> cold-oracle, admission, retention, and production non-goals below remain relevant.

## Recommendation

Revise before production serving. The hardened POC now has an authenticated
shadow-to-admitted workflow, an exact RepositoryMirror workspace-lease boundary, cross-process
build serialization, bounded reads/enumeration, and scheduled cache retention. Those changes make
`admitted` suitable for opt-in evaluation; they do not authorize a production PR-serving cutover.

The POC proves two useful behaviors:

- exact cached Autopilot base and HEAD revisions are 4.78x and 4.77x faster in new processes and
  produce the same semantic digests as their cold extractions;
- a real PR HEAD reuses 25 of 28 package shards from its merge base and produces the same manifest
  address, exact manifest bytes, ordered unit keys, and semantic digest as an isolated empty-cache
  oracle.

The same PR also exposes the next limit. Its changed `src/aria/app` unit contains 4,528 files and
74% of selected source bytes, so safely reusing 89% of units reuses only 22% of bytes. The final
controlled cross-revision run is only 11% faster, not instant. A production design needs a smaller
compiler-derived semantic unit inside such packages; a Git changed-file list plus ad-hoc neighbor
BFS is not a sound replacement.

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
  -> in shadow/admitted, enter the host-local global build lock
  -> for each unit sequentially:
       construct the ordinary short-lived Project
       fingerprint exact observed compiler/config/filesystem inputs
       enumerate small immutable candidates for that base input
       replay each candidate's recorded workspace-resolver observations
       in shadow/admitted, unique exact match with a valid receipt: decode the unit shard
       no unit match:
         address compiler-derived semantic SCCs against one exact context
         consume only exact admitted or request-private region hits
         run the canonical contribution pipeline for every miss and every fresh global lane
         materialize hit/miss contributions through the ordinary phase schedule
       ineligible/unsafe/oversized semantic proof: run the same pipeline with an empty region map
       re-fingerprint and reject any input movement
       encode and decode the exact persisted representation
       in shadow: stage unit + region bytes for cold-oracle comparison
       in admitted: leave every newly computed miss unpublished
  -> run the ordinary canonical stitch/finalization
  -> reverify exact tree and HEAD commit
  -> in shadow only, publish parity-proven shards plus authenticated receipts
```

### Revision manifest

Manifest schema v2 is content-addressed and bound to the exact Git tree OID. It records:

- workspace topology digest;
- analysis policy and implementation/runtime provenance;
- ordered unit IDs, shard keys, source blob identities, and eligibility;
- the normalized semantic result digest.

Timing, process ID, RSS, cache size, and reuse counters never enter identity.

### Unit and semantic-region shard schema v7

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
  server's deterministic TypeScript executable-closure fingerprint.

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

### Storage, admission, and ownership boundaries

Reusable shard addresses hash base inputs plus the resolver trace. Ineligible diagnostic shards
also include serialized output in their address and are never referenced as hits. Writes use
canonical JSON, payload digests, atomic no-overwrite links, and collision checks. Cache paths are
resolved through existing ancestors and rejected if a lexical path or symlink lands inside the
exact checkout. Every descendant directory is also walked with `lstat`; cache-controlled
directory symlinks and non-regular final entries are rejected, and reads open the final entry with
`O_NOFOLLOW`. This relies on the server owning the canonical cache root; it is not a defense
against a hostile same-user process racing directory replacement.

`extractRevisionCandidate` computes a complete candidate without publishing misses. In authenticated
shadow mode, the harness writes private canonical semantic evidence one category at a time, releases
the incremental graph, materializes the cold oracle through the same pipeline and immutable writer,
and compares literal evidence and shard-envelope bytes with bounded no-follow reads. SHA-256 values
remain diagnostics and receipt bindings; they are not the equality decision. The generic candidate
publisher has no signing capability. The only receipt-publishing API performs semantic, manifest,
and exact ordered shard parity itself immediately before issuing receipts, followed by a second
tree/commit verification. A deliberately poisoned but structurally valid cached output is caught by
the cold oracle.

Cold-oracle admission is authenticated with a host-local Ed25519 authority. The private authority
is atomically created as a private regular file outside the GC-able namespace and remains stable
across server restarts; invalid, symlinked, broadly permissioned, or mismatched key material fails
closed rather than rotating silently. A domain-separated receipt binds:

- admission-receipt and shard-schema versions;
- exact shard key and base-input key;
- the canonical persisted shard payload digest;
- the authority public-key digest.

`shadow` receives the signer capability over private worker IPC. `admitted` receives only the
verifier capability and reuses a shard only when its receipt signature and every bound field match.
Valid pre-receipt hashes are therefore insufficient, key rotation invalidates old receipts, and a
self-consistent forged shard envelope is a conservative miss.

The web integration is server-owned and off by default:

- `empty`: the same shard pipeline with a disposable empty cache;
- `shadow`: builds incremental and cold, requires parity, serves the cold result, and admits only
  exact per-unit matches by writing Ed25519 receipts;
- `admitted`: reuses only receipt-authenticated shards, computes canonical misses, and deliberately
  publishes neither those misses nor a revision manifest;
- `verified-experimental`: directly exercises the persistent cache for local performance testing.

The HTTP client cannot provide tree, cache, build, runtime, or policy identity. The private worker
transport receives those fields only after the server resolves an exact repository root and Git
tree. For `shadow` and `admitted`, the canonical root and resolved HEAD commit must also match an
active exact RepositoryMirror workspace lease. A missing, released, wrong-commit, or wrong-root
lease falls back to the ordinary canonical extractor without touching the shard cache. The
extractor independently checks the clean tree and HEAD before extraction and again before
publication. This binds normal service use to an owned exact-revision workspace; it is not a
defense against a hostile same-user process performing an ABA mutation inside that workspace.

Each shard-enabled child recomputes the exact installed TypeScript extractor subtree and its
complete declared runtime dependency closure before extraction and again afterward; it fails closed
if either differs from the parent-bound policy. This deliberately excludes unrelated CLI,
renderer, and Python bytes while retaining the executable extractor, `@meridian/core`, schema,
`ts-morph`, TypeScript, and transitive runtime packages. Source-mode children also run from the
fixed CLI package directory with the fixed CLI `tsconfig`, strip ambient `NODE_*` injection and
every inherited `TSX_*` setting, and install only the explicit loader/configuration. Semantic
ordering uses locale-independent code-point comparison, so host locale cannot change graph or
shard bytes.

The CLI-to-extractor bridge is a closed data boundary, not a manual invalidation list. The
extractor classifies every `ExtractOptions` key at compile time: exact root, shard-disabling
`project`/`include`, separately fingerprinted supplemental files, non-semantic progress, or the
complete fingerprinted analysis policy. An added option fails typecheck until it is classified.
The raw shard is stored inside the TypeScript extractor before CLI merging, tagging, boundary
materialization, artifact stamping, and validation; those later stages remain covered by the
whole-artifact analysis identity rather than the shard identity.

`shadow` and `admitted` share the `shadow-admitted` namespace and the same host-local global build
lock. The lock serializes memory-intensive shard builds across Meridian processes, heartbeats a
host/PID/process-start/nonce owner, and fences work if ownership is lost. Stale recovery first
publishes a separate claim that every acquisition checks before and after owner establishment,
then revalidates the exact directory inode and owner bytes after quarantine. An ambiguous or
interrupted recovery remains fenced for explicit repair rather than stealing a replacement or live
generation. Background retention uses a non-blocking attempt at that exact lock, so it skips rather
than racing or queueing behind an active build.

Cache reads cap candidate references at 4 MiB, admission receipts at 64 KiB, unit shards at
512 MiB, and variants for one base input at 128. An oversized entry, overloaded candidate
directory, malformed envelope, corrupt receipt, missing support file, or unsafe link becomes a
conservative miss in admitted mode. Shadow may repair an unadmitted corrupt/colliding shard,
candidate, or receipt by quarantining the old entry and writing the parity-proven replacement; it
will not overwrite a conflicting shard that still has a valid admission.

The scheduled `shadow-admitted` retention pass starts after 60 seconds and then runs hourly. It
uses an 8 GiB high/6 GiB low watermark, a 30-day idle lifetime, and a hard 500,000-entry scan bound.
It removes dangling support entries first, treats a unit shard with its candidates and receipts as
one eviction group, and treats each semantic context with all of its region shards and supports as
one dependency-ordered cluster. Receipt-less failed shadow staging is orphaned. It removes
candidates and receipts before payloads and semantic contexts last, quarantines before unlink,
drains crash trash without following links, and removes only exact interrupted immutable
publication temporary names.
Lone temporary payloads are reclaimed; a temporary/final hardlink pair is reduced to its canonical
link before accounting. Symlinks and lookalike names remain untouched. The pass skips when the
cache root, trash root, scan bound, or exclusive coordination cannot be proven safe. `empty` is
disposable; `verified-experimental` is intentionally outside this admitted-cache maintenance claim.

The population workflow is explicit: run an exact revision in `shadow`, let the empty-cache oracle
establish graph and per-unit parity and issue receipts, then run that revision or a related revision
in `admitted`. An admitted miss remains useful for the current graph but does not become reusable
until a later shadow run proves and signs it.

### Semantic-region POC

The finer-grained layer is now wired into the same candidate, pair-exchange, shadow admission,
canonical stitch, and retention pipeline as whole-unit shards. It does not use folders or a Git
changed-file queue as a semantic boundary. For each already-loaded unit it derives a directed
TypeScript dependency graph, collapses strongly connected files into immutable regions, and
addresses providers before consumers. A provider edit recursively changes its consumer keys; a
consumer-only edit leaves independent providers reusable.

One immutable context record contains every input that is not safely local to a region:

- exact unit/configuration/compiler options and non-local realized program inputs;
- non-local module/type-reference resolutions and all resolution lookup state;
- analysis policy and executable/runtime provenance;
- exact workspace topology; and
- planner/evidence versions.

Each region key contains its exact source blob and realized program identities, its containing-file
module/type-reference resolutions, the context digest, and the exact keys of its direct provider
regions. This recursive construction invalidates consumers for implementation changes without
pretending that a public-API hash is sufficient.

The cached payload is deliberately narrower than a file or module graph. It stores only ordered
per-file behavioural, inheritance, import, and value-reference raw edges with call sites,
relationship diagnostics, and export/re-export summaries. Structural nodes, implementation
members, Promise correlation, logic flows, ports/RPC/message-dispatch correlation, target order,
cross-package resolver observations, and final stitching are recomputed from the exact current
program. The canonical contribution materializer uses the same phase order for hits and misses.
Even on a region hit the inexpensive import observation pass runs for every current source so the
whole-unit workspace-resolver trace remains complete.

Region data uses a strict bounded codec and context-scoped layout:

```text
semantic-region-contexts/<prefix>/<context-digest>.json
semantic-region-shards/<context-digest>/<prefix>/<region-key>.json
admissions/<authority-key>/<prefix>/<region-key>.json
```

Admitted reads authenticate the small receipt before opening the larger shard and then bind the
receipt to the actual payload digest. Request-private merge-base-to-HEAD reuse needs no receipt and
is deleted after the pair settles. Pair-consumed envelopes are retained in the candidate so later
shadow publication does not depend on the temporary directory.

Shadow compares the complete graph plus exact region context/shard bytes against an empty-cache
oracle before issuing receipts. A full-unit hit may bypass the region layer, so region evidence is
checked as a canonical multiset subset of the cold evidence; every evidence item that is present
must still be byte-identical. Corrupt context, shard, or receipt data is repairable only inside the
exclusive shadow transaction. Resource ceilings are typed availability conditions: an oversized
legitimate context/SCC/payload reruns the exact unit with an empty region map, publishes no region
evidence, and records a conservative whole-unit fallback. Malformed identities or cache contents
remain hard failures outside admitted conservative-miss handling.

Retention treats a context, every region below it, and their candidate/admission supports as one
cluster. It deletes supports before payloads and the context last; any failed support/payload
quarantine preserves its dependants. Receipt-less clusters and missing-context regions are
reclaimed, duplicate region keys across contexts fail the sweep closed, and the partition assertion
requires every scanned path and byte to belong to exactly one eviction unit.

The remaining soundness boundary is explicit. Dependency discovery proves an over-approximation
from TypeScript's complete resolved-module graph, triple-slash referenced sources, and all-to-all
script/global/module-augmentation/UMD providers. It labels the symbol/type/extractor-read classes
that external-module scoping says must enter through those edges. The current test corpus exercises
the known escapes, but this is not direct per-pass checker-read instrumentation. Consequently the
semantic-region path remains an opt-in POC and must continue through shadow/cold-oracle admission
until a representative corpus has zero unexplained mismatches or the dependency theorem is replaced
with observed read attribution.

## Invalidation behavior

| Change or condition | Behavior |
|---|---|
| Modify/add/delete/rename selected TypeScript | Reuse unchanged semantic regions only when the target program proves the same recursive region key; otherwise rebuild the owning unit. |
| Provider implementation/export/type changes | Rebuild the provider region and every reverse-transitive consumer; preserve independent providers. |
| Consumer-only implementation changes | Rebuild its region; preserve provider regions whose recursive inputs are unchanged. |
| Script/global, `declare global`, module augmentation, or UMD namespace changes | Conservatively invalidate every region in the affected unit through the ambient-provider closure. |
| Cross-package provider export changes while a consumer unit has a stable pending reference | Reuse the consumer unit contribution and rerun the current global stitch. |
| New unrelated supplemental package | Build only the new unit; reuse existing units whose structural and resolver observations still match. |
| New package satisfies an old bare/relative/alias lookup | Rebuild the observing unit because trace replay differs. |
| Root config used by all units changes | Rebuild all consumers of that config. |
| Package-local config or local extends file changes | Rebuild only units selecting that chain. |
| Imported tracked JSON changes | Rebuild units whose realized program contains it. |
| Unobserved non-TypeScript file or irrelevant tracked symlink changes | Reuse unit shards; the target revision remains separately tree-bound. |
| External/untracked compiler, config, manifest, or resolution input | Rebuild every run; never admit a reusable candidate. |
| Missing, corrupt, forged, wrong-key, or wrong-payload admission receipt | Treat the shard as a miss; admitted mode computes but does not publish the replacement. |
| More than 128 candidate variants for one base input or an oversized cache entry | Conservatively rebuild the unit without allocating the unbounded entry. |
| Legitimate semantic context/SCC/payload exceeds its codec/cache ceiling | Rerun the exact whole-unit contribution pipeline with an empty region map and publish no semantic evidence. |
| Shadow encounters corrupt unadmitted immutable data | Quarantine the old entry under the exclusive build lock, publish the cold-parity replacement, and issue a new receipt. |
| Admitted/shadow root lacks a matching active exact-workspace lease | Fall back to the ordinary canonical extractor; do not read or write the shard cache. |
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

Hardened admission and lifecycle suites additionally cover:

- exact Ed25519 receipt verification with a verifier-only capability, changed identity fields,
  malformed/overprivileged capabilities, and authority-key rotation;
- a forged self-consistent shard envelope, valid pre-receipt data, corrupt-receipt repair, and the
  rule that admitted misses never publish;
- atomic authority convergence across concurrent creators and restarts, private permissions, and
  symlink/invalid-key failure;
- exact Git-root/tree/commit selection plus active RepositoryMirror lease, wrong/released lease,
  subdirectory fallback, and out-of-band worker policy injection;
- global-lock serialization, cancellation, non-blocking maintenance, dead-owner recovery,
  live-owner protection, ownership fencing, host isolation, and unsafe topology;
- 8/6 GiB hysteresis, idle/orphan/LRU selection, support-before-shard deletion, crash-trash
  draining, no-follow traversal, bounded scans, and scheduler shutdown.

## Real Autopilot evidence

Environment: macOS arm64, Node 26.2.0, production 8 GB heap, separate exiting processes, product
TypeScript policy, benchmark version `production-hardening-final-20260727-v2`. All five processes
exited successfully and ran serially. The app was stopped for the measurement, and the shared-cache
runs never held the base and HEAD full graphs concurrently.

Exact revisions:

- merge base commit `9569676c8c7bd5d3573773113643fdf2c5fd9270`, tree
  `140d4d93f1d5564219c46ba1ebbc586a6bcb8e99`;
- PR #4472 HEAD commit `91ad7ee0cd1d954e4f278354efb2240ea206834d`, tree
  `0c4d903fcbeaee0c6aa9a95e876e96d6044a1649`;
- 43 non-deleted supplemental TypeScript paths, yielding 27 base units and 28 HEAD units.

| Scenario | Wall / pipeline | Fingerprint | Extraction | Reuse | Byte reuse | Max RSS | Logical cache |
|---|---:|---:|---:|---:|---:|---:|---:|
| Base cold | 258.37 / 248.613 s | 33.543 s | 164.696 s | 0/27 | 0% | 7.741 GB | 474,287,240 B |
| Base warm, new process | 54.08 / 52.598 s | 38.895 s | 0 s | 27/27 | 100% | 6.520 GB | 474,287,240 B |
| HEAD from warm base | 262.09 / 254.271 s | 49.064 s | 147.058 s | 25/28 | 21.817% | 7.531 GB | 858,415,122 B shared |
| HEAD empty-cache oracle | 295.76 / 285.221 s | 46.291 s | 175.812 s | 0/28 | 0% | 8.071 GB | 488,552,132 B |
| HEAD warm, new process | 61.98 / 60.519 s | 46.048 s | 0 s | 28/28 | 100% | 6.488 GB | 858,415,122 B shared |

`Max RSS` is macOS `/usr/bin/time -l` maximum resident set size; the harness-reported peaks were
7,468,974,080, 6,519,947,264, 7,259,291,648, 7,338,000,384, and 6,487,638,016 bytes in table order.
Stitching was only 0.322-0.430 seconds.

Base warm is 79.0688% faster (4.7776x). Cross-revision HEAD is 11.3842% faster (1.1285x) than its
exact cold oracle. Warm HEAD is 79.0438% faster (4.7719x). The shared base-plus-HEAD cache uses
858,415,122 logical bytes versus 962,839,372 bytes for isolated base and HEAD caches, saving
104,424,250 bytes (10.8454%); allocated disk saves 104,542,208 bytes (10.8548%).

The base digest is
`24ef0007583ddc22a243a6b0247fb1fe2691a8c6a44616f4894da433b819a45f`.
Both HEAD runs produce
`cbe4625e63b35788b2fd2e5bf5077bb6d67f6481cbcf852cb7a044ce44d31840`,
the same manifest address
`02a88c61e44625bff539b60ebc75eb9b7c7e7057e3ebc0891eb0384d14c7efbe`,
literal manifest bytes, and the same ordered 28 shard keys. `cmp` succeeded for both exact files;
their manifest-byte SHA-256 is
`aefa1f9abd10d98f224519dc951676353225c73a4e6c93cda81e6ee71b1588e7`,
and the two ordered unit-key TSVs both hash to
`7e6e8b654f86c689f59512c0d48154f90770e2941177d10bf5e6c0acced2566f`.

The three rebuilt HEAD units are exactly:

- changed `src/aria/app`;
- unchanged `src/packages/autopilot-delegate-iframe`, whose compiler program observes changed app
  inputs;
- newly admitted `src/packages/autopilot-delegate-web`.

The other 25 existing units reuse the base shards. This matches the independent workspace-input
audit.

The raw JSON, `/usr/bin/time` logs, disk measurements, parity log, and ordered unit-key evidence are
under `/private/tmp/meridian-autopilot-final-output.tayWIe`; cache A is
`/private/tmp/meridian-autopilot-final-cache-a.khUU3Q` and isolated cache B is
`/private/tmp/meridian-autopilot-final-cache-b.yvKPR6`.

Each process used this exact command shape, with no overlap:

```text
NODE_OPTIONS=--max-old-space-size=8192 /usr/bin/time -l \
  pnpm --dir packages/extractor-typescript exec tsx \
  src/incremental-poc/real-workspace-benchmark.ts \
  <exact-workspace> <exact-tree> <cache> \
  production-hardening-final-20260727-v2 [supplemental-json]
```

Runs 1-2 used the comparison workspace/tree and cache A without supplemental paths; runs 3-4 used
the HEAD workspace/tree, cache A, and
`/private/tmp/meridian-autopilot-pr4472-supplemental.json`; run 5 used those exact HEAD inputs with
cache B. Stdout and `/usr/bin/time` stderr were redirected to the corresponding `01` through `05`
files under the raw-output directory above.

### Real web-service path

The same open Autopilot PR #4472 was then exercised through `/api/pr/prepare`, exact
RepositoryMirror leases, private worker IPC, artifact publication, renderer restoration, and the
browser:

| Service run | Duration | Progress events | Result |
|---|---:|---:|---|
| `shadow`, forced pair refresh | 22m 05s | 988 | HEAD and merge base each passed the empty-cache TypeScript oracle; 59,970 nodes and 230,792 edges |
| `admitted`, forced pair refresh after shadow | 3m 18s | 63 | TypeScript hits emitted project-load/fingerprint phases but no structure/relationship traversal; same node/edge counts |
| New server process, `admitted`, normal cache policy | 2m 34s | 62 | Persisted authority and 30 receipts reused all 30 unique base/HEAD TypeScript shards across restart; same counts |
| Exact pair repeat in that final process | 1.38s | 1 | Single `done` event, `cache:"hit"`, identical HEAD and comparison graph IDs |

Pair cache slots continue to include the current base-tip SHA so live target movement is always
revalidated. The materialized graph identity instead uses the exact semantic merge base: when only
the target tip advances and both HEAD and merge base remain unchanged, verified immutable
whole-revision objects are republished into the current pair without analysis, and both graph IDs
remain stable. A landing-prepare to live-analyze regression covers that handoff. This prevents both
duplicate extraction and a redundant renderer HEAD decode/index pass while retaining the new base
tip in pair metadata and the streamed result.

The shadow-admitted namespace contains exactly 30 shard files, 30 admission receipts, and two
revision manifests: 27 base units plus 28 HEAD units minus 25 shared shards. It occupies 819 MiB by
`du`. The final persistent process runs on `127.0.0.1:4187` in tmux session
`meridian-app-99f9` with `--typescript-incremental admitted`,
`--experimental-pr-revision-cache`, and no forced refresh. The latter remains loopback-only and
process-scoped; it is evidence for this POC, not a production default.

The in-app browser observed one canonical five-step model on renderer restoration and the same
HEAD/merge-base lanes and formatter used by landing preparation. Live examples included
`PR HEAD 91ad7ee · TypeScript · review graph 1/2 · unit 2/28 · file 3303/4528` and merge-base Python
`review graph 2/2 · file 849/1043`. The fixed-height card did not jump when paths or activities changed.
The final review rendered 21 changed graph files, affected logic flows, added/deleted symbols,
blast-radius counts, and submission controls.

### Concurrent cold-pair evidence

Package-shard reuse and pair scheduling are independent. As an explicit loopback-only
`--typescript-incremental admitted` canary, when both exact populated revisions miss, the same cold
pipeline can run in two disposable workers after one atomic two-slot reservation. The default
server and every other shard mode remain sequential. This does not extract intermediate commits. It
evaluates exactly HEAD and merge base, then publishes nothing until both immutable artifacts
complete.

On PR #4472, a one-slot forced-refresh oracle completed in 571.364 seconds. The two-slot path
completed in 321.905 seconds, a 43.66% wall-time reduction, with 12.826 GiB sampled aggregate peak
RSS. A frozen-final-build repetition completed in 342.797 seconds with 13.407 GiB peak RSS. The
automatic policy reserves each worker's configured heap plus 25% native overhead, retains 2 GiB for
the parent/OS, caps automatic concurrency at two, and therefore falls back to the sequential
pipeline on smaller hosts.

After normalizing only `generatedAt`, complete HEAD and merge-base artifact files were byte-identical
between concurrent, sequential, and final-build runs. Their normalized SHA-256 values are
`19e633d9ef55a8a5c6e96a377b6150f03574f7920ec1d1c9fe8dcb1d8f3f9c00` and
`fef88370ea99a0e08d6d32dcdfc6e73a027f9856315d05fec87c81cca3095375`.
The stronger whole-file comparison includes every graph extension and ordering decision.

The admitted-cache fence remains group-exclusive across processes, but two authenticated read-only
children may execute inside one held group. A non-blocking two-slot/fence attempt prevents a pair
from occupying worker capacity while waiting on another process. The elastic fallback alternates
local-first and fence-first acquisition, probes the second resource without waiting, and releases
the first resource before retrying when the probe fails. Fence-first waits enter a separate
capacity-one process-local admission with a bounded FIFO, so at most one request polls the
filesystem fence and excess prepared requests fail with retryable overload after discarding their
stage/workspace. It therefore neither holds the host fence while queued for local capacity nor
holds local capacity while queued for the fence; non-blocking local admission also refuses to
bypass queued FIFO work. Tests compose sustained waiting PR arrivals with unrelated trailing work,
cover both resource-ordering directions, process-local FIFO/overload/cancellation/close cleanup,
and first-failure sibling abort/drain. `shadow` stays sequential because it stages and publishes
oracle evidence.

The safe RPC no-candidate gate reduced the dominant app unit's observed ports-to-exports segment
from 29.3-30.9 seconds to 16.1-16.5 seconds without changing either normalized artifact. A proposed
admitted-miss codec shortcut was removed because mixed hit/miss object ordering changed raw artifact
digests even though semantic digests matched. Artifact/graph-ID identity remains the acceptance
boundary.

## Proven versus assumed

Proven by tests and the real benchmark:

- immutable unit reuse across processes and revisions;
- complete cold-oracle parity for the fixture mutation matrix, with literal disk-backed semantic
  and immutable shard-envelope comparison before admission;
- verifier-only reuse of exact Ed25519-admitted shard payloads, with forged or pre-receipt data
  conservatively rebuilt;
- generic publication cannot issue receipts, and the sole receipt publisher performs semantic,
  manifest, and ordered unit parity internally;
- admitted misses remain unpublished, while a later shadow run can quarantine and repair corrupt
  unadmitted cache data;
- safe web modes require an active exact RepositoryMirror lease matching canonical root and HEAD;
- cross-process builds and retention share one fenced host-local lock, and the admitted namespace
  has bounded reads, candidate enumeration, scheduled retention, and no-follow quarantine;
- real base/HEAD convergence on exact semantic digests, manifests, and shard keys;
- source workers pin cwd/tsconfig, strip ambient loader settings, and recompute the TypeScript
  executable closure/runtime provenance before and after extraction;
- unrelated topology does not invalidate every unit, while observed topology does;
- canonical cold and incremental paths use the same reducer, codec, stitcher, and finalization;
- two revisions share on-disk shards without concurrent full-graph residency;
- memory-admitted concurrent HEAD/merge-base extraction produces exact normalized artifact bytes
  and reduces the controlled cold pair by 43.66%.

Still assumptions or production blockers:

- the exact RepositoryMirror lease closes ordinary service eviction/rebinding races, but a hostile
  same-user process can still attempt an ABA mutation despite start/end tree, byte, and commit
  checks;
- a hit still constructs the full short-lived TypeScript Project to prove its fingerprint, so warm
  runs retain 6.49-6.52 GB measured maximum RSS and 38.9-46.0 seconds of fingerprint work;
- the large app unit is too coarse for small PRs;
- external package-manager state, generated declarations, plugins, and custom hosts are
  conservatively ineligible rather than hermetically modeled;
- Ed25519 receipts prove admission by this host-local oracle authority, not that the authority file,
  build host, dependency installation, or broader operating environment was uncompromised;
- the global lock deliberately serializes shadow/admitted groups across processes. One admitted
  group may contain two memory-accounted workers; the persistent admitted namespace remains
  read-only while those workers may exchange canonical misses through one request-scoped directory.
  Shadow stays sequential. This can still increase queue time, and it is not distributed locking
  for a multi-host cache. A crashed or ambiguous recovery claim intentionally requires explicit
  operator repair rather than automatic ownership theft;
- retention is implemented only for the `shadow-admitted` TypeScript namespace. The separate PR
  pair and whole-revision artifact caches still have process-nonce orphan growth, no byte handoff
  lease, and no quota/GC;
- corpus-wide parity, multi-request throughput, and operational failure rates are not yet known.

The isolated cold HEAD reached 8,071,479,296 bytes maximum RSS. The 8 GB V8 heap reservation is
therefore an operational requirement for this corpus, not comfortable production headroom.

The cold extraction remains the semantic authority. Hashes, trace replay, and invariants are reuse
proof inputs, not a substitute for differential evidence.

## Productionization sequence

1. Run `shadow` across representative repositories and persist categorized parity/admission,
   conservative-miss, repair, lock-wait, and retention results. Shadow must continue serving the
   cold result.
2. Use `admitted` only after the exact revision or relevant shard population has passed shadow.
   Monitor receipt-hit ratio and always keep canonical misses out of the persistent namespace.
   A two-worker exact pair may exchange a miss only through its private, drained-and-deleted
   request directory after complete input and resolver-trace equality.
3. Add bounded, cross-process-safe retention and an artifact-byte handoff lease to the separate PR
   pair/revision caches before enabling cross-pair whole-graph reuse outside loopback experiments.
4. Replace hit-time Project construction with a Git/config/dependency manifest that proves the
   same inputs without loading compiler state.
5. For dominant packages, derive smaller immutable compiler-semantic regions and reverse
   dependencies from actual resolution/checker observations. Rebuild to a fixed point and keep the
   full cold oracle. Do not infer safety from textual Git neighbors alone.
6. Move from a merely same-user-private checkout to a stronger immutable dependency/filesystem
   snapshot if the production threat model includes a hostile peer process.
7. Extend corpus coverage for project references, package managers, generated files, ambient
   types, custom resolution, flows, ports, authority recovery, process crashes, and cache pressure.
8. Canary the two-worker pair path with aggregate RSS, queue/fence wait, cancellation, and
   throughput telemetry; capacity-one behavior must remain the automatic fallback.
9. Only after zero unexplained shadow mismatches and acceptable latency/memory/disk/queue results,
   plan a separate production PR-serving and cache-admission cutover.

## Validation log

Semantic-region follow-up on the final pre-benchmark source:

```text
pnpm --dir packages/extractor-typescript test
  45 files, 380 tests passed

pnpm --dir packages/extractor-typescript exec vitest run \
  src/incremental-poc/admitted-reuse.test.ts
  25 admitted-versus-cold scenarios passed

pnpm --dir packages/extractor-typescript exec vitest run \
  src/incremental-poc/semantic-regions.test.ts \
  src/incremental-poc/semantic-region-inputs.test.ts \
  src/incremental-poc/revision-parity.test.ts
  3 files, 31 tests passed

pnpm --dir packages/extractor-typescript exec vitest run \
  src/incremental-poc/semantic-region-codec.test.ts \
  src/incremental-poc/semantic-region-extraction.test.ts
  isolated results: 21 codec tests and 6 availability/parity tests passed

pnpm --dir packages/cli exec vitest run \
  src/typescript-revision-shard-runtime-fingerprint.test.ts \
  src/server/repository-analysis-child.test.ts \
  src/server/repository-analysis-worker-job.test.ts \
  src/server/web-analysis-coordinator.test.ts \
  src/server/web-pr-analyze.test.ts \
  src/server/web-pr-cache.test.ts \
  src/server/web-typescript-revision-shards.test.ts \
  src/server/web-typescript-revision-shard-retention.test.ts \
  src/server/web-typescript-revision-shard-retention-scheduler.test.ts
  9 files, 173 tests passed

pnpm --dir packages/cli exec vitest run \
  src/server/web-typescript-revision-shard-retention.test.ts \
  src/server/web-typescript-revision-shard-retention-scheduler.test.ts \
  src/server/web-typescript-revision-shards.test.ts
  3 files, 41 tests passed

pnpm --dir packages/extractor-typescript typecheck
pnpm --dir packages/cli typecheck
git diff --check
  passed
```

The admitted corpus includes ordinary modification/add/delete/rename, configuration and re-export
changes, two histories reaching the same tree, process-cold/warm reuse, `declare global`, string
module augmentation, type-only inferred receivers, compiler triple-slash path directives, classic
JSX factory resolution, cross-file declaration merging, and UMD globals. Each case compares the
complete normalized graph, canonical manifest and unit envelopes, and every present semantic
context/region evidence item against an isolated empty-cache target.

Pair-unit co-scheduling and elastic-admission follow-up:

```text
pnpm --dir packages/extractor-typescript test
  40 files, 328 tests passed

pnpm --dir packages/cli exec vitest run --exclude src/server/folder-dialog.test.ts
  73 files, 785 tests passed and 3 intentionally skipped

pnpm --dir packages/cli exec vitest run src/server/folder-dialog.test.ts
  1 file, 5 tests passed

pnpm --dir packages/cli exec vitest run \
  src/server/web-analysis-coordinator.test.ts \
  src/server/web-pr-cache.test.ts
  2 files, 56 tests passed

pnpm --dir packages/extractor-typescript typecheck
pnpm --dir packages/cli typecheck
git diff --check
  passed
```

The semantic-region planner has six focused tests covering deterministic SCCs, provider/consumer
invalidation direction, missing-evidence fallback, deletion fallback, invalid endpoints, and an
iterative 4,528-file chain. It is included in the 328-test extractor result; the large-chain plan
completed in 18 ms in the focused run.

The cross-process tests use two real exact Git worktrees and fresh Node processes. With three units
per revision, identical trees performed three total canonical unit builds rather than six. Trees
with one divergent unit performed four total builds and two pair reuses rather than six builds.
Both complete extraction results and both manifests were canonical-JSON identical to independent
empty-cache runs. The server regression holds an active pair on both analysis slots and the shard
fence, queues a second pair, and proves that the second starts with two workers after release.
Sibling failure abort/drain also leaves the pair-exchange staging root empty.

Independent final-diff review found and closed two additional lifecycle gaps:

- a request that waited for slots/fence now re-verifies still-missing exact HEAD/merge-base objects
  after joint admission. If an earlier pair published the same revision while it waited, it starts
  zero or one remaining worker rather than using the stale pre-queue miss. Reuse stages are emitted
  only for late hits and lane-complete only for actual extraction;
- a candidate that consumed a pair-only shard retains the exact immutable envelope in its
  publication set. Deleting the pair directory before generic publication still produces a
  self-contained manifest whose every shard and candidate reference resolves byte-for-byte, and a
  later run reuses all three fixture units.

A rebuilt persistent service then prepared live Autopilot PR #4510 at exact HEAD
`e19cd50df6cc41b2c8989b669c1c6ac81a8ef0b3` and merge base
`f59c9e11d7aa931b2eca13ed6cd08ddcdc3b5667`. This was a new-process whole-pair miss with the
previously admitted shard namespace retained, not a completely empty semantic cache:

| Observation | Result |
|---|---:|
| Clone visible | 1.095 s |
| Both exact extraction lanes visible | 5.192 s |
| HEAD lane complete | 275.563 s |
| Merge-base lane / pair complete | 277.072 s |
| Immediate exact-pair repeat | 1.520 s, one `done` event |
| Result | 60,582 nodes, 234,221 edges, identical cold/warm graph IDs |

Across the two 27-unit TypeScript revisions, progress showed seven canonical structure traversals:
four on the merge base and three on HEAD. Only the large app and iframe units traversed on both
sides; one-side-only and previously admitted units avoided the other traversal. The run was about
22% faster than an earlier 5m54 observation of the same pair, but that comparison was not controlled
for host/runtime noise and is corroboration only. The main result is diagnostic: authenticated
package reuse and pair co-scheduling work, yet two changed large units still dominate the 4m37
critical path. A finer sound semantic boundary and cheaper hit proof remain necessary.

Frozen-source final validation:

```text
pnpm --filter @meridian/extractor-typescript exec vitest run \
  src/incremental-poc/differential.test.ts \
  src/incremental-poc/exact-file-parity.test.ts \
  src/incremental-poc/admitted-reuse.test.ts
  3 files, 24 tests passed

pnpm --filter @meridian/cli exec vitest run \
  src/analysis-runtime-fingerprint.test.ts \
  src/server/repository-analysis-child.test.ts \
  src/server/repository-analysis-worker-job.test.ts \
  src/server/web-typescript-revision-shards.test.ts
  4 files, 38 tests passed

pnpm --filter @meridian/cli exec vitest run \
  src/server/web-typescript-revision-shard-lock.test.ts \
  src/server/web-typescript-revision-shard-retention.test.ts \
  src/server/web-typescript-revision-shard-retention-scheduler.test.ts \
  src/server/web-typescript-revision-shard-authority.test.ts
  4 files, 39 tests passed

Real Autopilot base cold/warm, HEAD shared-base, HEAD isolated oracle, and HEAD warm
  5 separate, non-overlapping process runs passed with the metrics and exact parity above

pnpm --dir packages/extractor-typescript test
  39 files, 318 tests passed

pnpm --dir packages/cli test
  saturated full pool: 73 files and 789 tests passed; one unrelated folder-dialog child-start
  fixture missed its fixed 2-second deadline

pnpm --dir packages/cli exec vitest run --exclude src/server/folder-dialog.test.ts
pnpm --dir packages/cli exec vitest run src/server/folder-dialog.test.ts
  clean split: 73 files / 785 passed and 3 skipped; isolated file / 5 passed

pnpm --dir packages/core test
  23 files, 207 tests passed

pnpm --dir packages/renderer test
  236 files, 2,220 tests passed

pnpm --dir packages/cli typecheck
pnpm --dir packages/extractor-typescript typecheck
pnpm --dir packages/core typecheck
  all passed

pnpm build
  all package builds and renderer copy passed; existing renderer large-chunk warning remains

pnpm --dir packages/cli exec vitest run \
  --config vitest.e2e.config.ts e2e/pr-review-progress-layout.e2e.ts
  1 file, 4 tests passed

git diff --check
  passed
```

The unpartitioned CLI suite again had only one failure:
`folder-dialog.test.ts` missed its fixed 2-second child-start deadline under the saturated parallel
pool. The exact suite passed alone in 0.34 seconds; the complete remaining 73-file suite passed
cleanly. This is recorded as a test scheduling flake, not a product failure or a reason to change
the unrelated picker contract.

Earlier unchanged-package coverage in this worktree also passed core (23 files/205 tests), Python
extractor (9 files/54 tests), and renderer (236 files/2,203 tests). The frozen-source gates above
cover every package modified by the final hardening.

The complete workspace validation commands and outcomes are also recorded in
`docs/pr-review-loading-optimization.md`.
