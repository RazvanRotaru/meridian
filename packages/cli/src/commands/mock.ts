/**
 * `mock-telemetry`: mint a deterministic mock overlay for one explicit environment.
 *
 * The same `buildMockOverlay` that `view --overlay mock` serves on the fly is used here, so a
 * persisted overlay is byte-identical to a previewed one. `--env` is mandatory and never
 * defaults — the never-default-prod rule applies to written artifacts too.
 */

import { buildMockOverlay } from "@meridian/core/mock";
import type { GraphArtifact, Overlay } from "@meridian/core";
import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile, writeJsonAtomic } from "../json-io";
import { validateOrThrow } from "../validation";
import { pinnedIsoOrUndefined } from "../clock";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { normalizeTelemetryEnvironment } from "../telemetry-environment";

export interface MockOptions extends GlobalOptions {
  env: string;
  out?: string;
  seed: string;
}

export function runMock(graph: string, options: MockOptions): void {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const graphPath = resolveAgainst(cwd, graph);
  const { artifact } = validateOrThrow(readJsonFile(graphPath), `graph ${graphPath}`);
  const env = normalizeTelemetryEnvironment(options.env);
  const outPath = resolveAgainst(cwd, options.out ?? defaultOut(env));
  const overlay = mint(artifact, env, options);
  writeJsonAtomic(outPath, overlay);
  report(reporter, overlay, outPath);
}

function defaultOut(env: string): string {
  return `blueprint.overlay.${env}.json`;
}

function mint(artifact: GraphArtifact, env: string, options: MockOptions): Overlay {
  return buildMockOverlay(artifact, env, {
    seed: options.seed,
    generatedAt: pinnedIsoOrUndefined(),
  });
}

function report(reporter: Reporter, overlay: Overlay, outPath: string): void {
  const nodeCount = Object.keys(overlay.metricsByNodeId).length;
  reporter.info(`overlay     mock env=${overlay.env} seed='${overlay.deterministic?.seed ?? ""}'`);
  reporter.info(`metrics     ${nodeCount} nodes`);
  reporter.info(`wrote       ${outPath}`);
  reporter.payload({
    out: outPath,
    kind: overlay.kind,
    env: overlay.env,
    seed: overlay.deterministic?.seed ?? "",
    nodeCount,
  });
}
