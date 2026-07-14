/**
 * Public orchestration for local, opt-in synthetic execution.
 *
 * Repository configuration chooses an exported function/factory and JSON input. Local execution
 * uses a scrubbed, permission-gated runner child; untrusted PR execution enters through the OCI
 * backend exported below. There is deliberately no unrestricted PR fallback.
 */

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import {
  boundedSyntheticJsonValueSchema,
  SYNTHETIC_MANIFEST_VERSION,
  syntheticFieldWatchersSchema,
  syntheticInputOverridesSchema,
  syntheticExecutionManifestSchema,
  syntheticExecutionSchema,
} from "@meridian/core";
import type {
  GraphArtifact,
  JsonValue,
  SyntheticExecution,
  SyntheticExecutionManifest,
  SyntheticExecutionManifestEntry,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import { executeSyntheticChild, executeSyntheticChildInsideOci, nodePermissionFlag } from "./synthetic-child";
import { compileInstrumentedProjectInSandbox, syntheticWorkerBundlePath } from "./synthetic-compiler-child";
import { SyntheticExecutionError } from "./synthetic-error";
import { syntheticSourceFingerprint } from "./synthetic-fingerprint";
import { discoverSyntheticManifestFiles } from "./synthetic-manifest-files";
import { compileInstrumentedProject } from "./synthetic-project";

export { SyntheticExecutionError } from "./synthetic-error";
export type { SyntheticExecutionErrorCode } from "./synthetic-error";
export { syntheticSourceFingerprint } from "./synthetic-fingerprint";
export { runSyntheticScenarioInOci, syntheticPrSandboxRuntimeSupported } from "./synthetic-oci";
export type { RunSyntheticScenarioInOciRequest } from "./synthetic-oci";

export const SYNTHETIC_MANIFEST_FILE = "meridian.synthetic.json";
const MAX_MANIFEST_BYTES = 256 * 1024;

/** Servers use this to avoid advertising an action that the local runtime cannot isolate. */
export function syntheticExecutionRuntimeSupported(): boolean {
  return nodePermissionFlag() !== null;
}

/** Defense-in-depth compiler-child availability. This is not sufficient for untrusted PRs; those
 * must use syntheticPrSandboxRuntimeSupported and runSyntheticScenarioInOci. */
export function syntheticSandboxCompilationRuntimeSupported(): boolean {
  return nodePermissionFlag() !== null && syntheticWorkerBundlePath() !== null;
}

export interface RunSyntheticScenarioRequest {
  sourceRoot: string;
  artifact: GraphArtifact;
  scenarioId: string;
  /** Root selected when the browser advertised this scenario. Rechecking after the manifest is
   * reread closes the boot-to-run replacement race. */
  expectedRootId?: string;
  /** Source/config fingerprint advertised with the scenario. A mismatch means the graph must be
   * refreshed before any project compilation is attempted. */
  expectedSourceFingerprint?: string;
  input?: JsonValue;
  inputOverrides?: SyntheticInputOverride[];
  watchers?: SyntheticFieldWatcher[];
  /** A separate permission-gated compiler child for defense in depth. Untrusted PRs must use the
   * OCI API instead; this option never falls back to parent compilation. */
  compilationMode?: "trusted-parent" | "sandboxed-child";
}

/** Missing configuration is ordinary capability absence; malformed configuration is actionable. */
export function loadSyntheticScenarios(sourceRoot: string): SyntheticScenarioDescriptor[] {
  const manifest = readManifest(sourceRoot, false);
  return manifest?.scenarios.map(({ invoke: _invoke, ...descriptor }) => descriptor) ?? [];
}

export async function runSyntheticScenario(request: RunSyntheticScenarioRequest): Promise<SyntheticExecution> {
  return runSyntheticScenarioWithIsolation(request, false);
}

/** Worker-only entry point. The caller must already be inside the hardened OCI boundary. */
export async function runSyntheticScenarioInsideOci(
  request: RunSyntheticScenarioRequest,
): Promise<SyntheticExecution> {
  return runSyntheticScenarioWithIsolation({ ...request, compilationMode: "trusted-parent" }, true);
}

async function runSyntheticScenarioWithIsolation(
  request: RunSyntheticScenarioRequest,
  insideOci: boolean,
): Promise<SyntheticExecution> {
  const permissionFlag = nodePermissionFlag();
  if (permissionFlag === null && !insideOci) {
    throw new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      "Synthetic execution requires Node 24.12 or newer with filesystem and network permission controls.",
    );
  }
  const sourceRoot = canonicalDirectory(request.sourceRoot);
  const manifest = readManifest(sourceRoot, true)!;
  const scenario = manifest.scenarios.find((candidate) => candidate.id === request.scenarioId);
  if (!scenario) {
    throw new SyntheticExecutionError("scenario-not-found", 404, `Unknown synthetic scenario '${request.scenarioId}'.`);
  }
  if (request.expectedRootId !== undefined && scenario.rootId !== request.expectedRootId) {
    throw new SyntheticExecutionError("invalid-request", 409, "Synthetic scenario changed after it was selected; reload the graph.");
  }
  validateScenarioAgainstArtifact(scenario, request.artifact);
  assertExpectedSourceFingerprint(request, sourceRoot);
  const parsedInput = boundedSyntheticJsonValueSchema.safeParse(
    request.input === undefined ? scenario.defaultInput : request.input,
  );
  if (!parsedInput.success) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic scenario input must be bounded JSON data.");
  }
  const parsedOverrides = syntheticInputOverridesSchema.safeParse(request.inputOverrides ?? []);
  const parsedWatchers = syntheticFieldWatchersSchema.safeParse(request.watchers ?? []);
  if (!parsedOverrides.success || !parsedWatchers.success) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic runtime controls must be bounded and valid.");
  }

  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "meridian-synthetic-")));
  try {
    const compilation = request.compilationMode === "sandboxed-child"
      ? await compileInstrumentedProjectInSandbox(permissionFlag!, sourceRoot, tempRoot, request.artifact, scenario)
      : compileInstrumentedProject(sourceRoot, tempRoot, request.artifact, scenario);
    // Recheck immediately before execution so an ordinary editor save during compilation cannot
    // run an artifact assembled from mixed inputs. The OCI worker repeats this check internally.
    assertExpectedSourceFingerprint(request, sourceRoot);
    const runnerConfig = {
      scenario,
      input: parsedInput.data,
      inputOverrides: parsedOverrides.data,
      watchers: parsedWatchers.data,
      entryModule: `./${compilation.entryModule}`,
      nodeNames: compilation.nodeNames,
      warnings: compilation.warnings,
    };
    const raw = insideOci
      ? await executeSyntheticChildInsideOci(tempRoot, runnerConfig)
      : await executeSyntheticChild(permissionFlag!, tempRoot, runnerConfig);
    const parsed = syntheticExecutionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SyntheticExecutionError("invalid-result", 500, "Synthetic runner returned an invalid execution result.");
    }
    return parsed.data;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertExpectedSourceFingerprint(request: RunSyntheticScenarioRequest, sourceRoot: string): void {
  if (request.expectedSourceFingerprint !== undefined
    && syntheticSourceFingerprint(sourceRoot, request.artifact) !== request.expectedSourceFingerprint) {
    throw new SyntheticExecutionError("invalid-request", 409, "Synthetic scenario source changed after it was selected; reload the graph.");
  }
}

function readManifest(sourceRoot: string, required: boolean): SyntheticExecutionManifest | null {
  const root = canonicalDirectory(sourceRoot);
  const files = discoverSyntheticManifestFiles(root);
  if (files.length === 0) {
    if (required) {
      throw new SyntheticExecutionError("scenario-not-found", 404, "This source does not define synthetic execution scenarios.");
    }
    return null;
  }
  try {
    const scenarios: SyntheticExecutionManifestEntry[] = [];
    for (const file of files) {
      if (statSync(file.absolutePath).size > MAX_MANIFEST_BYTES) {
        throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is too large.");
      }
      const parsed = syntheticExecutionManifestSchema.safeParse(JSON.parse(readFileSync(file.absolutePath, "utf8")));
      if (!parsed.success) {
        throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
      }
      scenarios.push(...parsed.data.scenarios.map((scenario) => rebaseScenario(scenario, file.logicalDirectory)));
    }
    const combined = syntheticExecutionManifestSchema.safeParse({
      manifestVersion: SYNTHETIC_MANIFEST_VERSION,
      scenarios,
    });
    if (!combined.success) {
      throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
    }
    return combined.data;
  } catch (error) {
    if (error instanceof SyntheticExecutionError) throw error;
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest could not be read.");
  }
}

function rebaseScenario(
  scenario: SyntheticExecutionManifestEntry,
  directory: string,
): SyntheticExecutionManifestEntry {
  if (directory === "") return scenario;
  const separator = scenario.rootId.indexOf(":");
  if (separator < 1) {
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
  }
  return {
    ...scenario,
    rootId: `${scenario.rootId.slice(0, separator + 1)}${posix.join(directory, scenario.rootId.slice(separator + 1))}`,
    invoke: {
      ...scenario.invoke,
      module: posix.join(directory, scenario.invoke.module),
    },
  };
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source root is unavailable.");
  }
}

function validateScenarioAgainstArtifact(scenario: SyntheticExecutionManifestEntry, artifact: GraphArtifact): void {
  if (artifact.target.language !== "typescript" && artifact.target.language !== "javascript") {
    throw new SyntheticExecutionError("unsupported-scenario", 422, "Synthetic execution POC currently supports TypeScript only.");
  }
  const root = artifact.nodes.find((node) => node.id === scenario.rootId);
  if (!root || (root.kind !== "function" && root.kind !== "method")) {
    throw new SyntheticExecutionError("unsupported-scenario", 422, "Synthetic scenario root is not a callable in this graph.");
  }
}
