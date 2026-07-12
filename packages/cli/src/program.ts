/**
 * Commander wiring: the global options every command shares and the three subcommands.
 *
 * Each action forwards `optsWithGlobals()` so a command runner sees its own flags merged with
 * `--cwd/--json/--quiet` as one options object — the runners never reach back into commander.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { readCliVersion } from "./version";
import { runGenerate } from "./commands/generate";
import type { GenerateOptions } from "./commands/generate";
import { runMock } from "./commands/mock";
import type { MockOptions } from "./commands/mock";
import { runView } from "./commands/view";
import type { ViewOptions } from "./commands/view";
import { parseFailUnder, runCoverage } from "./commands/coverage";
import type { CoverageOptions } from "./commands/coverage";
import { runLink } from "./commands/link";
import type { LinkOptions } from "./commands/link";
import { runWeb } from "./commands/web";
import type { WebOptions } from "./commands/web";

const DEPTH_CHOICES = ["package", "module", "class", "function"];

export function buildProgram(): Command {
  const program = new Command();
  // Set before registering subcommands so they inherit it (via copyInheritedSettings) and
  // route their usage failures to bin's handler instead of exiting the process themselves.
  program.exitOverride();
  program
    .name("meridian")
    .description("Visualize a codebase as drill-down Unreal-Engine-Blueprints boxes.")
    .version(readCliVersion())
    .option("--cwd <dir>", "resolve relative paths against this directory")
    .option("--json", "emit a machine-readable summary on stdout")
    .option("--quiet", "suppress human progress output");
  registerGenerate(program);
  registerMock(program);
  registerView(program);
  registerWeb(program);
  registerCoverage(program);
  registerLink(program);
  return program;
}

function registerGenerate(program: Command): void {
  program
    .command("generate [path]")
    .description("Extract a source tree into a validated graph artifact")
    .option("-o, --out <file>", "artifact output path", "meridian.graph.json")
    .option("--lang <language>", "language extractor (default: auto-detect by source files)")
    .addOption(new Option("--depth <level>", "deepest kind to keep").choices(DEPTH_CHOICES).default("function"))
    .option("--include <globs...>", "source globs to include")
    .option("--exclude <globs...>", "source globs to exclude")
    .option("--tsconfig <file>", "tsconfig path (auto <path>/tsconfig.json if present)")
    .option("--include-external", "keep external library/builtin/package/alias dependencies as boundary nodes")
    .option("--include-unresolved", "keep dynamic/unresolved call targets as boundary nodes")
    .option("--exclude-tests", "drop test files from the graph (default: include them, tagged 'test')")
    .option("--value-refs", "emit 'references' edges for imported symbols used as values (surfaces why bare imports exist)")
    .option("--changed-since <ref>", "tag nodes changed since the merge-base with <ref> (a PR's diff) 'changed'")
    .action((path, _options, command) => runGenerate(path ?? ".", command.optsWithGlobals() as GenerateOptions));
}

function registerMock(program: Command): void {
  program
    .command("mock-telemetry [graph]")
    .alias("mock")
    .description("Mint a deterministic mock telemetry overlay for one environment")
    .requiredOption("--env <env>", "environment to synthesize (required; never defaults)")
    .option("-o, --out <file>", "overlay output path (default meridian.overlay.<env>.json)")
    .option("--seed <seed>", "deterministic seed", "")
    .action((graph, _options, command) =>
      runMock(graph ?? "meridian.graph.json", command.optsWithGlobals() as MockOptions),
    );
}

function registerView(program: Command): void {
  program
    .command("view [graph]")
    .description("Serve the bundled renderer against a graph artifact")
    .option("--port <number>", "preferred port (walks forward if busy)", parsePort, 4173)
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--no-open", "do not open a browser")
    .option("--overlay <source>", "overlay source: a file path or 'mock'")
    .option("--env <env>", "environment (also read from BLUEPRINT_ENV)")
    .option("--source-root <dir>", "serve source for code view from this directory")
    .action((graph, _options, command) =>
      runView(graph ?? "meridian.graph.json", command.optsWithGlobals() as ViewOptions),
    );
}

function registerWeb(program: Command): void {
  program
    .command("web [source]")
    .description("Serve a local web UI to clone, extract, and view any repo's call graph")
    .option("--port <number>", "preferred port (walks forward if busy)", parsePort, 4180)
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--no-open", "do not open a browser")
    .option("--github-client-id <id>", "GitHub OAuth app client id for sign-in (default: the project's app; also read from MERIDIAN_GITHUB_CLIENT_ID)")
    .action((source, _options, command) => runWeb(source, command.optsWithGlobals() as WebOptions));
}

function registerCoverage(program: Command): void {
  program
    .command("coverage [graph]")
    .description("Report static test coverage derived from the graph's call reachability")
    .option("--fail-under <percent>", "exit non-zero when coverage is below this percentage", parseFailUnder)
    .action((graph, _options, command) =>
      runCoverage(graph ?? "meridian.graph.json", command.optsWithGlobals() as CoverageOptions),
    );
}

function registerLink(program: Command): void {
  program
    .command("link <graphs...>")
    .description("Join two or more graph artifacts into one system graph via their IPC channel keys")
    .option("-o, --out <file>", "linked artifact output path", "meridian.system.json")
    .option("--name <name>", "display name for the linked system (default: the joined source names)")
    .action((graphs, _options, command) => runLink(graphs, command.optsWithGlobals() as LinkOptions));
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer in 1..65535");
  }
  return port;
}
