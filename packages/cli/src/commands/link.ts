/**
 * `link`: N per-repo graph artifacts → one system graph, joined purely by static evidence
 * (channel keys; concrete HTTP paths unified onto route templates). Fails closed like
 * `generate` — a validation error throws before anything is written.
 */

import { PORTS_EXTENSION, SCHEMA_VERSION, linkArtifacts } from "@meridian/core";
import type { GraphArtifact, JsonValue, LinkSource, Port } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile, writeJsonAtomic } from "../json-io";
import { validateOrThrow } from "../validation";
import { nowIso } from "../clock";
import { generatorVersion } from "../version";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";

export interface LinkOptions extends GlobalOptions {
  out: string;
  name?: string;
}

export function runLink(graphs: string[], options: LinkOptions): void {
  if (graphs.length < 2) {
    throw new CliError(EXIT.usage, "link needs at least two graph artifacts");
  }
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const sources = graphs.map((graph) => loadSource(resolveAgainst(cwd, graph)));
  const linked = linkArtifacts(uniquelyNamed(sources));
  const artifact = systemArtifact(linked, sources, options.name);
  const { warnings } = validateOrThrow(artifact, "linked artifact");
  const outPath = resolveAgainst(cwd, options.out);
  writeJsonAtomic(outPath, artifact);
  report(reporter, linked.stats, warnings, outPath);
}

function loadSource(graphPath: string): LinkSource & { language: string } {
  const { artifact } = validateOrThrow(readJsonFile(graphPath), `graph ${graphPath}`);
  return {
    name: artifact.target.name,
    nodes: artifact.nodes,
    edges: artifact.edges,
    ports: ((artifact.extensions?.[PORTS_EXTENSION] as unknown) ?? []) as Port[],
    language: artifact.target.language,
  };
}

/** Namespaces must be unique or two systems' ids collide; suffix duplicates deterministically. */
function uniquelyNamed<T extends { name: string }>(sources: T[]): T[] {
  const seen = new Map<string, number>();
  return sources.map((source) => {
    const count = (seen.get(source.name) ?? 0) + 1;
    seen.set(source.name, count);
    return count === 1 ? source : { ...source, name: `${source.name}-${count}` };
  });
}

function systemArtifact(
  linked: ReturnType<typeof linkArtifacts>,
  sources: Array<{ name: string; language: string }>,
  name: string | undefined,
): GraphArtifact {
  const languages = new Set(sources.map((source) => source.language));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    generator: { name: "meridian-link", version: generatorVersion() },
    target: {
      name: name ?? sources.map((source) => source.name).join("+"),
      root: ".",
      language: languages.size === 1 ? [...languages][0] : "mixed",
    },
    telemetry: {
      joinKey: "node.id",
      requiredRuntimeAttributes: ["service.name", "deployment.environment.name"],
      serviceDefaulting: "forbidden",
    },
    nodes: linked.nodes,
    edges: linked.edges,
    extensions: { [PORTS_EXTENSION]: linked.ports as unknown as JsonValue },
  };
}

function report(
  reporter: Reporter,
  stats: ReturnType<typeof linkArtifacts>["stats"],
  warnings: string[],
  outPath: string,
): void {
  reporter.info(`linked      ${stats.systems} systems through ${stats.channels} channel(s)`);
  reporter.info(`joins       ${stats.crossSystemChannels} cross-system, ${stats.httpTemplateJoins} via route templates`);
  if (stats.danglingChannels > 0) {
    reporter.info(`dangling    ${stats.danglingChannels} channel(s) have only one side — nobody answers`);
  }
  reporter.info(`validated   ok (${warnings.length} warnings)`);
  reporter.info(`wrote       ${outPath}`);
  reporter.payload({ out: outPath, ...stats });
}
