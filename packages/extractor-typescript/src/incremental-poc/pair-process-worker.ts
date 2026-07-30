import { readFileSync } from "node:fs";
import { extractRevisionCandidate } from "./extract-revision";
import type { RevisionExtractionRequest } from "./model";

const requestPath = process.argv[2];
if (!requestPath) {
  throw new Error("usage: node --import tsx pair-process-worker.ts <request.json>");
}

const input = JSON.parse(readFileSync(requestPath, "utf8")) as {
  request: RevisionExtractionRequest;
  ephemeralPairCacheDir: string;
};
const run = await extractRevisionCandidate(input.request, {
  ephemeralPairCacheDir: input.ephemeralPairCacheDir,
});
process.stdout.write(`${JSON.stringify({
  result: run.result,
  manifest: run.manifest,
  metrics: run.metrics,
})}\n`);
