# Commit-aware web graph cache

## Status

- [x] 1. Research
- [x] 2. Spec
- [x] 3. Tasks
- [x] 4. Manual verification

---

## 1. Research

### Already-installed packages

- Node's built-in `fs`, `os`, `path`, and `crypto` modules already cover cache directories, atomic files, and stable cache keys.
- The existing `git-exec.ts` runner already provides argv-only Git execution, credential injection through `http.extraHeader`, timeouts, output caps, and secret redaction. It can be extended for a cheap remote commit lookup without adding a dependency.
- `@meridian/core` already exports `validateArtifact`, so a persisted artifact can be validated before it is trusted.
- Verdict: no new package is needed.

### Existing repo code to reuse

| Path | Current role | Reuse verdict |
|---|---|---|
| `packages/cli/src/server/clone.ts` | Validates remote inputs, creates a fresh shallow clone, and removes it on failure or process exit | Extend source resolution so a remote source may come from a persistent cache entry |
| `packages/cli/src/server/git-exec.ts` | Runs Git safely with credential redaction and timeouts | Reuse for `ls-remote` or an equivalent remote-head lookup |
| `packages/cli/src/server/web-graph.ts` | Runs resolve, extract, and in-memory registration for every generate request | Add cache lookup before extraction and cache publication after successful extraction |
| `packages/cli/src/server/web-request.ts` | Normalizes generate input and derives a deterministic graph id that currently omits commit, language, and extraction options | Split repository, analysis, and graph-session identities; make graph ids commit- and configuration-specific |
| `packages/cli/src/server/source-serve.ts` | Reads code slices from the retained source directory | Requires the cached checkout to remain available; persisting only `graph.json` would break source viewing after restart |
| `packages/cli/src/json-io.ts` | Writes JSON through a temporary file and rename | Reuse or extract the atomic-write behavior for cache metadata and artifacts |
| `packages/cli/src/server/web-prs.ts` | Invalidates an in-memory PR file cache with `updatedAt` and `headSha` | Reuse the explicit freshness-token pattern, not its in-memory storage |
| `packages/cli/src/artifact-header.ts` | Stamps schema, generator identity, target information, and telemetry onto extracted graphs | Extend header inputs so a web artifact records its analyzed commit and branch in `target.vcs` |
| `packages/cli/web-ui/index.html` | Displays the `source`, `extract`, and `open` preparation stages | Define how a cache hit advances progress and whether the result reports hit, miss, or stale reuse |

### Prior art in the repo

- Commit `cb10026` hardened the PR cache by checking both update time and head SHA, and by keeping cached paths in one canonical vocabulary. The graph cache should likewise use the exact remote commit as its freshness token and keep one normalized source identity.
- `web-pr-analyze.ts` already derives commit-pinned graph ids from `git rev-parse HEAD`. This establishes commit SHA as the repository's preferred immutable provenance value.
- No existing commit or module provides persistent clone or graph caching for `/api/generate`.

### Build vs buy verdict

Build a small CLI-local cache because all required primitives and security boundaries already exist, and a third-party cache package would not solve Git freshness, checkout retention, or artifact validation.

### Current behavior and bottleneck

1. Every `/api/generate` call creates a new `blueprint-clone-*` directory under the operating-system temp directory.
2. Git performs a depth-1, single-branch clone.
3. Meridian runs the full extractor and keeps the resulting artifact only in `Context.graphs`.
4. The clone stays alive only so `/api/source` can serve code, then the process exit hook deletes it.
5. Restarting `meridian web` loses both the artifact and source checkout, so selecting the same unchanged repository repeats clone and extraction.
6. The current graph id omits commit, language, and extraction options, so regenerating the same source can replace the graph and source directory behind an already-open browser tab.

### Recommended direction

#### Cache identities and layout

Use separate identities for the expensive checkout and for each analysis. This prevents a second subdirectory or language selection from storing another full clone of the same commit.

```text
<cache-root>/
  repositories/<repository-key>/<commit-sha>/
    repo/
    metadata.json
  artifacts/<repository-key>/<commit-sha>/<analysis-key>/
    artifact.json
    metadata.json
  pr-artifacts/<repository-key>/<head-sha>/<base-sha>/<analysis-key>/
    repo/
    artifact.json
    metadata.json
```

- Derive `repository-key` only from the normalized clone URL. Branches are movable commit lookups, so refs that resolve to the same commit share one checkout and graph.
- Derive `analysis-key` from subdirectory, requested language, every output-affecting extraction option, schema version, generator version, and an explicit cache analysis version.
- Key PR analysis by both head and base SHA because either revision changes the merge-base diff and changed-node overlay.
- Never include or persist a token. The cached `.git/config` must contain only the credential-free normalized remote URL.
- Derive the browser graph id from repository identity, actual commit SHA, and analysis key. An old tab must remain pinned to the graph and source tree it opened.

#### Freshness, provenance, and publication

- Before cloning or extracting, use the credential-safe Git runner to resolve the selected remote ref to a commit SHA. An omitted ref resolves remote `HEAD`; an explicit ref must have one documented branch/tag resolution rule.
- Treat the remote lookup as a preflight only. After cloning, run `git rev-parse HEAD` and use that actual checkout SHA for cache paths, metadata, the graph id, and `artifact.target.vcs.commit`. Record the resolved branch when known.
- On a checkout hit, verify the cached repository directory exists and still resolves to the expected commit.
- On an artifact hit, parse it, run `validateArtifact`, and verify its metadata and `target.vcs.commit` match the requested checkout and analysis version before registering it.
- Preserve the warnings returned by extraction or reconstruct equivalent validation warnings on a hit so cached and uncached responses have the same contract.
- Create checkout and artifact misses in unique staging directories. Publish immutable commit and analysis directories only after clone, extraction, validation, and metadata writes all succeed.
- Never replace a populated directory in place. Immutable commit directories avoid non-atomic directory replacement on Windows and keep source files stable for open tabs.
- If another process publishes the same immutable entry first, discard the local staging directory and use the completed entry. Keep the per-process in-flight map as the fast path for duplicate requests within one server.
- A failed refresh must leave every previously valid immutable entry untouched.

#### Compatibility and invalidation

- Define an explicit cache format version for metadata shape and an explicit analysis version for extractor behavior. Schema and package versions remain compatibility inputs but are not sufficient during local development, where code may change without a version bump.
- Treat missing files, malformed metadata, invalid artifacts, commit mismatches, and incompatible versions as cache misses. Quarantine or remove only the invalid immutable entry, never an unrelated repository entry.
- Include `MERIDIAN_VALUE_REFS` and any future output-affecting web extraction switches in the analysis key.

#### Storage, privacy, and user control

- Use a platform cache directory rather than an anonymous temp directory: `LOCALAPPDATA` on Windows, `~/Library/Caches` on macOS, and `XDG_CACHE_HOME` or `~/.cache` on Linux. Allow `MERIDIAN_CACHE_DIR` to override it for tests and advanced use.
- Create cache directories and files with user-only permissions where the platform supports them because entries may contain private source code.
- Define bounded retention using last-access metadata plus a size or age limit. Cleanup must skip entries registered by the running process and must never follow paths outside the resolved cache root.
- Provide a forced-refresh escape hatch and a documented cache-clear mechanism. A corrupt or unexpectedly stale cache must not require users to discover internal directory names.
- Decide explicitly whether a failed remote freshness check fails closed or serves the last valid artifact as stale. If stale reuse is allowed, report it visibly in warnings and never disguise it as a confirmed hit.

#### Observable behavior and verification targets

- Keep the existing one-shot JSON response compatible. Add an optional cache outcome such as `hit`, `miss`, or `stale` rather than changing required fields.
- Define the NDJSON sequence for a cache hit and miss so the landing page never leaves a preparation step pending. A hit should skip expensive extraction without pretending extraction ran.
- Verify cache hit, changed remote commit, corrupt metadata, corrupt artifact, missing source checkout, incompatible analysis version, simultaneous requests, cross-process publication races, private-token redaction, forced refresh, stale-policy behavior, and source viewing after a process restart.

#### First-slice boundaries

- Keep local-path caching out of the first slice because uncommitted and untracked changes have no cheap single freshness token.
- Keep PR-head analysis out of the first slice because it has different full-history and diff requirements.
- Do not add a renderer artifact-contract change. Commit provenance uses the existing optional `target.vcs` fields, while cache outcome remains part of the web-generate response.

## 2. Spec

Author: Codex  
Date: 2026-07-13  
Status: Implemented  
Surface: CLI web server and launcher

### Problem

- Restarting `meridian web` discarded every remote clone and generated graph.
- Opening an unchanged repository repeated both network cloning and CPU-heavy extraction.
- Persisting only the artifact would break source viewing because `/api/source` also needs the analyzed checkout.
- Source-derived graph ids could be reused after a commit or analysis setting changed, allowing old tabs to observe replaced graph state.

### What we built

Remote generation now resolves the selected remote ref, stores a shallow checkout under its actual commit SHA, and stores validated artifacts separately by analysis configuration. A cache hit reuses both across process restarts and skips extraction. Remote graph ids include canonical repository identity, commit, and analysis identity. The artifact records commit provenance through the existing `target.vcs` contract.

### Success criteria

- [x] First remote generation reports `cache: "miss"` and runs source plus extraction stages.
- [x] Reopening the unchanged repository after a process restart reports `cache: "hit"` and skips extraction.
- [x] Source viewing remains available from the retained immutable checkout.
- [x] A changed remote commit produces a new checkout, artifact, and graph id.
- [x] Different subdirectories reuse one checkout but receive different artifacts.
- [x] Corrupt or incompatible artifacts are rejected and regenerated.
- [x] Clone credentials are never persisted.
- [x] Cache directories are private where supported, expire after 30 days of non-use, and never prune through symlinks.
- [x] CLI tests and typechecking pass.

### Out of scope

- Local-path caching, because dirty and untracked changes lack one cheap freshness token.
- PR-head analysis caching, because it requires full history and diff-specific state.
- Serving stale cache entries when remote freshness checks fail.
- Changing the renderer artifact contract.

### Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Store checkouts and artifacts separately | Multiple subdirectory or language analyses can share one expensive checkout |
| 2 | Address checkouts by full commit SHA | Content is immutable and old tabs keep a stable source tree |
| 3 | Use 24-hex-character opaque repository and analysis keys | Provides ample local collision resistance without exceeding Windows path limits |
| 4 | Resolve the remote ref before every reuse | An unchanged commit is the freshness proof |
| 5 | Fail closed when remote freshness cannot be confirmed | Avoids presenting an unverified stale graph as current |
| 6 | Validate cached artifacts before serving them | Disk corruption or incompatible metadata becomes an honest miss |
| 7 | Publish complete staging directories by rename | A crash or competing process cannot expose a partial cache entry |
| 8 | Expose `--refresh-cache` | Users can force re-extraction while retaining the unchanged checkout |
| 9 | Expire entries after 30 days without access | Bounds persistent private-source storage without removing active recent entries |

### Edge cases

| Case | Behavior |
|---|---|
| Branch moves between `ls-remote` and clone | The path and artifact use the actual `git rev-parse HEAD` result |
| Explicit ref names a tag | The commit is cached, but `target.vcs.branch` is omitted rather than mislabeling the tag |
| Two processes publish the same entry | The first complete rename wins and the loser discards its staging directory |
| Cached artifact or metadata is malformed | Remove only that analysis entry and regenerate |
| Cached checkout no longer matches its commit | Remove only that checkout entry and clone again |
| Selected subdirectory is a symlink outside the clone | Reject it before extraction and source serving |
| Remote lookup fails | Return the Git failure; do not silently use stale data |
| `MERIDIAN_VALUE_REFS` changes | The analysis key changes and a new artifact is generated |

### Key files

| Path | Change |
|---|---|
| `packages/cli/src/server/web-cache.ts` | NEW: artifact cache orchestration and compatibility checks |
| `packages/cli/src/server/web-cache-checkout.ts` | NEW: remote revision lookup and immutable checkout publication |
| `packages/cli/src/server/web-cache-storage.ts` | NEW: platform paths, private writes, publication, and expiry |
| `packages/cli/src/server/web-generation.ts` | NEW: remote cached and local uncached generation flows |
| `packages/cli/src/server/web-graph.ts` | EDIT: retain HTTP streaming and serving responsibilities only |
| `packages/cli/src/server/web-request.ts` | EDIT: refresh input and commit/configuration-pinned ids |
| `packages/cli/src/server/web-server.ts` | EDIT: cache context and in-flight job sharing |
| `packages/cli/src/artifact-header.ts` | EDIT: stamp optional VCS provenance |
| `packages/cli/src/extract-pipeline.ts` | EDIT: accept caller-resolved VCS provenance |
| `packages/cli/src/program.ts` | EDIT: add `web --refresh-cache` |
| `packages/cli/web-ui/index.html` | EDIT: label cache-hit progress honestly |
| `packages/cli/src/server/web-cache.test.ts` | NEW: focused cache behavior coverage |

## 3. Tasks

1. [x] Add VCS provenance inputs to artifact construction.
2. [x] Add platform-aware persistent storage with private permissions, atomic files, immutable directory publication, and 30-day expiry.
3. [x] Add remote ref resolution, actual checkout SHA verification, normalized repository identity, and credential-free metadata.
4. [x] Add analysis identity, artifact validation, warning retention, corruption recovery, and forced refresh.
5. [x] Split web generation from HTTP transport and register commit-pinned graph/source pairs.
6. [x] Add cache-aware progress copy and the `--refresh-cache` CLI escape hatch.
7. [x] Add focused cache and symlink-containment tests.
8. [x] Run adversarial review and fix canonical extraction-root containment.

Suggested commit command, not executed: `git commit -m "feat(web): cache remote graph analysis by commit"`

## 4. Manual verification

### Setup

Build the CLI bundle with `pnpm --dir packages/cli exec tsup`, set `MERIDIAN_CACHE_DIR` to an isolated directory, and start `meridian web --no-open`.

| What to do | Expected | Result | Notes |
|---|---|---|---|
| Generate `sindresorhus/p-limit` into an empty cache | `source`, `extract`, `done`; cache miss | [x] pass | 2.733 seconds, 13 nodes and 15 edges |
| Stop and restart the server, then generate it again | `source`, `done`; cache hit | [x] pass | 0.669 seconds, same graph id |
| Read `/api/graph` after restart | Artifact contains the actual commit | [x] pass | `42599ebbbb1228a5bdab381fcf8f4ac20eb8d551` |
| Read `/api/source` after restart | Cached checkout still serves code | [x] pass | HTTP 200 |
| Load the cached graph page in Chromium | Page loads with no browser errors | [x] pass | No console or page errors; source HTTP 200 |
| Type an unchanged repo/ref on the landing page | After branches load, the probe reports `Cached blueprint ready`; submit skips progress entirely | [x] pass | `sindresorhus/ky`; graph opened with no browser errors |
| Type an uncached repo/ref | After branches load, the probe reports a miss; preparation starts at repository fetch with no cache step | [x] pass | `sindresorhus/p-limit`; graph opened with no browser errors |
| Reopen an unchanged PR after recreating server context | PR checkout and artifact are reused without clone or extraction | [x] pass | Same commit-pinned graph id and persistent source root |
| Move only the PR base branch | PR analysis is invalidated despite an unchanged head | [x] pass | New graph id, checkout, and extraction |
| Restart the real web server and reopen PR #83 for `sindresorhus/p-map` | Base and PR graphs both survive restart | [x] pass | Base and checkout hit; PR stream emitted only `done` with `cache: hit` |
| Run CLI tests | All CLI tests pass | [x] pass | 28 files, 236 tests |
| Run repository typechecking | All packages typecheck | [x] pass | 6 package typechecks passed |
| Run all repository tests | Feature tests pass; note unrelated failures | [ ] fail | Two existing extractor TypeScript tests hard-code POSIX separators on Windows |

### Regression checks

- Local-path generation still reports `cache: "bypass"` and retains its existing flow.
- PR analysis remains on its existing full-history path.
- One-shot JSON and NDJSON generate responses retain their existing required fields.
- Source serving rejects lexical escapes, file symlinks, and now linked extraction roots.

### Quality bar reminders

- Cache modules remain under 200 lines and have single responsibilities.
- Tokens are used only by the credential-safe Git runner and never written to disk.
- Cache ids are built through dedicated identity helpers rather than path string concatenation.
- New comments explain security and lifecycle reasons.
- Renderer and artifact contracts remain backward compatible.
