/** Compose the dependency-free module executed inside the permission-gated child. */

import type {
  JsonValue,
  SyntheticExecutionManifestEntry,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
} from "@meridian/core";
import { SYNTHETIC_PROBE_SOURCE } from "./synthetic-probe-source";

export const SYNTHETIC_RESULT_PREFIX = "__MERIDIAN_SYNTHETIC_RESULT__";

export interface RunnerConfig {
  scenario: SyntheticExecutionManifestEntry;
  input: JsonValue;
  inputOverrides: SyntheticInputOverride[];
  watchers: SyntheticFieldWatcher[];
  entryModule: string;
  nodeNames: Record<string, string>;
  warnings: string[];
}

export function runnerSource(config: RunnerConfig): string {
  const serialized = JSON.stringify(config).replaceAll("</script", "<\\/script");
  return `import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { writeSync } from "node:fs";

const CONFIG = ${serialized};
const RESULT_PREFIX = ${JSON.stringify(SYNTHETIC_RESULT_PREFIX)};
const PROBE_GLOBAL = "__MERIDIAN_SYNTHETIC_PROBE__";
const MAX_DEPTH = 12;
const MAX_ITEMS = 512;
const MAX_NODES = 4096;
const MAX_STRING = 16384;
${SYNTHETIC_PROBE_SOURCE}

function ownPath(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      throw new Error("method path is unavailable");
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error("method receiver path must use own properties");
    }
    current = current[segment];
  }
  return current;
}

async function invoke() {
  const probe = new Probe(CONFIG, (result) => {
    writeSync(1, RESULT_PREFIX + JSON.stringify({ ok: true, result }) + "\\n");
    process.exit(0);
  });
  Object.defineProperty(globalThis, PROBE_GLOBAL, {
    value: probe,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const module = await import(CONFIG.entryModule);
  const exported = module[CONFIG.scenario.invoke.export];
  if (typeof exported !== "function") throw new Error("configured export is not callable");
  let output;
  let invocationError;
  try {
    if (CONFIG.scenario.invoke.method) {
      const target = await exported();
      const parts = CONFIG.scenario.invoke.method.split(".");
      const methodName = parts.pop();
      const receiver = ownPath(target, parts);
      const method = receiver?.[methodName];
      if (typeof method !== "function") throw new Error("configured method is not callable");
      probe.arm();
      output = await method.call(receiver, CONFIG.input);
    } else {
      probe.arm();
      output = await exported(CONFIG.input);
    }
  } catch (error) {
    if (probe.isControl(error) || probe.halted) return probe.finishStopped(CONFIG.input);
    invocationError = error;
  }
  if (probe.halted) return probe.finishStopped(CONFIG.input);
  return probe.finish(CONFIG.input, output, invocationError);
}

try {
  const result = await invoke();
  await new Promise((resolve) => process.stdout.write(
    RESULT_PREFIX + JSON.stringify({ ok: true, result }) + "\\n",
    resolve,
  ));
  process.exit(0);
} catch {
  await new Promise((resolve) => process.stdout.write(
    RESULT_PREFIX + JSON.stringify({ ok: false }) + "\\n",
    resolve,
  ));
  process.exit(0);
}
`;
}
