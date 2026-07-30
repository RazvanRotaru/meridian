# PR review direct preparation and exact-revision reuse

Status: **implemented and validated locally; revise before production admission**  
Baseline inspected before implementation: `origin/main`
`72c38728cc5d6bb2bef98899ff82546f400b54f7` (2026-07-24)
Performance follow-up inspected fetched `origin/main`
`c4f8d6988d90a08d61d6a9f588be868316ab7b9d` (2026-07-27).

This note is intentionally separate from the TypeScript incremental-extraction POC. This change
can reuse a complete immutable graph for an exact revision. The per-package TypeScript shard
pipeline is now available inside exact PR extraction only through explicit server-owned
`empty`, `shadow`, `admitted`, or `verified-experimental` modes; it does not change the whole-graph
pair/revision cache's lifecycle or make either cache a production default.

## Current-main diagnosis

The selected-PR path did perform redundant work:

1. The Git integration page called `/api/generate` for the PR base branch and waited for that graph.
2. It navigated to the generated base-tip graph with `prn=<number>&rev=1`.
3. Renderer URL restoration then called `/api/pr/analyze`, which resolved the live PR refs and
   prepared another graph for the exact HEAD plus one for Git's exact merge-base.
4. The renderer downloaded and indexed those review artifacts before it could project the review.

For a repository-wide selection, step 1 was a repository-wide extraction whose graph was only a
bootstrap authority for step 3. It was not the semantic comparison graph unless the base tip
happened to equal the merge-base. Different PR-pair cache entries could also extract the same
merge-base independently, which explains why a second sibling PR could navigate quickly but remain
in the opaque loading screen for minutes.

## Direct preparation flow

```text
selected PR snapshot
  -> POST /api/pr/prepare(repository, PR number, base ref, head ref, selected HEAD SHA)
  -> resolve exact remote HEAD and base; reject if selected HEAD already moved
  -> run the ordinary PR pair pipeline
       exact HEAD artifact
       exact merge-base artifact (extract, or experimental verified revision-cache hit)
  -> publish/register the immutable pair
  -> navigate to /view?id=<HEAD graph id>&prn=<number>&rev=1
  -> boot and index that exact HEAD artifact
  -> re-resolve live refs through POST /api/pr/analyze
       same HEAD graph id: reuse the boot artifact and its existing index; load only comparison
       different graph id: lease, load, validate, and atomically install the new exact pair
  -> project the review
```

The second analysis request is deliberate. Direct preparation removes the redundant base-tip
extraction and makes navigation exact for the picker snapshot; renderer restoration re-resolves
both moving refs so a force-push or base update between preparation and display cannot silently
open stale content. The normal exact-pair cache makes the unchanged case a verified hit without
another extraction.

Renderer HEAD reuse has one rule: the live result's immutable graph ID must exactly equal the boot
graph ID. It then reuses both the already-decoded artifact and its index, and does not fetch HEAD
graph bytes or HEAD execution metadata again. Any ID change follows the ordinary two-artifact
load/swap path. Graph-view leases cover the pair before either new artifact is installed.

## Canonical revision caches

The cross-pair whole-revision cache is now separately gated by
`--experimental-pr-revision-cache`. It is off by default, may be enabled only on a loopback host,
and cannot be selected by an HTTP request. With the flag off, new pair snapshots keep both artifacts
pair-local, and the read path rejects an older pair snapshot that contains shared-revision
references rather than silently traversing an earlier experimental store.

When that flag is explicitly enabled, two strict immutable roles are eligible:

- A normal, populated comparison revision is branch-neutral: `changedSince: null`, no empty-side
  hints, and complete review fingerprints (`mode: "all"`).
- A normal, populated HEAD revision is bound to the exact HEAD commit, exact resolved merge-base,
  HEAD branch, `changedSince: <merge-base>`, no empty-side hints, and changed-file review
  fingerprints (`mode: "changed"`). The moving base-tip commit is deliberately absent: once the
  exact merge-base is resolved, it is not an input to HEAD extraction.

Pair slots remain base-tip-sensitive so every request re-resolves and records the current target
branch. Semantic graph IDs do not: the HEAD ID is bound to the exact HEAD, exact merge-base, graph
bytes, and synthetic overlay, while the comparison ID is bound to the exact merge-base artifact.
A base update therefore obtains a new workspace and pair snapshot, but an unchanged HEAD plus
unchanged merge-base can reuse both verified immutable artifacts and preserve both graph IDs. This
also lets renderer restoration retain its already-decoded HEAD graph and index. The moving base-tip
SHA remains explicit response and pair provenance. Any artifact that requires empty-side hints
remains pair-local. A populated comparison for a whole-subtree deletion can still be canonical and
shared; a materialized empty side cannot.

The version-2 input identity is SHA-256-addressed over:

- repository key and normalized remote URL;
- exact role-specific commits (comparison commit, or HEAD plus merge-base), target name, HEAD
  branch where applicable, and extraction subdirectory;
- repository-analysis, graph-schema, generator, and cache-format versions;
- a deterministic build SHA-256 over the CLI/core/extractor source trees, package and TypeScript
  configuration, workspace configuration, and lockfile;
- exact Node version, platform, architecture, TypeScript version, and ts-morph version;
- a random server-process nonce, which is the hard interim reuse boundary;
- the complete repository-analysis policy;
- the fixed canonical role: comparison has no changed-since base and full fingerprints; HEAD has
  the exact merge-base as changed-since input and changed-file fingerprints; both require no hints,
  non-empty analysis, and the exact fingerprint format version and algorithm.

Publication stages an artifact, validates its canonical facts, and writes an immutable object below
its artifact-byte digest plus snapshot ID. A separate input-digest pointer is replaced atomically.
Every hit verifies the exact input object, pointer and metadata digests, artifact length and SHA-256,
summary, target/repository/commit coordinates, and the role-specific changed-since facts before
returning a file-backed artifact.

| Condition | Result |
|---|---|
| Different HEAD/merge-base commit, repository, target, branch, or subdirectory | Different input identity; extract |
| Base tip moves but exact HEAD and merge-base do not | New pair slot; verified HEAD and comparison reuse before analysis admission |
| Analysis policy or analysis/schema/generator/fingerprint/cache version changes | Different input identity; extract |
| Explicit cache refresh | Bypass the shared read and publish a new immutable result |
| Missing, malformed, mismatched, or corrupt pointer/metadata/artifact bytes | Fail closed to extraction |
| Populated sibling PRs with the same complete identity in one server process and the experimental flag enabled | Reuse the verified merge-base artifact |
| Server restart, including an otherwise identical build and environment | New process nonce; extract |
| Hinted or materialized empty-side artifact | Never admitted to this shared cache |

Cold and warm use one canonical pipeline. With the experimental flag enabled, a cold miss calls the
ordinary comparison extractor with the canonical inputs and publishes its exact bytes; a warm hit
returns those same bytes only after verification. No prior `GraphArtifact` is patched or
semantically restamped. The cold extractor therefore remains the semantic oracle, while the warm
path is byte-preserving reuse of one of its published results.

## Visible progress

The landing page now distinguishes repository preparation, HEAD extraction, merge-base extraction
or verified reuse, and opening the result. The renderer replaces the generic “Loading blueprint…”
screen with observable boot/review milestones:

- graph download, indexing, services, and initial layout;
- PR details, clone/checkout, HEAD extraction, merge-base extraction or reuse;
- review-artifact loading/indexing and final review projection.

Both entry points consume one browser-safe versioned model with the same ordered steps, labels,
revision states, status formatter, error/cancellation rules, and optional extraction observation.
The live status reserves seven lines in the landing/card surface, five in the wider boot surface,
and two in compact inline controls before extraction begins. The two revision lanes also reserve
their wrapped height. Rapidly changing file paths therefore stay inside a bounded, anywhere-wrapped
viewport instead of moving the card; full text remains in the live region and hover title, while
terminal errors remain unclamped.
The landing page stores a destination-scoped, PR-number-bound, one-shot session handoff before
navigation. Renderer boot may consume it only for the exact destination and PR within its 60-second
TTL, then continues at artifact loading rather than resetting to a contradictory generic splash.
Back/Forward navigation and a change of PR identity reset the active progress model so a previous
PR's state cannot appear in the new route. Copied URLs and malformed, mismatched, replayed, or stale
handoffs simply start from conservative boot state. These stages are presentation-only telemetry
and do not participate in cache identity.

## Known limits

- `pr-artifacts` pair snapshots and opt-in `pr-revision-artifacts` objects/input entries have no
  quota, idle policy, retention scheduler, or garbage collector. This is separate from the bounded
  TypeScript `shadow-admitted` shard namespace.
- Pair/revision cache reads return a verified file path but do not acquire an artifact-byte lease.
  Exact RepositoryMirror source workspaces remain lease-protected through graph publication, and
  `WebGraphStore` copies graph bytes into its process-private store, but a future persistent-cache
  sweeper could otherwise delete a verified artifact between verification and that copy. Retention
  must ship with a cross-process byte handoff lease or equivalent atomic ownership boundary.
- There is no cross-pair in-flight singleflight for a first-time revision miss. Concurrent sibling
  requests can duplicate HEAD or comparison extraction; immutable publication and verification
  preserve correctness.
- The renderer still must hold and index the exact HEAD and merge-base graphs to compute the review.
  This removes a throwaway base-tip graph and a duplicate HEAD fetch/index, not the two semantic
  review inputs.
- Exact-pair and exact-revision hits still resolve remote refs and acquire the required workspace and
  graph leases.
- Shared reuse deliberately excludes empty-side hinted analyses.
- Shared reuse is deliberately process-local. This preserves the sibling-PR benefit but does not
  reuse persisted PR artifacts after restart.
- A new process nonce makes old pair and revision entries unreachable, while those immutable
  entries currently have no garbage collector. Repeated server restarts therefore duplicate disk
  use. The TypeScript admission authority is stable across restarts, but that does not make these
  whole-artifact identities reusable. Keep cross-pair whole-artifact reuse loopback-only and
  experimental until quota, age, reference-aware cleanup, and byte leases exist.
- This cache is whole-artifact reuse, not the incremental TypeScript shard POC. Any future semantic
  input is not assumed to be covered by the deterministic digest. Python interpreter/package
  state, Git implementation/configuration, filesystem behavior, and the full transitive analysis
  closure are not yet hermetically captured; the process nonce is the fail-closed boundary while
  that provenance remains incomplete.
- An external interpreter, dependency, or Git configuration mutated while the same server process
  remains alive is not detected. Operational validation must restart the server after such changes.
- No production PR-serving rollout, whole-artifact admission policy, operational sizing, or
  eviction policy is decided by this implementation.

## Validation

Recorded commands and outcomes:

| Command | Outcome |
|---|---|
| `pnpm --filter @meridian/cli exec vitest run src/analysis-runtime-fingerprint.test.ts src/server/web-pr-cache.test.ts src/server/web-pr-analyze.test.ts --testTimeout=30000` | 3 files, 54 tests passed |
| From `packages/cli`: `./node_modules/.bin/vitest run src/server/web-pr-cache.test.ts --pool=forks --maxWorkers=1` | 1 file, 9 tests passed |
| `pnpm --filter @meridian/cli exec vitest run src/server/web-pr-analyze.test.ts src/server/web-pr-cache.test.ts` | 2 files, 59 tests passed |
| `pnpm --filter @meridian/cli exec vitest run src/server/web-server.test.ts` | 1 file, 27 tests passed in 4.26 s with localhost sandbox escalation |
| `pnpm --filter @meridian/cli exec vitest run --exclude src/server/folder-dialog.test.ts --testTimeout=30000` | 72 files, 749 passed and 3 skipped |
| `pnpm --filter @meridian/cli exec vitest run src/server/folder-dialog.test.ts --testTimeout=30000` | 1 file, 5 tests passed |
| Focused exact differential/admitted-reuse/file-parity suites | 3 files, 24 tests passed |
| Focused worker/runtime/shard-policy suites | 4 files, 38 tests passed |
| Focused CLI authority/global-lock/retention/scheduler suites | 4 files, 39 tests passed |
| Focused CLI mode/default-off PR-cache suites | 3 files, 22 tests passed |
| `pnpm --filter @meridian/core test` | 23 files, 207 tests passed |
| `pnpm --filter @meridian/extractor-typescript test` | Final follow-up: 40 files, 328 tests passed |
| `pnpm --filter @meridian/extractor-python test` | 9 files, 54 tests passed |
| `pnpm --filter @meridian/extractor-typescript typecheck` | Passed |
| `pnpm --filter @meridian/cli typecheck` | Passed |
| Focused renderer boot/navigation/PR suites | 7 files, 139 tests passed |
| `pnpm --filter @meridian/renderer typecheck` | Passed |
| `pnpm --dir packages/cli exec vitest run --exclude src/server/folder-dialog.test.ts` | Final follow-up: 73 files, 785 tests passed and 3 intentionally skipped |
| `pnpm --dir packages/cli exec vitest run src/server/folder-dialog.test.ts` | Final follow-up: isolated file, 5 tests passed in 0.34 s after its fixed 2-second child-start deadline was the only saturated full-pool failure |
| `pnpm --filter @meridian/renderer test` | 236 files, 2,220 tests passed |
| `pnpm --filter @meridian/cli exec vitest run --config vitest.e2e.config.ts e2e/pr-review-progress-layout.e2e.ts` | 1 file, 4 headless-browser tests passed; reserved geometry, long paths, independent concurrent lanes, and truthful capacity-one lane completion were preserved |
| `pnpm typecheck` | All 6 workspace packages passed |
| `pnpm build` | All package builds and renderer copy passed; existing renderer large-chunk warning remains |
| `git diff --check` | Passed |

The CLI split, complete core/renderer/TypeScript-extractor suites, focused hardened suites, all
workspace typechecks, browser E2E, build, and final Autopilot runtime matrix were rerun against the
final worktree. The Python row is the preceding unchanged-package gate.

Sandboxed CLI/E2E attempts could not bind loopback listeners (`EPERM`). Running the complete CLI
suite and focused browser suite with localhost permission produced the passing results above; the
sandbox failures were environmental, not assertion failures.

The unpartitioned CLI pool twice had only the folder-dialog child-start fixture miss its fixed
2-second deadline. It passed alone in 0.36 seconds; all other 72 files passed together with a
30-second test timeout. No product timeout changed.

Focused coverage includes direct preparation, selected-HEAD movement rejection, live ref
revalidation, unchanged semantic IDs when only the base tip advances, exact-ID boot HEAD/index reuse
with no second HEAD artifact/metadata fetch, moved-ID replacement, sibling merge-base reuse, refresh
bypass, corruption fallback, subdirectory separation, stage streaming, landing-page routing without
`/api/generate`, and cancellation of an accepted Back navigation during initial review restoration.
The hardened suites additionally cover
default-off shared-reference rejection, Ed25519 receipt forgery/key rotation/pre-receipt misses,
admitted non-publication and shadow repair, authority persistence/permissions, exact active-workspace
lease matching, global-lock fencing/recovery/host isolation, bounded cache reads/enumeration,
orphan/idle/LRU retention, no-follow quarantine, and scheduler shutdown.

## Runtime results

Environment: macOS arm64, Node 26.2.0, persistent server
`meridian-app-99f9` on `127.0.0.1:4187`. The run used a unique empty
`MERIDIAN_CACHE_DIR`. An already-open browser tab briefly initiated the old landing implementation
and was closed; before the measured run, both `pr-artifacts` and `pr-revision-artifacts` contained
zero files. The Git mirror and unrelated generic artifact cache were warm, so this is a cold PR
pair/revision extraction, not a cold network clone.

These whole-revision reuse measurements predate the final default-off split. Reproducing sibling
HEAD/merge-base reuse now requires the explicit loopback-only
`--experimental-pr-revision-cache` flag; they are performance evidence for the experiment, not the
default server behavior or a production-readiness claim.

The live fixtures were open PRs in `RazvanRotaru/meridian`:

- #205 HEAD `47cf143c629d2290ae041ea202b8a63c66a13e0d`;
- #206 HEAD `324331c3e5558501e7e04082d9800ce63c4ac2f1`;
- live base `49724ad3a8b1ba61e67685d28542c70d021b3134`;
- shared merge-base `e7de9a78c9436d36c8ae86a57eb291d66d71b9bb`.

| Scenario | Observed result |
|---|---|
| #205 cold PR pair | HEAD extraction visible by 2.6 s; merge-base extraction visible by 26.9 s; pair snapshot published at approximately 35.2 s; complete review visible by 43.9 s. |
| #205 exact-pair warm request | `done` only, `cache:"hit"`, 0.738 s. |
| #205 renderer-style live revalidation | `done` only, `cache:"hit"`, 0.651 s; returned the exact boot HEAD graph ID. |
| #206 sibling pair | HEAD extraction visible by 4.7 s; stage-aware renderer showed “Resolving exact PR revisions…” at 19.0 s; pair snapshot published at approximately 19.4 s; complete review visible by 25.3 s. |
| #206 exact-pair warm request | `done` only, `cache:"hit"`, 0.676 s. |
| Moving-ref race | Covered by selected-HEAD rejection, same-ID reuse, and changed-ID replacement tests; no live PR was mutated. |

The sibling end-to-end time was about 42% lower than the first pair. The important correctness
evidence is the cache metadata, not the timing: exactly two pair snapshots were published, both
named the same exact merge-base and both contained the identical complete
`comparisonStorage.reference`:

```text
inputDigest    67bac78276ef3b9e0970e57d032dd66b3d800d28d3f3557d2b5b3fe5a0ea001c
artifactDigest a4bc9aa02a9484195514a1d5d53dac5a9a99f3487216ae217932bd882e25ec7c
snapshotId     e791263931862539
artifactBytes  34,170,927
```

The canonical object's persisted input had `changedSince:null`, no hints,
`reviewFingerprints.mode:"all"`, the build/runtime fingerprint, and the current process nonce.
There was one canonical merge-base object, not one copy per PR. Both staging roots were empty after
the run.

Disk use after both PRs was 63,668 KiB for pair snapshots, 33,424 KiB for the one canonical
revision store, and 84,568 KiB for the isolated Git repository store. The two PR cache areas
together used 97,092 KiB (94.8 MiB). Server RSS was 94,896 KiB before the run and 192,528 KiB after
both reviews; this is a post-run observation, not a sampled peak.

The browser run visibly used the new PR-specific landing stages, then the renderer's exact-revision
stage instead of “Loading blueprint…”. PR #205's tab was closed before opening #206, so the browser
did not retain both complete review graphs concurrently. The server shared the file-backed
canonical object by immutable reference.

## Representative Autopilot benchmark

The smaller Meridian fixtures overstated how warm a sibling review feels. A second run used the
same persistent process and already-populated Git mirror for `UiPath/Autopilot`, then prepared three
open PRs whose **live Git merge-base** was the same exact commit
`e12ba3a32c99dc11d05204e850ab3882b8fad393`. This is the common post-clone user case: network clone
and object fetches are warm, but each new PR HEAD is a new semantic revision.

Command shape:

```text
node packages/cli/scripts/benchmark-pr-prepare.mjs \
  --url http://127.0.0.1:4187 \
  --repository UiPath/Autopilot \
  --pr <number> --base main --head <ref> --head-sha <exact SHA>
```

| Scenario | Changed files | HEAD work | Merge-base work | End-to-end |
|---|---:|---:|---:|---:|
| PR #4466, first pair in this process | 1 | 179.1 s | 179.0 s extraction | 363.0 s |
| PR #4466, exact repeat | 1 | verified pair hit | verified pair hit | 1.04 s |
| PR #4480, sibling pair | 4 | 179.0 s | verified revision reuse | 183.6 s |
| PR #4307, sibling pair | 57 | 187.6 s | verified revision reuse | 192.6 s |

The final rebuilt app was rerun against the then-current live PR revisions. PR #4466 used HEAD
`23f36d7f30ad6ef0ea79cd35fe2bd29c3df3a487` and exact merge-base
`e12ba3a32c99dc11d05204e850ab3882b8fad393`. PR #4480 had moved since its earlier selection, so the
server first rejected stale selected HEAD `624369…` in 0.957 seconds, then accepted refreshed HEAD
`5addfa98a058459dfcbf457fd2eb7717977b86d3`.

| Final-source scenario | Progress evidence | Reuse evidence | End-to-end |
|---|---|---|---:|
| PR #4466, cold pair | First real source file at 6.1 s; 395 bounded events | Both exact revisions extracted | 353.7 s |
| PR #4466, exact repeat | One terminal event | Verified exact-pair hit | 1.07 s |
| PR #4480, refreshed sibling pair | 198 bounded events | Exact merge-base reused; only the new HEAD extracted | 177.4 s |

The final sibling run was almost exactly half the cold pair. It demonstrates the intended
post-clone benefit while also confirming the remaining limitation: a distinct PR HEAD is still a
whole-repository extraction even when only a few files changed.

The sibling cache is working: #4480 and #4307 did not extract the 353,282,541-byte merge-base
artifact again. The remaining latency is also real: every distinct HEAD still performs whole-repo
extraction, regardless of whether Git reports 1, 4, or 57 changed files. This is why “warm” needs
three explicit meanings:

1. **Git-mirror warm** avoids a network clone but does not reuse semantic extraction.
2. **Sibling warm** reuses only an identical, verified merge-base and is roughly twice as fast as
   the first pair on this cohort.
3. **Exact-pair warm** reuses both immutable artifacts and is approximately one second.

The three Autopilot reviews that motivated this follow-up were not sibling-cache hits at all. Their
persisted pairs named three different merge bases (`7417dbf…`, `5820337…`, and `29c8ff7…`) for
HEADs `516b1de…`, `061eec4…`, and `d88ef6…`. Only the Git mirror was warm, so each pair still needed
two repository-wide graphs. Their workspace-to-snapshot intervals were approximately 367–386
seconds; the third also began while another analysis owned the single memory-heavy worker, adding
queue time before useful extraction. A shared target branch is therefore not a reuse proof: the
exact live merge-base OID must match.

The largest sampled analysis-worker RSS in the final runs was 6,901,744 KiB (about 6.58 GiB), during
the #4480 sibling run; the #4466 cold run was sampled at about 6.14 GiB. These are periodic samples,
not instrumented exact peaks. The #4466 HEAD artifact was 337,298,359 bytes (321.7 MiB), with 59,346
nodes and 229,127 edges; both sides reported 6,842 source files. These numbers make concurrent
first-time PR requests especially expensive: the current memory-heavy worker serializes analysis,
so a later request can spend minutes waiting without doing file work of its own.

### Live long-unit and moving-base follow-up

Autopilot PR #4472 was then rebuilt against exact HEAD
`91ad7ee0cd1d954e4f278354efb2240ea206834d`, selected base tip
`b339f389c0ab13dc1ab8292dab51e64e1bc21b45`, and exact merge-base
`9569676c8c7bd5d3573773113643fdf2c5fd9270`. The cold pair completed in 489.9 seconds:
the HEAD lane spent about 233.6 seconds in extraction and the comparison lane about 250.8 seconds.
The two disposable workers produced 741 bounded progress observations. The final graph contained
59,789 nodes and 229,587 edges; the HEAD artifact was 338,664,575 bytes and the comparison artifact
352,618,707 bytes. The pair cache occupied 341,652 KiB. The shared revision-object store occupied
2,789,656 KiB in total, but that directory also contained earlier benchmark revisions, so it is a
retained-store observation rather than this pair's incremental disk cost.

The formerly opaque `src/aria/app` relationship unit visibly advanced through individual files in
calls/types, imports, value references, Promise discovery, Promise linking, logic flows, ports, and
exports. Periodic process samples showed active CPU rather than a deadlock: approximately 103% CPU
and 5.0 GiB RSS during one large-unit sample, later reaching about 6.17 GiB RSS while still
runnable. This run is not a controlled speed comparison with the earlier cohort: it used different
live revisions and system load. It proves progress visibility and continued execution, not a
material end-to-end extractor speedup.

The immediate repeat also reproduced the warm-path bug that exact-pair timing alone concealed.
During the cold run, live `main` moved from `b339f389…` to
`6daea0ca1a57d8fdb1388f7cbb72d3c149f3c027`, while the selected HEAD and resolved merge-base stayed
unchanged. Because pair identity correctly includes the live base tip, the repeat missed the old
pair and began extracting the identical HEAD again; it was cancelled after about 25 seconds and
the disposable worker exited cleanly.

The populated-HEAD revision cache now covers exactly that case. It resolves and validates the new
pair workspace first, then probes the HEAD identity bound to the exact HEAD, exact merge-base,
branch, repository/subdirectory, runtime/provenance, policy, and changed-file fingerprint mode.
When both role-specific revision objects verify, it publishes the new base-tip-sensitive pair
snapshot without entering analysis admission. Focused tests prove moving-base reuse, plus
conservative misses for a changed merge-base, changed HEAD ref, changed subdirectory/runtime,
refresh, corruption, and empty-side hints. The new path is test-proven but was not re-seeded with
another eight-minute live run after the final process restart.

A later operational reproduction isolated the remaining duplicate. Two pair snapshots started at
14:00:07 and 14:10:11 with the same HEAD
`b0319d2020e6d23355fce91f79ce20b7ce50baac`, the same merge base
`2edfc205a2669c0dd02488ebbf443800f7e81bd5`, and byte-identical HEAD/base artifacts of
344,406,684 and 360,102,448 bytes. Only the selected base tip changed, from `1770ca2…` to
`7d77860…`. The running service did not have `--experimental-pr-revision-cache`, so the new
base-tip pair slot performed both semantic extractions again. The fix keeps the pair slot and
reported base SHA current while deriving the HEAD graph ID from the semantic merge base. A
landing-prepare to live-analyze regression now proves `reuse-head` plus `reuse-merge-base`, stable
graph IDs, and no additional analysis for that transition.

The post-navigation lane was profiled independently for the same pair:

| Artifact | Loopback transfer (3 runs) | Read | JSON parse | Index | Standalone max RSS |
|---|---:|---:|---:|---:|---:|
| HEAD, 321.7 MiB | 130.0–165.8 ms | 25.5 ms | 610.1 ms | 152.1 ms | 1.63 GiB |
| Merge base, 336.9 MiB | 139.6–171.0 ms | 27.3 ms | 626.0 ms | 145.4 ms | 1.68 GiB |

Uncontended transfer, decode, and indexing for both graphs total about 1.9 seconds, not minutes.
The multi-minute “Loading blueprint…” interval was therefore hiding extraction or queueing.
Renderer memory remains a secondary performance risk: the in-app path can retain its boot graph
while decoding HEAD and merge-base graphs concurrently. The review projection also rebuilt an
already-available merge-base index; the POC now passes the prepared immutable index through instead,
removing that duplicate map allocation. Persistent HTTP caching remains intentionally out of scope
until private-code retention has an explicit security policy.

Progress now travels through the extractor and worker as presentation-only telemetry. Each detailed
event identifies the exact 40- or 64-character revision OID, whether it is HEAD or merge-base, its
position in the two-review-graph execution, and real language work. TypeScript reports package/unit
position plus source-file position within the actually loaded project. Python separately reports
all discovered files while parsing and all successfully parsed files while building structure, so
a syntax-error file is never presented as structurally analyzed. TypeScript cannot truthfully know
a repository-wide compiler file total before loading every project, so the UI says
“unit X/Y, file A/B” rather than presenting a fabricated global counter. Phase labels remain visible
beside file counts, and relationship, stitch, and finalize phases are guaranteed per language after
the last file so “last file” cannot be mistaken for “graph ready”. IPC sampling, event counts, UTF-8
path sizes, Python stdout, and diagnostic tails are bounded. Synchronous throws and rejected async
progress observers cannot affect extraction output.

The TypeScript relationship phase is divided into activity-level markers for calls and types,
imports, optional value references, Promise discovery and linking, logic flows, ports, and exports.
Their file counters describe the primary traversal that emits observations, not every internal
traversal: Promise-link preparation and port classification still contain repository scans and
correlation work for which the POC cannot identify a single current file without changing those
algorithms. During that work the displayed path is therefore the most recently observed primary
file, and reaching `file N/N` is not a completion signal; later activity transitions and the
terminal stitch/finalize transitions remain the completion oracle. Exports are reported only by the
per-package pipeline, and Promise linking appears only when Promise resources exist. Ordinary file
observations are sampled at one hertz to keep the text readable and IPC bounded; activity
transitions and terminal phases use separate reserved capacity, so a workspace with many small
units cannot crowd out `stitch` or `finalize`. Observer-free extraction does not construct these
callbacks or progress objects. Progress remains outside graph bytes and every cache identity.

A final browser check selected Autopilot PR #4466 from the Git integration page. Before redirect it
rendered the canonical five-step progress model and both revision lanes; renderer boot then
continued with the same labels and states while loading the already-prepared pair. Clicking
“Review in graph” from the in-app PR tab rendered that same five-step model, the same HEAD and
merge-base lanes, and the same resolving status. The exact-pair hit completed in under a second;
the UI then conservatively reported that #4466's one YAML-only change had no matching graph nodes
instead of presenting an empty review as actionable.

A later post-change browser attempt could open the landing surface but could not enumerate PRs
because that browser session's GitHub API request was refused for rate-limit or scope reasons.
Consequently, the new `reuse-head` transition and the final activity labels are covered by shared
model/component/landing tests and live NDJSON benchmark output, but were not exercised through a
second browser-selected PR after the final rebuild.

### Revision-shard follow-up

The revision-safe TypeScript POC is now connected behind the server-owned
`--typescript-incremental empty|shadow|admitted|verified-experimental` option; it remains disabled
by default. The client cannot choose the cache directory, tree, build/runtime fingerprint, policy,
or admission authority.

The shard build fingerprint is intentionally narrower than the process-scoped whole-artifact
identity above. It hashes the exact installed TypeScript extractor entry and its complete declared
runtime dependency closure, including core/schema and the TypeScript toolchain. Unrelated CLI,
renderer, and Python implementation changes therefore invalidate whole artifacts but can still
reuse already-admitted TypeScript shards. Exact shard requests, schema/repository policy, and
Node/platform/toolchain coordinates remain independently bound. This does not depend on remembering
to bump a repository-analysis version: a compile-time closed `ExtractOptions` boundary requires
every semantic CLI-supplied extractor option to be fingerprinted or explicitly classified as
exact-root, shard-disabling, supplemental-input, or observation-only data.

- `empty` exercises the same pipeline in a disposable cache.
- `shadow` uses a host-local Ed25519 signer, writes canonical semantic evidence one category at a
  time, stages immutable shard bytes without making them reusable, releases the incremental graph,
  and literally compares the evidence plus each staged shard envelope with an empty-cache oracle.
  It serves the cold result, and the sole parity-enforcing publication API only then publishes
  admission receipts plus the revision manifest that make those exact staged shards reusable.
- `admitted` receives only the public verifier, reuses exact receipt-authenticated shards, computes
  canonical misses, and does not publish those misses.
- `verified-experimental` reads/writes its direct cache without an oracle receipt and remains a
  loopback-only performance mode outside the safety claim.

`shadow` and `admitted` require the canonical Git root and HEAD commit to match an active exact
RepositoryMirror workspace lease. They share one namespace and a fenced host-local global build
lock, so separate Meridian processes cannot concurrently build or mutate that admitted cache. A
separate recovery claim is checked before and after owner establishment; recovery revalidates the
exact quarantined generation and leaves ambiguous or interrupted recovery fenced for explicit
repair rather than stealing a replacement.
Repository subdirectories and materialized empty roots conservatively use the ordinary extractor
rather than weakening that exact-root ownership proof.
Retention uses a non-blocking attempt at the same lock and skips an active build. The scheduled
pass uses 8/6 GiB hysteresis, a 30-day idle limit, a 500,000-entry scan cap, deterministic
support-before-shard quarantine, no-follow crash-trash cleanup, exact interrupted-publication
temporary cleanup, and an hourly cadence after the initial delay. Symlink and lookalike temporary
names remain untouched, and receipt-less failed shadow staging is reclaimed as orphaned. Individual
reads and candidate enumeration are also size/count bounded. Shadow can
quarantine and repair corrupt unadmitted data after cold parity; admitted mode treats corruption,
missing/invalid receipts, and an overloaded candidate set as misses.

Population is deliberately two-step: run an exact revision in `shadow` to establish per-unit cold
parity and issue receipts, then use `admitted` for that revision or related revisions. New admitted
misses do not self-promote; a later shadow run must prove and sign them. No production cache
admission or default serving behavior changed.

On the exact PR #4472 revisions above, the final schema-v6 controlled runs produced:

| Scenario | Total | Unit reuse | Source-byte reuse | Semantic digest |
|---|---:|---:|---:|---|
| Merge base cold | 258.37 s | 0/27 | 0% | `24ef0007…` |
| Merge base warm, new process | 54.08 s | 27/27 | 100% | `24ef0007…` |
| HEAD using the warm base cache | 262.09 s | 25/28 | 21.817% | `cbe4625e…` |
| HEAD isolated empty-cache oracle | 295.76 s | 0/28 | 0% | `cbe4625e…` |
| HEAD warm, new process | 61.98 s | 28/28 | 100% | `cbe4625e…` |

The cross-revision run and isolated oracle also produced literal-identical manifest files, the same
manifest address, the same ordered 28 unit shard keys, and the same semantic digest. The three
rebuilt units were the changed 4,528-file app, the iframe package whose compiler program observed
changed app inputs, and the newly admitted delegate-web package. The other 25 existing units reused
immutable merge-base contributions.

This improves first-time HEAD extraction by only 11.38% for this PR, while repeat HEAD extraction is
79.04% faster. It does not make the first review instant: the changed app alone contains about 74%
of selected source bytes. The next performance boundary is a smaller compiler-derived semantic unit
inside that package, plus a hit path that proves inputs without constructing the full TypeScript
Project. Even a 100%-reused warm run currently constructs each short-lived
`ts-morph`/TypeScript Project to prove its realized program, configuration, and resolution
fingerprint: the measured warm runs still took 38.9-46.0 seconds of fingerprint work and peaked at
6.49-6.52 GB maximum RSS. The isolated cold HEAD peaked at 8.07 GB. The global lock bounds
concurrent memory pressure but does not reduce that per-build cost.

An isolated semantic-region planner now proves the intended graph algorithm without serving its
output. It collapses complete cross-file dependency cycles into regions, evaluates providers before
consumers, and rebuilds a changed region plus reverse-transitive consumers. It fails closed to the
whole package unless module/type resolution, lookup inputs, symbol/type reads, extractor-specific
reads, and ambient/augmentation scope are all complete. The present extractor cannot yet provide
that proof or reassemble cached per-file contributions in exact cold byte order; its global
ports/RPC/message-dispatch and Promise-resource passes must first become immutable local facts plus
pure reducers. Module-resolution-only sizing suggests substantial potential reuse in ordinary
source edits, but it is not a soundness boundary. Config and ambient changes such as the inspected
Autopilot pair `aa579af…` versus `e191417…` must conservatively rebuild the full app.

A final real service/browser pass used open Autopilot PR #4472. Forced-refresh `shadow` completed
both exact revisions and their cold TypeScript oracles in 22m 05s with 988 progress events.
Forced-refresh `admitted` then completed in 3m 18s with 63 events and no TypeScript
structure/relationship traversal. After a server restart, normal-policy `admitted` reused the same
30 unique receipt-authenticated shards in 2m 34s; an exact pair repeat returned only `done`,
`cache:"hit"` in 1.38s. All runs produced 59,970 nodes and 230,792 edges.

### Memory-admitted pair parallelism

HEAD and merge-base extraction are independent pure computations once both exact workspaces and
inputs have been resolved. A populated two-sided cache miss can therefore reserve two analysis
slots atomically and run the two disposable workers concurrently. This is not commit-by-commit
extraction: the two progress positions are the exact PR HEAD and exact Git merge base.

The server enables this canary only when startup explicitly selects the loopback-only
`--typescript-incremental admitted` mode, the memory policy admits two workers, and both sides are
populated misses. The default server, capacity-one hosts, other shard modes, a one-side cache hit,
and a materialized empty side remain sequential. On a capacity-two host, a populated pair remains
a FIFO atomic two-slot request even when another pair is active; one busy probe no longer degrades
the request permanently to a ten-minute one-worker sequence. Local slots and the host-wide shard
fence are never held while waiting for the other resource: the request alternates fair local
admission plus a non-blocking fence probe with a bounded process-local coordination admission,
host-fence wait, and non-blocking local-capacity probe. Only one request per process polls the
filesystem fence; later requests enter a bounded process-local FIFO whose default queue limit
matches the analysis queue, and excess prepared requests receive the existing retryable overload
error and discard their stage/workspace. Failed probes release their resource before retrying, and
the local probe cannot bypass queued FIFO work. Capacity one is the only automatic sequential
fallback. The first child failure aborts its sibling, but both promises are drained before capacity,
the cache fence, or request staging is released.

The two workers also receive one private request-scoped shard exchange. Each still fingerprints its
exact Git tree and compiler program. On an admitted persistent-cache miss, an atomic lock keyed by
the complete unit input fingerprint lets one worker run the canonical unit extraction; after the
observed cross-package resolver trace completes the content address, the sibling can reuse those
immutable bytes. Different unit fingerprints run independently and concurrently. The pair exchange
is removed after both workers settle, has no admission receipt, never enters the persistent cache,
and is inaccessible to later PRs. Focused real-Git tests prove that two identical fresh workers
perform three unit builds rather than six, and that two different exact trees with one changed unit
perform four builds rather than six. Both final results and revision manifests are canonical-JSON
identical to empty-cache cold extractions. This is unit reuse between the two final trees, not
per-commit replay.

Exact-revision objects are also rechecked after the pair jointly acquires slots and the host fence.
This closes the overlap race in which PR B observed a shared merge-base miss, waited behind PR A,
then unnecessarily extracted the base that A had published while B was queued. A late base hit
leaves only HEAD to extract; late hits on both sides start no workers. Refresh requests, disabled
whole-revision sharing, corrupt entries, and materialized empty sides retain their conservative
behavior.

A controlled forced-refresh run on the exact PR #4472 revisions used the same built code and cache
policy for both paths:

| Path | End-to-end | Sampled aggregate peak RSS | Result |
|---|---:|---:|---|
| One analysis slot, sequential HEAD then merge base | 571.364 s | not comparable because the control used a larger heap only to force one slot | 59,970 nodes / 230,792 edges |
| Two analysis slots, concurrent exact revisions | 321.905 s | 12.826 GiB | 59,970 nodes / 230,792 edges |

Parallel extraction reduced cold-pair wall time by 43.66% (1.775x). After replacing only the
top-level non-semantic `generatedAt`, the complete 339,943,767-byte HEAD artifacts were
byte-identical with normalized SHA-256
`19e633d9ef55a8a5c6e96a377b6150f03574f7920ec1d1c9fe8dcb1d8f3f9c00`; the complete
353,965,032-byte merge-base artifacts were byte-identical with normalized SHA-256
`fef88370ea99a0e08d6d32dcdfc6e73a027f9856315d05fec87c81cca3095375`.
This comparison covers serialized node, edge, call-site, flow, port, diagnostic, review-fingerprint,
and ordering parity, not only counts.

The frozen final build completed another concurrent cold pair in 342.797 s with 13.407 GiB sampled
peak RSS and the same two normalized artifact digests. Host contention invalidated the attempted
same-build sequential timing, so the 40.00% comparison with the earlier valid sequential oracle is
reported only as corroboration, not a second controlled speedup sample.

A later rebuilt-service run prepared live Autopilot PR #4510 at HEAD `e19cd50…` and merge base
`f59c9e1…`. It was a new-process whole-pair miss over the retained authenticated shard namespace.
Both lanes became visible at 5.192 s, HEAD completed at 275.563 s, and the pair completed at
277.072 s (4m37s) with 60,582 nodes and 234,221 edges. An immediate exact repeat returned one
`done` event in 1.520 s with identical graph IDs. Progress showed seven TypeScript structure
traversals across two 27-unit revisions; the large app and iframe were the only units traversed on
both sides. This is about 22% below the earlier 5m54 observation of the same pair, but the hosts
were not controlled, so it is corroboration rather than an attributed speedup. It confirms that
the remaining first-review critical path is concentrated in changed large semantic units.

The TypeScript RPC pass now reuses the ordinary call traversal as an exact
`.createProxy`/`.createStub` syntax gate, lazily builds its call-target index only for parameter
propagation, and uses order-preserving mutable accumulation instead of repeated array spreads.
Autopilot has no accepted RPC factory calls in its 4,528-file app unit. The bounded progress trace
places the old app-unit ports-to-exports segment at 29.3-30.9 s per revision and the final segment at
16.1-16.5 s, a 43.8-47.9% phase reduction. Whole-run improvement is not claimed from one noisy
sample. Exact normalized artifact bytes and positive, negative, alias, unresolved, and
cross-package fixtures remained unchanged.

An admitted-miss codec shortcut was explicitly rejected. It was semantically equal, but direct
miss objects retained construction-order keys while shard-decoded objects were normalized; mixed
hit/miss artifact byte digests and therefore graph IDs changed. The optimization was removed rather
than weakening the byte-identity gate.

Renderer restoration showed the same five-step model and revision lanes as landing preparation,
including review-graph/unit/file/activity progress for TypeScript and Python. The reserved card
remained stable while long paths and separate semantic traversals changed. It then rendered the
complete 21-file PR graph review with affected flows and submission controls. That validation app
used `meridian-app-99f9` on port 4187 with `admitted` plus the loopback-only exact-revision cache,
without forced refresh. The session was later stopped at the user's request after it became
unresponsive; this note does not claim a currently running service.

The complete model, parity matrix, disk/RSS measurements, risks, and production sequence are in
`docs/revision-safe-incremental-extraction-poc.md`. The later file-grained experiment and its
controlled Autopilot measurement are in `docs/revision-safe-file-shard-poc.md`.

## Recommendation

**Revise; do not cut this POC over to production PR serving.**

- Keep direct selected-PR preparation, exact-ID boot HEAD/index reuse, stage-aware progress, and
  PR-identity-safe Back/Forward resets as separable improvements.
- Keep cross-pair whole-revision reuse off by default and loopback-only. It still needs bounded
  retention/GC, a cross-process artifact-byte handoff lease, cross-pair miss singleflight, fuller
  external-runtime provenance, and controlled multi-request/corpus rollout evidence.
- Evaluate TypeScript shards through `shadow`, then explicitly populated `admitted` runs. Receipt
  authentication, lease-bound Git identity, the global lock, repair/quarantine, and bounded
  retention materially improve the POC, but warm Project construction, 6-7 GiB RSS, coarse large
  units, and limited corpus evidence remain.
- Proceed with the memory-admitted two-worker pair path and the RPC no-candidate gate as separable
  performance changes, but canary aggregate RSS, queue time, cancellation, and throughput before a
  broad rollout. Do not generalize the one-repository timing to all codebases.
- Keep the cold extractor as the semantic oracle. The runtime runs prove exact byte/reference or
  semantic parity only for the recorded revisions; they do not prove arbitrary environment
  soundness or authorize graph registration, renderer hydration, cache admission, or PR-serving
  production wiring.
