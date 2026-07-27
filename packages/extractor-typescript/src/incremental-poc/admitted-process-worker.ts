import { readFileSync } from "node:fs";
import {
  isRevisionShardAdmissionCapability,
  type RevisionShardAdmissionVerifier,
} from "./admission";
import { extractRevisionCandidate } from "./extract-revision";
import type { RevisionExtractionRequest } from "./model";

interface WorkerRequest {
  request: RevisionExtractionRequest;
  verifier: RevisionShardAdmissionVerifier;
}

const requestPath = process.argv[2];
if (requestPath === undefined) {
  throw new Error("usage: node --import tsx admitted-process-worker.ts <request.json>");
}
const input = JSON.parse(readFileSync(requestPath, "utf8")) as WorkerRequest;
if (
  input === null
  || typeof input !== "object"
  || !isRevisionShardAdmissionCapability(input.verifier)
  || input.verifier.kind !== "verifier"
) {
  throw new TypeError("fresh admitted worker requires a verifier-only admission capability");
}

const candidate = await extractRevisionCandidate(input.request, {
  requiredAdmission: input.verifier,
});
process.stdout.write(`${JSON.stringify({
  result: candidate.result,
  manifest: candidate.manifest,
  metrics: candidate.metrics,
  units: candidate.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: unit.value,
  })),
})}\n`);
