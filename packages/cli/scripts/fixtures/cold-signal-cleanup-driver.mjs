#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { registerColdServiceSignalCleanup } from "../benchmark-pr-review-progressive.mjs";
import {
  createOwnedProcessTreeTracker,
  readProcessTable,
  terminateOwnedProcessTree,
} from "../owned-process-tree.mjs";

const [temporaryDirectory, markerPath] = process.argv.slice(2);
if (!temporaryDirectory
  || !basename(temporaryDirectory).startsWith("meridian-pr-review-cold-")
  || !markerPath) {
  throw new Error("signal cleanup fixture requires an owned temporary directory and marker path");
}

const ownerToken = randomBytes(32).toString("hex");
const registryPath = join(temporaryDirectory, "owned-processes.ndjson");
await writeFile(registryPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });

// The detached tree must never be started unless exact OS identity inspection is available. If this
// preflight fails, the caller retains the private registry root and no child has been spawned.
await readProcessTable();

const treeFixturePath = new URL("./owned-process-tree-fixture.mjs", import.meta.url);
const root = spawn(process.execPath, [treeFixturePath.pathname, "root", "--term-resistant-leaf"], {
  detached: true,
  env: {
    ...process.env,
    MERIDIAN_BENCHMARK_OWNER_TOKEN: ownerToken,
    MERIDIAN_BENCHMARK_OWNER_REGISTRY: registryPath,
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
root.stderr.pipe(process.stderr);
const ready = await readReadyLine(root, 8_000);
const tracker = createOwnedProcessTreeTracker(root.pid, {
  scanIntervalMs: 25,
  ownerToken,
  registryPath,
  isRootAlive: () => root.exitCode === null && root.signalCode === null,
});
await tracker.start();
await waitUntil(async () => {
  await tracker.scan();
  const registered = new Set(tracker.registeredProcesses().map((entry) => entry.pid));
  return [ready.rootPid, ready.workerPid, ready.gitPid].every((pid) => registered.has(pid));
}, 5_000);

registerColdServiceSignalCleanup(async () => {
  // Keep a measurable asynchronous boundary to prove the signal handler waits for cleanup.
  await new Promise((resolve) => setTimeout(resolve, 125));
  const evidence = await terminateOwnedProcessTree(tracker, {
    gracefulTimeoutMs: 300,
    killTimeoutMs: 2_000,
    pollIntervalMs: 25,
  });
  if (!evidence.verifiedEmpty) throw new Error("signal cleanup did not prove the owned tree absent");
  await rm(temporaryDirectory, { recursive: true, force: true });
  await writeFile(markerPath, `${JSON.stringify({
    type: "cleanup-complete",
    driverPid: process.pid,
    evidence,
  })}\n`, "utf8");
});

process.stdout.write(`${JSON.stringify({
  type: "ready",
  driverPid: process.pid,
  ...ready,
  registered: tracker.registeredProcesses(),
})}\n`);
setInterval(() => {}, 60_000);

function readReadyLine(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(() => finish(rejectReady, new Error("tree fixture readiness timed out")), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(output.slice(0, newline));
        if (parsed?.type !== "ready") throw new Error("unexpected tree fixture output");
        finish(resolveReady, parsed);
      } catch (error) {
        finish(rejectReady, error);
      }
    };
    const onError = (error) => finish(rejectReady, error);
    const onExit = (code, signal) => finish(
      rejectReady,
      new Error(`tree fixture exited before ready (code=${code}, signal=${signal})`),
    );
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitUntil(callback, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await callback()) return;
    if (Date.now() >= deadline) throw new Error("tracker did not register signal fixture descendants");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
