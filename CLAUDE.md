# CLAUDE.md

Context for Claude Code working in this repo. Read this first.

## What this is

`meridian` turns a codebase into an interactive, Unreal-Blueprints-style graph of its call flow.
Two halves joined by one contract: **extractors** (source → a versioned graph-JSON artifact) and a
**renderer** (artifact → an interactive dark-mode SPA). A CLI ties them together; `meridian web`
clones a GitHub repo and does it in the browser.

## Architecture

pnpm/TypeScript monorepo, ESM throughout. Dependencies point **inward to `@meridian/core`** (the
frozen contract); nothing depends on the CLI or renderer.

```
packages/core                  the contract — zod schema (source of truth) → JSON Schema, the
                               node-id grammar (ids.ts), two-tier validateArtifact, overlay types,
                               the LanguageExtractor interface, aggregateEdges/collapseToDepth,
                               materializeBoundaryNodes.  @meridian/core/mock = NODE-ONLY subpath.
packages/extractor-typescript  ts-morph adapter (TS/TSX incl. JSX renders edges).
packages/extractor-python      spawns a bundled stdlib-ast analyzer (python/*.py) + a TS adapter.
packages/cli                   commander CLI: generate / view / web / mock-telemetry.
packages/renderer              React 19 + @xyflow/react + elkjs SPA (Vite).
examples/{orders-service, orders-service-py, shopfront}   fixtures used by golden + e2e tests.
knowledge/adr/0001-...md       THE contract decision. Read it before touching the schema.
```

## The contract (ADR 0001) — the load-bearing idea

- **One stable `node.id` = `<lang>:<modulePath>[#<qualname>][~n]`** (a generalized `__qualname__`).
  It is simultaneously the graph key, the React Flow node id, and the telemetry join key. Never mint
  a parallel id.
- Nodes are **flat + `parentId`** (containment by reference, not nested trees, not edges). Edge/node
  `kind`s are an **open vocabulary** (pattern-validated + warn-lint); the only closed enum is
  `edge.resolution` (`resolved | external | unresolved`).
- **Honest resolution:** static analysis can't resolve everything, so every edge carries a
  `resolution`; unresolved/external targets are `ext:` / `unresolved:` pseudo-ids.
- **Never-prod is in the data:** `service.name` / `deployment.environment.name` never appear in an
  artifact; the top-level `telemetry` contract asserts `serviceDefaulting: "forbidden"`. The renderer
  mirrors it (env selector mandatory, `defaultEnv` always null).
- Extractors are **pure graph producers** — they return nodes/edges, NOT the artifact header. The CLI
  (`extract-pipeline.ts` → `artifact-header.ts`) stamps schemaVersion/generator/target/telemetry.
- `validateArtifact` is two-tier (zod shape + cross-array invariants). `generate` fails **closed**
  (writes nothing on error); `view`/`web` are lenient (warn-level) so a new extractor isn't blocked.

## Commands

```bash
pnpm install
pnpm build            # tsup for libs, vite for the renderer (topological order)
pnpm test             # ~100 vitest tests across packages
pnpm typecheck
pnpm --filter @meridian/cli e2e     # headless-Chromium e2e (needs: npx playwright install chromium)

# Run the CLI without a global install:
node packages/cli/dist/bin.js generate examples/orders-service -o /tmp/g.json
node packages/cli/dist/bin.js view /tmp/g.json --overlay mock --env staging
node packages/cli/dist/bin.js web sindresorhus/ky
```

`meridian view`/`web` serve the renderer from `packages/cli/renderer-dist` — after changing the
renderer, run `pnpm --filter @meridian/cli copy-renderer` (or `prepack`).

## Gotchas (these will bite you)

- **esbuild EACCES after `pnpm install`.** pnpm 10 skips dependency build scripts; the
  `@esbuild/linux-x64` binary can land non-executable and tsup/vite fail. Fix:
  `find node_modules/.pnpm -path '*@esbuild*/bin/esbuild' -exec chmod +x {} \;` (re-run after each install).
- **In the TS extractor, import `ts` / `SyntaxKind` / `Node` from `"ts-morph"`, NEVER from
  `"typescript"`.** ts-morph bundles its own TS; a separate `typescript` desyncs SyntaxKind/Node identity.
- **`@meridian/core/mock` uses `node:crypto`** — it's a node-only subpath; never import it into the
  browser bundle. Core's main entry is browser-clean.
- **ELK:** `hierarchyHandling: INCLUDE_CHILDREN` goes on the ROOT graph only (per-subgraph throws).
  Import `elkjs/lib/elk.bundled.js`. ELK child coords are parent-relative == React Flow `parentId`.
- **React Flow has no built-in expand/collapse** — it's ours (derive/computeVisible + liftEdges).
- **TS 6 errors on deprecated `baseUrl`** (tsup's dts injects one) — `tsconfig.base.json` sets
  `"ignoreDeprecations": "6.0"`; keep it.
- **`web` clones arbitrary repos** — the security is in `server/clone.ts` + `git-exec.ts`: source
  allowlist, argv-only spawn with a `--` URL fence, token only via `http.extraHeader` (scrubbed from
  logs), subdir `..`-escape rejection, 90s timeout, temp always cleaned. Don't weaken these.

## Conventions

- **Clean Code** is the house standard (`.claude/skills/clean-code`): small single-purpose functions,
  files ≤200 lines, meaningful names, caller-above-callee, comments explain *why*.
- ESM, `moduleResolution: "Bundler"` — import our own modules **without** `.js` extensions.
- Libs build with **tsup**; the renderer with **vite**. Tests are **vitest**; e2e uses **playwright**.
- Node-id/edge-id construction lives ONLY in `core/ids.ts` + `core/assembly.ts` — build/parse through
  those helpers, never string-concat ids by hand.

## Adding a new language extractor (the extension pattern)

Implement `LanguageExtractor` (see `core/extractor.ts`) in a new `packages/extractor-<lang>`:
`detect(root)`, `extract(options) → { language, nodes, edges, stats, diagnostics }`. Build node ids
with `buildNodeId`, fold edges with `aggregateEdges`, collapse with `collapseToDepth`. Register it in
`cli/src/extract-pipeline.ts`'s `ExtractorRegistry`. Add a golden test against a fixture. The schema,
renderer, and CLI need **no** changes — that's the whole point.

## Working style here

- Verify visually when touching the renderer: `pnpm --filter @meridian/cli build && copy-renderer`,
  then drive `view`/`web` headless with Playwright and screenshot (see prior e2e scripts).
- After a feature, run an adversarial review over the new code before committing — it has repeatedly
  found real bugs the happy path missed (cycle hangs, blank-canvas focus, module-sourced renders).
