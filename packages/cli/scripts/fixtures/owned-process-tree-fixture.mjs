#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const fixturePath = new URL(import.meta.url).pathname;
const mode = process.argv[2];
const termResistantLeaf = process.argv.includes("--term-resistant-leaf");
const leaderExitsWithHelper = process.argv.includes("--leader-exits-with-helper");
const ownerToken = process.env.MERIDIAN_BENCHMARK_OWNER_TOKEN;
const ownerMarker = typeof ownerToken === "string" ? `--meridian-owner-token=${ownerToken}` : null;

if (mode === "root") {
  const worker = spawn(process.execPath, [
    fixturePath,
    "worker",
    ...(ownerMarker === null ? [] : [ownerMarker]),
    ...(termResistantLeaf ? ["--term-resistant-leaf"] : []),
    ...(leaderExitsWithHelper ? ["--leader-exits-with-helper"] : []),
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  registerDetachedLeader(worker.pid);

  worker.once("error", (error) => {
    process.stderr.write(`[owned-tree-fixture] worker spawn failed: ${error.message}\n`);
    process.exit(2);
  });
  worker.once("message", (message) => {
    if (message?.type !== "worker-ready") return;
    process.stdout.write(`${JSON.stringify({
      type: "ready",
      rootPid: process.pid,
      workerPid: worker.pid,
      gitPid: message.gitPid,
      ...(message.helperPid ? { helperPid: message.helperPid } : {}),
    })}\n`);
  });
  process.on("message", (message) => {
    if (message?.type === "exit-root") process.exit(0);
  });
  keepAlive();
} else if (mode === "worker") {
  const gitLikeChild = spawn(process.execPath, [
    fixturePath,
    "git",
    ...(ownerMarker === null ? [] : [ownerMarker]),
    ...(termResistantLeaf ? ["--term-resistant"] : []),
    ...(leaderExitsWithHelper ? ["--leader-exits-with-helper"] : []),
  ], {
    detached: true,
    stdio: leaderExitsWithHelper ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
  });
  registerDetachedLeader(gitLikeChild.pid);
  if (!leaderExitsWithHelper) gitLikeChild.unref();
  gitLikeChild.once("error", (error) => {
    process.stderr.write(`[owned-tree-fixture] git-like spawn failed: ${error.message}\n`);
    process.exit(3);
  });
  if (leaderExitsWithHelper) {
    gitLikeChild.once("message", (message) => {
      if (message?.type !== "helper-ready") return;
      gitLikeChild.once("exit", () => {
        process.send?.({ type: "worker-ready", gitPid: gitLikeChild.pid, helperPid: message.helperPid });
      });
    });
  } else {
    process.send?.({ type: "worker-ready", gitPid: gitLikeChild.pid });
  }
  process.on("disconnect", () => {
    // A reparented analysis worker must keep running after its original service leader exits.
  });
  keepAlive();
} else if (mode === "git") {
  if (leaderExitsWithHelper) {
    const helper = spawn(process.execPath, [fixturePath, "helper"], {
      detached: false,
      stdio: "ignore",
    });
    helper.unref();
    process.send?.({ type: "helper-ready", helperPid: helper.pid });
    setTimeout(() => process.exit(0), 25);
  }
  if (process.argv.includes("--term-resistant")) {
    process.on("SIGTERM", () => {
      // Exercise the cleanup path's bounded SIGKILL escalation.
    });
  }
  if (!leaderExitsWithHelper) keepAlive();
} else if (mode === "helper") {
  process.on("SIGTERM", () => {});
  keepAlive();
} else {
  process.stderr.write("usage: owned-process-tree-fixture.mjs root|worker|git\n");
  process.exit(64);
}

function keepAlive() {
  setInterval(() => {}, 60_000);
}

function registerDetachedLeader(pid) {
  const registryPath = process.env.MERIDIAN_BENCHMARK_OWNER_REGISTRY;
  if (typeof ownerToken !== "string" || typeof registryPath !== "string") return;
  appendFileSync(registryPath, `${JSON.stringify({
    version: 1,
    tokenDigest: createHash("sha256").update(ownerToken).digest("hex"),
    pid,
    parentPid: process.pid,
    processGroupId: pid,
  })}\n`, "utf8");
}
