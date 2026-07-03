/**
 * Spawns the bundled stdlib analyzer (`python/analyze.py`) and parses its JSON. The script
 * ships in the package's `python` dir (see package.json `files`), so it resolves relative to
 * the compiled `dist/index.js` and works from an installed package too.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AnalyzeOutput } from "./types";

const ANALYZER_PATH = fileURLToPath(new URL("../python/analyze.py", import.meta.url));
const INTERPRETERS = ["python3", "python"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function runPythonAnalyzer(root: string): AnalyzeOutput {
  return parseOutput(spawnAnalyzer(root));
}

function spawnAnalyzer(root: string): string {
  for (const interpreter of INTERPRETERS) {
    const result = spawnSync(interpreter, [ANALYZER_PATH, root], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        continue; // this interpreter is not on PATH; try the next name
      }
      throw new Error(`failed to run ${interpreter}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`${interpreter} analyze.py exited with ${result.status}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
  throw new Error(
    `no usable Python interpreter found (tried ${INTERPRETERS.join(", ")}); the Python extractor needs Python 3`,
  );
}

function parseOutput(stdout: string): AnalyzeOutput {
  try {
    return JSON.parse(stdout) as AnalyzeOutput;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not parse analyzer output as JSON: ${reason}`);
  }
}
