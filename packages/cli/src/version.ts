/**
 * The generator identity stamped into every artifact.
 *
 * The version is read from this package's own `package.json` at runtime (resolved relative
 * to the bundled `dist/bin.js`) so it tracks releases without a build-time constant. The
 * ts-morph major is part of the provenance string the ADR's `generator.version` carries.
 */

import { readFileSync } from "node:fs";

const TS_MORPH_MAJOR = "ts-morph@28";

export function readCliVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version: string };
  return manifest.version;
}

export function generatorVersion(): string {
  return `meridian@${readCliVersion()} (${TS_MORPH_MAJOR})`;
}
