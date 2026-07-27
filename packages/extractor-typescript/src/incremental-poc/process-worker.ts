import { readFileSync } from "node:fs";
import { extractRevisionWithCache } from "./extract-revision";
import type { RevisionExtractionRequest } from "./model";

const requestPath = process.argv[2];
if (!requestPath) {
  throw new Error("usage: node --import tsx process-worker.ts <request.json>");
}

const request = JSON.parse(readFileSync(requestPath, "utf8")) as RevisionExtractionRequest;
const run = await extractRevisionWithCache(request);
process.stdout.write(`${JSON.stringify({
  manifest: run.manifest,
  metrics: run.metrics,
  manifestPath: run.manifestPath,
})}\n`);
