import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphGenerationGarbageCollector } from "./graph-generation-gc";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  localArtifactGenerations,
  prBaseArtifactEntry,
  prExactLookupFile,
  prHeadArtifactEntry,
  repositoryArtifactEntry,
} from "./graph-cache-layout";

const COMMIT = "a".repeat(40);
const BASE_COMMIT = "b".repeat(40);
const OTHER_BASE_COMMIT = "d".repeat(40);
const REPOSITORY_KEY = "1".repeat(24);
const OTHER_REPOSITORY_KEY = "2".repeat(24);
const SECURITY_DIGEST = "c".repeat(64);
const SUBDIR_KEY = "3".repeat(24);
const ANALYSIS_KEY = "4".repeat(24);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GraphGenerationGarbageCollector", () => {
  it("keeps hard roots and a byte/count-bounded current LRU", async () => {
    const root = temporaryRoot();
    const first = generation(root, artifactGeneration(root, REPOSITORY_KEY, "first"), 30);
    const second = generation(root, artifactGeneration(root, OTHER_REPOSITORY_KEY, "second"), 20);
    const hard = generation(
      root,
      portable(relative(root, finalizedGenerationDirectory(join(localArtifactGenerations(root), ".."), "hard"))),
      40,
    );
    current(dirnameOfGeneration(first), "first", 8_000);
    current(dirnameOfGeneration(second), "second", 9_000);
    const gc = collector(root, { now: () => 10_000, maxSoftEntries: 1, maxSoftBytes: 100 });

    const result = await gc.collect(rootAuthority([portable(relative(root, hard))]));

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(existsSync(hard)).toBe(true);
    expect(result).toMatchObject({ retainedGenerations: 2, quarantinedGenerations: 1 });
  });

  it("never enters unowned cache leaves while collecting canonical generation coordinates", async () => {
    const root = temporaryRoot();
    const legacyRepository = join(
      root,
      "pr-artifacts",
      REPOSITORY_KEY,
      COMMIT,
      BASE_COMMIT,
      ANALYSIS_KEY,
      "repo",
    );
    mkdirSync(legacyRepository, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacyRepository, "CLAUDE.md"), "repository instructions\n");
    const repositoryLink = join(legacyRepository, "GEMINI.md");
    symlinkSync("CLAUDE.md", repositoryLink);
    const candidate = generation(root, artifactGeneration(root, REPOSITORY_KEY, "canonical"), 10);

    const result = await collector(root).collect(rootAuthority());

    expect(result).toMatchObject({ quarantinedGenerations: 1 });
    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(repositoryLink, "utf8")).toBe("repository instructions\n");
  });

  it.each(["symbolic link", "file"] as const)(
    "fails closed when an owned generations coordinate is a %s",
    async (kind) => {
      const root = temporaryRoot();
      const entry = join(root, dirnameOfGeneration(artifactGeneration(root, REPOSITORY_KEY, "unused")));
      mkdirSync(entry, { recursive: true, mode: 0o700 });
      const generations = join(entry, "generations");
      if (kind === "symbolic link") {
        const outside = join(root, "outside-generations");
        mkdirSync(outside, { mode: 0o700 });
        symlinkSync(outside, generations, "dir");
      } else {
        writeFileSync(generations, "not a directory\n");
      }

      await expect(collector(root).collect(rootAuthority()))
        .rejects.toThrow(/owned coordinate is unsafe/);
    },
  );

  it("marks the exact merge-base edge transitively from a selected HEAD", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-one", "base-one");
    generation(root, paths.headRelative, 12, {
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      mergeBaseVariant: "populated",
      mergeBaseGenerationId: "base-one",
    });
    const base = generation(root, paths.baseRelative, 13);
    const other = generation(root, artifactGeneration(root, OTHER_REPOSITORY_KEY, "other"), 10);
    current(dirnameOfGeneration(join(root, paths.headRelative)), "head-one", 9_000);
    current(dirnameOfGeneration(other), "other", 8_000);
    const gc = collector(root, { now: () => 10_000, maxSoftEntries: 2, maxSoftBytes: 1_000 });

    await gc.collect(rootAuthority());

    expect(existsSync(join(root, paths.headRelative))).toBe(true);
    expect(existsSync(base)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("charges an exact merge-base dependency to the soft entry budget", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-over-budget", "base-over-budget");
    const head = generation(root, paths.headRelative, 12, {
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      mergeBaseVariant: "populated",
      mergeBaseGenerationId: "base-over-budget",
    });
    const base = generation(root, paths.baseRelative, 13);
    const other = generation(root, artifactGeneration(root, OTHER_REPOSITORY_KEY, "fits"), 10);
    current(dirnameOfGeneration(head), "head-over-budget", 9_000);
    current(dirnameOfGeneration(other), "fits", 8_000);

    await collector(root, {
      now: () => 10_000,
      maxSoftEntries: 1,
      maxSoftBytes: 1_000,
    }).collect(rootAuthority());

    expect(existsSync(head)).toBe(false);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps an exact merge-base dependency outside soft limits when its HEAD is a hard root", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-hard", "base-hard");
    const head = generation(root, paths.headRelative, 12, {
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      mergeBaseVariant: "populated",
      mergeBaseGenerationId: "base-hard",
    });
    const base = generation(root, paths.baseRelative, 13);

    await collector(root, {
      maxSoftEntries: 1,
      maxSoftBytes: 1,
    }).collect(rootAuthority([portable(relative(root, head))]));

    expect(existsSync(head)).toBe(true);
    expect(existsSync(base)).toBe(true);
  });

  it("treats a live publication lease as a hard root and reclaims it after release", async () => {
    const root = temporaryRoot();
    const leasedGeneration = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "leased-work"),
      10,
    );
    const lifecycle = lifecycleFor(root);
    const lease = await lifecycle.acquire(leasedGeneration, { purpose: "publication" });
    const gc = collector(root, { lifecycle });

    await gc.collect(rootAuthority());
    expect(existsSync(leasedGeneration)).toBe(true);
    await lease.release();
    await gc.collect(rootAuthority());
    expect(existsSync(leasedGeneration)).toBe(false);
  });

  it("never considers a live mutable stage to be a finalized collection candidate", async () => {
    const root = temporaryRoot();
    const lifecycle = lifecycleFor(root);
    const stage = await lifecycle.reserveStage();
    writeFileSync(join(stage.directory, "payload.bin"), "in progress");

    await collector(root, { lifecycle }).collect(rootAuthority());

    expect(readFileSync(join(stage.directory, "payload.bin"), "utf8")).toBe("in progress");
    await stage.release();
  });

  it("preserves a generation replacement raced after its quarantine rename", async () => {
    const root = temporaryRoot();
    const candidate = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "generation-race"),
      10,
    );
    let displaced = "";
    const gc = collector(root, {
      afterQuarantineMove: (kind, destination) => {
        if (kind !== "generation") return;
        displaced = `${destination}-displaced`;
        renameSync(destination, displaced);
        mkdirSync(destination, { mode: 0o700 });
        writeFileSync(join(destination, "replacement.bin"), "replacement");
      },
    });

    await expect(gc.collect(rootAuthority())).rejects.toThrow(/preserved/);

    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(join(displaced, "payload.bin")).byteLength).toBe(10);
    expect(rejectedPaths(root).some((path) =>
      existsSync(join(path, "replacement.bin"))
      && readFileSync(join(path, "replacement.bin"), "utf8") === "replacement")).toBe(true);
    expect(readdirSync(join(root, "graph-generation-gc", "v1", "abandoned"))).toEqual([]);
  });

  it("preserves an exact-alias replacement raced after its quarantine rename", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "alias-race", "base-unused");
    const candidate = generation(root, paths.headRelative, 10);
    const exact = prExactLookupFile(
      root,
      REPOSITORY_KEY,
      SECURITY_DIGEST,
      SUBDIR_KEY,
      COMMIT,
      BASE_COMMIT,
      ANALYSIS_KEY,
    );
    const aliasBytes = `${JSON.stringify({
      formatVersion: 1,
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      headSha: COMMIT,
      baseSha: BASE_COMMIT,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      generationId: "alias-race",
    })}\n`;
    writeFile(exact, aliasBytes);
    let displaced = "";
    const releaseSourceOwner = vi.fn(async () => 1);
    const gc = collector(root, {
      repositoryMirrors: { releaseSourceOwner },
      afterQuarantineMove: (kind, destination) => {
        if (kind !== "alias") return;
        displaced = `${destination}-displaced`;
        renameSync(destination, displaced);
        writeFileSync(destination, "replacement alias\n", { mode: 0o600 });
      },
    });

    await expect(gc.collect(rootAuthority())).rejects.toThrow(/preserved/);

    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(displaced, "utf8")).toBe(aliasBytes);
    expect(rejectedPaths(root).some((path) => {
      try {
        return readFileSync(path, "utf8") === "replacement alias\n";
      } catch {
        return false;
      }
    })).toBe(true);
    expect(releaseSourceOwner).not.toHaveBeenCalled();
  });

  it("does not hold lifecycle admission while a recursive candidate scan is slow", async () => {
    const root = temporaryRoot();
    const generationPath = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "slow-scan"),
      10,
    );
    const lifecycle = lifecycleFor(root);
    let scanStarted!: () => void;
    let continueScan!: () => void;
    const started = new Promise<void>((resolve) => { scanStarted = resolve; });
    const gate = new Promise<void>((resolve) => { continueScan = resolve; });
    const gc = collector(root, {
      lifecycle,
      beforeCandidateScan: async () => {
        scanStarted();
        await gate;
      },
    });

    const collecting = gc.collect(rootAuthority());
    await started;
    const lease = await lifecycle.acquire(generationPath, { purpose: "publication" });
    continueScan();
    await collecting;
    expect(existsSync(generationPath)).toBe(true);
    await lease.release();
  });

  it(
    "releases lifecycle admission between batches and honors a newly acquired publication lease",
    async () => {
      const root = temporaryRoot();
      const generations = batchGenerations(root, 34, "lease-batch");
      const target = generations[32]!;
      const lifecycle = lifecycleFor(root);
      const firstBatchReturned = deferred<void>();
      const continueCollection = deferred<void>();
      let generationBatches = 0;
      const gc = collector(root, {
        lifecycle,
        afterQuarantineBatch: async (batch) => {
          if (batch.kind !== "generation" || generationBatches++ !== 0) return;
          firstBatchReturned.resolve();
          await continueCollection.promise;
        },
      });

      const collecting = gc.collect(rootAuthority());
      await firstBatchReturned.promise;
      const lease = await lifecycle.acquire(target, { purpose: "publication" });
      continueCollection.resolve();
      await collecting;

      expect(generations.slice(0, 32).every((path) => !existsSync(path))).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(generations[33]!)).toBe(false);
      await lease.release();
    },
  );

  it("observes cancellation between batches and leaves a durable retry-safe quarantine", async () => {
    const root = temporaryRoot();
    const generations = batchGenerations(root, 40, "abort-batch");
    const controller = new AbortController();
    let generationBatches = 0;
    const gc = collector(root, {
      afterQuarantineBatch: (batch) => {
        if (batch.kind === "generation" && generationBatches++ === 0) {
          controller.abort(new Error("stop after one quarantine batch"));
        }
      },
    });

    await expect(gc.collect(rootAuthority(), controller.signal))
      .rejects.toThrow(/stop after one quarantine batch/);

    const quarantine = join(root, "graph-generation-gc", "v1", "quarantine");
    expect(readdirSync(quarantine)).toHaveLength(32);
    expect(generations.slice(0, 32).every((path) => !existsSync(path))).toBe(true);
    expect(generations.slice(32).every((path) => existsSync(path))).toBe(true);

    await collector(root).collect(rootAuthority());
    expect(generations.every((path) => !existsSync(path))).toBe(true);
    expect(readdirSync(quarantine)).toEqual([]);
  });

  it.each(["root", "current-pointer"] as const)(
    "does not sweep a generation that gains a %s between scan and a later batch",
    async (protection) => {
      const root = temporaryRoot();
      const generations = batchGenerations(root, 34, `late-${protection}`);
      const target = generations[32]!;
      const targetRelative = portable(relative(root, target));
      let revision = 0;
      const durableRoots = new Set<string>();
      const authority = {
        async snapshotGenerationRoots() {
          return {
            revision: String(revision),
            generationPaths: new Set(durableRoots),
          };
        },
        generationRootSnapshotIsCurrent(snapshot: { revision: string }) {
          return snapshot.revision === String(revision);
        },
      };
      let generationBatches = 0;
      const gc = collector(root, {
        afterQuarantineBatch: (batch) => {
          if (batch.kind !== "generation" || generationBatches++ !== 0) return;
          if (protection === "root") {
            durableRoots.add(targetRelative);
            revision += 1;
          } else {
            current(dirnameOfGeneration(target), "late-current-pointer-032", 9_000);
          }
        },
      });

      await gc.collect(authority);

      expect(existsSync(target)).toBe(true);
      expect(existsSync(generations[33]!)).toBe(false);
    },
  );

  it("conservatively skips an inode replacement introduced before a later batch", async () => {
    const root = temporaryRoot();
    const generations = batchGenerations(root, 34, "late-inode");
    const target = generations[32]!;
    const displaced = `${target}-displaced`;
    let generationBatches = 0;

    await collector(root, {
      afterQuarantineBatch: (batch) => {
        if (batch.kind !== "generation" || generationBatches++ !== 0) return;
        renameSync(target, displaced);
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, "replacement.bin"), "replacement");
      },
    }).collect(rootAuthority());

    expect(readFileSync(join(target, "replacement.bin"), "utf8")).toBe("replacement");
    expect(existsSync(displaced)).toBe(true);
  });

  it("conservatively skips a comparison-edge replacement introduced before a later batch", async () => {
    const root = temporaryRoot();
    const generations: string[] = [];
    for (let index = 0; index < 34; index += 1) {
      const generationId = `late-edge-${String(index).padStart(3, "0")}`;
      const paths = prPaths(root, generationId, "edge-base-before");
      generations.push(generation(
        root,
        paths.headRelative,
        10,
        index === 32 ? {
          repositoryKey: REPOSITORY_KEY,
          securityDigest: SECURITY_DIGEST,
          mergeBaseSha: COMMIT,
          analysisKey: ANALYSIS_KEY,
          mergeBaseVariant: "populated",
          mergeBaseGenerationId: "edge-base-before",
        } : undefined,
      ));
    }
    const target = generations[32]!;
    const metadata = join(target, "head", "metadata.json");
    let generationBatches = 0;

    await collector(root, {
      afterQuarantineBatch: (batch) => {
        if (batch.kind !== "generation" || generationBatches++ !== 0) return;
        renameSync(metadata, `${metadata}.displaced`);
        writeJson(metadata, {
          repositoryKey: REPOSITORY_KEY,
          securityDigest: SECURITY_DIGEST,
          mergeBaseSha: COMMIT,
          analysisKey: ANALYSIS_KEY,
          mergeBaseVariant: "populated",
          mergeBaseGenerationId: "edge-base-after",
        });
      },
    }).collect(rootAuthority());

    expect(existsSync(target)).toBe(true);
    expect(existsSync(generations[33]!)).toBe(false);
  });

  it("revalidates an exact alias in its own batch before eviction", async () => {
    const root = temporaryRoot();
    const aliases = Array.from({ length: 34 }, (_, index) => writeExactAlias(
      root,
      index.toString(16).padStart(40, "0"),
      "missing-generation",
    ));
    let target = "";
    let aliasBatches = 0;

    await collector(root, {
      afterQuarantineBatch: (batch) => {
        if (batch.kind !== "alias" || aliasBatches++ !== 0) return;
        target = aliases.find((path) => existsSync(path)) ?? "";
        if (!target) throw new Error("expected an alias outside the first admission batch");
        const touched = new Date(Date.now() + 60_000);
        utimesSync(target, touched, touched);
      },
    }).collect(rootAuthority());

    expect(aliases.filter((path) => path !== target).every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it(
    "never exceeds the admission limit across generation, alias, and prune batches",
    async () => {
      const root = temporaryRoot();
      const generations: string[] = [];
      const aliases: string[] = [];
      for (let index = 0; index < 70; index += 1) {
        const generationId = `bounded-${String(index).padStart(3, "0")}`;
        const paths = prPaths(root, generationId, "unused-base");
        generations.push(generation(root, paths.headRelative, 10));
        aliases.push(writeExactAlias(
          root,
          index.toString(16).padStart(40, "0"),
          generationId,
        ));
      }
      const batches: Array<{ kind: string; quarantinedPaths: number }> = [];

      await collector(root, {
        afterQuarantineBatch: (batch) => { batches.push(batch); },
      }).collect(rootAuthority());

      expect(batches.length).toBeGreaterThan(6);
      expect(Math.max(...batches.map((batch) => batch.quarantinedPaths))).toBe(32);
      expect(batches.every((batch) => batch.quarantinedPaths <= 32)).toBe(true);
      expect(batches.some((batch) => batch.kind === "generation")).toBe(true);
      expect(batches.some((batch) => batch.kind === "alias")).toBe(true);
      expect(batches.some((batch) => batch.kind === "maintenance")).toBe(true);
      expect(generations.every((path) => !existsSync(path))).toBe(true);
      expect(aliases.every((path) => !existsSync(path))).toBe(true);
    },
  );

  it("retries the decision when persisted roots change after discovery", async () => {
    const root = temporaryRoot();
    const generationPath = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "new-root"),
      10,
    );
    const relativeGeneration = portable(relative(root, generationPath));
    let revision = "before-publication";
    let snapshots = 0;
    const authority = {
      async snapshotGenerationRoots() {
        snapshots += 1;
        return {
          revision,
          generationPaths: new Set(revision === "after-publication" ? [relativeGeneration] : []),
        };
      },
      generationRootSnapshotIsCurrent(snapshot: { revision: string }) {
        if (snapshot.revision === "before-publication") {
          revision = "after-publication";
          return false;
        }
        return snapshot.revision === revision;
      },
    };

    await collector(root).collect(authority);

    expect(snapshots).toBe(2);
    expect(existsSync(generationPath)).toBe(true);
  });

  it("quarantines aliases and releases both deterministic PR HEAD owners", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-old", "base-unused");
    const head = generation(root, paths.headRelative, 10, {
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      mergeBaseVariant: "populated",
      mergeBaseGenerationId: "base-unused",
    });
    current(dirnameOfGeneration(head), "head-old", 1_000);
    const exact = prExactLookupFile(
      root,
      REPOSITORY_KEY,
      SECURITY_DIGEST,
      SUBDIR_KEY,
      COMMIT,
      BASE_COMMIT,
      ANALYSIS_KEY,
    );
    writeJson(exact, {
      formatVersion: 1,
      repositoryKey: REPOSITORY_KEY,
      securityDigest: SECURITY_DIGEST,
      headSha: COMMIT,
      baseSha: BASE_COMMIT,
      mergeBaseSha: COMMIT,
      analysisKey: ANALYSIS_KEY,
      generationId: "head-old",
    });
    const releaseSourceOwner = vi.fn(async (_owner: string) => 1);
    const gc = collector(root, {
      now: () => 10_000,
      maxIdleMs: 1_000,
      repositoryMirrors: { releaseSourceOwner },
    });

    await gc.collect(rootAuthority());

    expect(existsSync(head)).toBe(false);
    expect(existsSync(exact)).toBe(false);
    expect(releaseSourceOwner.mock.calls.map(([owner]) => owner)).toEqual([
      `pr-head-cache:${REPOSITORY_KEY}:${SECURITY_DIGEST}:head-old`,
      `pr-head-base-cache:${REPOSITORY_KEY}:${SECURITY_DIGEST}:head-old`,
    ]);
  });

  it.each(["invalid", "dangling"] as const)(
    "reclaims an %s exact-base alias and prunes its empty coordinate directories",
    async (kind) => {
      const root = temporaryRoot();
      const exact = prExactLookupFile(
        root,
        REPOSITORY_KEY,
        SECURITY_DIGEST,
        SUBDIR_KEY,
        COMMIT,
        BASE_COMMIT,
        ANALYSIS_KEY,
      );
      if (kind === "invalid") writeJson(exact, { formatVersion: 1, generationId: "legacy-shape" });
      else writeExactAlias(root, BASE_COMMIT, "missing-generation");

      await collector(root).collect(rootAuthority());

      expect(existsSync(exact)).toBe(false);
      expect(readdirSync(join(root, "pr-exact-lookups"))).toEqual([]);
    },
  );

  it("bounds retained exact-base aliases independently of retained immutable generations", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-alias-limit", "base-unused");
    const head = generation(root, paths.headRelative, 10);
    const older = writeExactAlias(root, BASE_COMMIT, "head-alias-limit");
    const newer = writeExactAlias(root, OTHER_BASE_COMMIT, "head-alias-limit");
    const oldTime = new Date(8_000);
    const newTime = new Date(9_000);
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    await collector(root, {
      now: () => 10_000,
      maxExactAliases: 1,
    }).collect(rootAuthority([portable(relative(root, head))]));

    expect(existsSync(head)).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });

  it("accepts a concurrent warm-read timestamp touch on the same parsed exact alias inode", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-alias-touch", "base-unused");
    const head = generation(root, paths.headRelative, 10);
    const alias = writeExactAlias(root, BASE_COMMIT, "head-alias-touch");
    let touched = false;
    const authority = {
      async snapshotGenerationRoots() {
        const at = new Date(Date.now() + 1_000);
        utimesSync(alias, at, at);
        touched = true;
        return {
          revision: "alias-touch",
          generationPaths: new Set([portable(relative(root, head))]),
        };
      },
      generationRootSnapshotIsCurrent(snapshot: { revision: string }) {
        return snapshot.revision === "alias-touch";
      },
    };

    await collector(root).collect(authority);

    expect(touched).toBe(true);
    expect(existsSync(alias)).toBe(true);
    expect(existsSync(head)).toBe(true);
  });

  it("keeps physical cleanup outside the cache-root lock and retries from durable quarantine", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-failing", "base-unused");
    generation(root, paths.headRelative, 10);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let started!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseSourceOwner = vi.fn(async () => {
      started();
      await blocked;
      throw new Error("mirror cleanup failed");
    });
    const lifecycle = lifecycleFor(root);
    const gc = collector(root, { lifecycle, repositoryMirrors: { releaseSourceOwner } });
    const collecting = gc.collect(rootAuthority());
    await cleanupStarted;

    const reservation = await lifecycle.acquire(
      join(root, paths.headRelative, "..", "next"),
      { purpose: "publication", allowMissing: true },
    );
    await reservation.release();
    unblock();
    await expect(collecting).rejects.toThrow(/could not be reclaimed/);

    const recoveredRelease = vi.fn(async (_owner: string) => 1);
    const restarted = collector(root, { lifecycle, repositoryMirrors: { releaseSourceOwner: recoveredRelease } });
    await expect(restarted.collect(rootAuthority())).resolves.toMatchObject({ quarantinedGenerations: 1 });
    expect(recoveredRelease).toHaveBeenCalledTimes(2);
  });

  it("derives cleanup owners from an exact finalized coordinate and rejects persisted owner injection", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-owner-record", "base-unused");
    generation(root, paths.headRelative, 10);
    const firstRelease = vi.fn(async () => {
      throw new Error("leave the cleanup job durable");
    });

    await expect(collector(root, {
      repositoryMirrors: { releaseSourceOwner: firstRelease },
    }).collect(rootAuthority())).rejects.toThrow(/could not be reclaimed/);

    const quarantine = join(root, "graph-generation-gc", "v1", "quarantine");
    const [token] = readdirSync(quarantine);
    if (!token) throw new Error("expected a durable cleanup job");
    const recordPath = join(quarantine, token, "cleanup.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, `${JSON.stringify({
      ...record,
      cleanupOwners: ["unrelated-live-mirror-owner"],
    })}\n`, { mode: 0o600 });

    const restartedRelease = vi.fn(async () => 1);
    await expect(collector(root, {
      repositoryMirrors: { releaseSourceOwner: restartedRelease },
    }).collect(rootAuthority())).resolves.toMatchObject({ quarantinedGenerations: 0 });

    expect(restartedRelease).not.toHaveBeenCalled();
    expect(readdirSync(quarantine)).toEqual([]);
    expect(readdirSync(join(root, "graph-generation-gc", "v1", "abandoned"))).toEqual([]);
  });

  it("binds cleanup-record contents to the exact file identity before releasing owners", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-record-race", "base-unused");
    generation(root, paths.headRelative, 10);
    await expect(collector(root, {
      repositoryMirrors: { releaseSourceOwner: async () => { throw new Error("persist job"); } },
    }).collect(rootAuthority())).rejects.toThrow(/could not be reclaimed/);

    const quarantine = join(root, "graph-generation-gc", "v1", "quarantine");
    const [token] = readdirSync(quarantine);
    if (!token) throw new Error("expected a durable cleanup job");
    const recordPath = join(quarantine, token, "cleanup.json");
    const canonicalRecord = realpathSync(recordPath);
    let replaced = false;
    const releaseSourceOwner = vi.fn(async () => 1);
    const restarted = collector(root, {
      repositoryMirrors: { releaseSourceOwner },
      afterMetadataRead: (path) => {
        if (path !== canonicalRecord || replaced) return;
        replaced = true;
        renameSync(recordPath, `${recordPath}.displaced`);
        writeFileSync(recordPath, "{}\n", { mode: 0o600 });
      },
    });

    await restarted.collect(rootAuthority());

    expect(replaced).toBe(true);
    expect(releaseSourceOwner).not.toHaveBeenCalled();
    expect(readdirSync(quarantine)).toEqual([]);
  });

  it("recovers durable abandoned cleanup claims after restart", async () => {
    const root = temporaryRoot();
    // Construct the collector first so its private durable namespaces exist.
    const gc = collector(root);
    const abandoned = join(
      root,
      "graph-generation-gc",
      "v1",
      "abandoned",
      "d".repeat(32),
    );
    mkdirSync(abandoned, { recursive: true, mode: 0o700 });
    writeFileSync(join(abandoned, "payload.bin"), "interrupted cleanup");

    await gc.collect(rootAuthority());

    expect(existsSync(abandoned)).toBe(false);
  });

  it("binds a current pointer's parsed bytes to the same file identity", async () => {
    const root = temporaryRoot();
    const candidate = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "pointer-race"),
      10,
    );
    const replacementGeneration = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "replacement"),
      11,
    );
    const entry = dirnameOfGeneration(candidate);
    current(entry, "pointer-race", 9_000);
    const pointer = join(entry, "current.json");
    const canonicalPointer = realpathSync(pointer);
    const displaced = `${pointer}.displaced`;
    let replaced = false;
    const movedKinds: string[] = [];
    const gc = collector(root, {
      afterMetadataRead: (path) => {
        if (path !== canonicalPointer || replaced) return;
        replaced = true;
        renameSync(pointer, displaced);
        writeJson(pointer, { formatVersion: 1, generationId: "replacement" });
      },
      afterQuarantineMove: (kind) => { movedKinds.push(kind); },
    });

    await gc.collect(rootAuthority([portable(relative(root, replacementGeneration))]));

    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(replacementGeneration)).toBe(true);
    expect(movedKinds).toEqual(["generation"]);
    expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({
      formatVersion: 1,
      generationId: "replacement",
    });
    expect(JSON.parse(readFileSync(displaced, "utf8"))).toEqual({
      formatVersion: 1,
      generationId: "pointer-race",
    });
  });

  it("cancels cooperative candidate traversal before quarantine admission", async () => {
    const root = temporaryRoot();
    const candidate = generation(
      root,
      artifactGeneration(root, REPOSITORY_KEY, "cancel-scan"),
      10,
    );
    const entry = dirnameOfGeneration(candidate);
    current(entry, "cancel-scan", 9_000);
    const pointer = realpathSync(join(entry, "current.json"));
    const controller = new AbortController();
    const gc = collector(root, {
      afterMetadataRead: (path) => {
        if (path === pointer) controller.abort(new Error("stop generation scan"));
      },
    });

    await expect(gc.collect(rootAuthority(), controller.signal))
      .rejects.toThrow(/stop generation scan/);

    expect(existsSync(candidate)).toBe(true);
    expect(existsSync(pointer)).toBe(true);
  });

  it("rejects a replaced cleanup wrapper before releasing mirror owners", async () => {
    const root = temporaryRoot();
    const paths = prPaths(root, "head-replaced", "base-unused");
    generation(root, paths.headRelative, 10);
    const entered = deferred<readonly string[]>();
    const resume = deferred<void>();
    const releaseSourceOwner = vi.fn(async () => 1);
    const gc = collector(root, {
      repositoryMirrors: { releaseSourceOwner },
      beforePhysicalCleanup: async (cleanupPaths) => {
        entered.resolve(cleanupPaths);
        await resume.promise;
      },
    });

    const collecting = gc.collect(rootAuthority());
    const cleanupPaths = await entered.promise;
    const wrapper = cleanupPaths.find((path) => path.includes("graph-generation-gc"));
    if (!wrapper) throw new Error("collector did not publish its cleanup wrapper");
    const displaced = `${wrapper}-displaced`;
    renameSync(wrapper, displaced);
    mkdirSync(wrapper, { recursive: true });
    const replacement = join(wrapper, "replacement.bin");
    writeFileSync(replacement, "replacement");
    resume.resolve();

    const failure = await collecting.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join("\n")).toMatch(/claim was replaced/);
    expect(releaseSourceOwner).not.toHaveBeenCalled();
    expect(readFileSync(replacement, "utf8")).toBe("replacement");
    expect(existsSync(join(displaced, "generation"))).toBe(true);
  });

  it.each(["record", "generation"] as const)(
    "rejects a replaced cleanup %s before releasing mirror owners",
    async (target) => {
      const root = temporaryRoot();
      const paths = prPaths(root, `head-${target}`, "base-unused");
      generation(root, paths.headRelative, 10);
      const entered = deferred<readonly string[]>();
      const resume = deferred<void>();
      const releaseSourceOwner = vi.fn(async () => 1);
      const gc = collector(root, {
        repositoryMirrors: { releaseSourceOwner },
        beforePhysicalCleanup: async (cleanupPaths) => {
          entered.resolve(cleanupPaths);
          await resume.promise;
        },
      });

      const collecting = gc.collect(rootAuthority());
      const cleanupPaths = await entered.promise;
      const wrapper = cleanupPaths.find((path) => path.includes("graph-generation-gc"));
      if (!wrapper) throw new Error("collector did not publish its cleanup wrapper");
      const replaced = join(wrapper, target === "record" ? "cleanup.json" : "generation");
      const displaced = `${replaced}-displaced`;
      renameSync(replaced, displaced);
      if (target === "record") writeFileSync(replaced, "{}\n");
      else mkdirSync(replaced, { mode: 0o700 });
      resume.resolve();

      const failure = await collecting.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(String).join("\n"))
        .toMatch(/cleanup job changed after quarantine/);
      expect(releaseSourceOwner).not.toHaveBeenCalled();
      expect(existsSync(displaced)).toBe(true);
    },
  );
});

function collector(
  root: string,
  options: {
    lifecycle?: GraphGenerationLifecycle;
    repositoryMirrors?: { releaseSourceOwner(owner: string): Promise<number> };
    now?: () => number;
    maxSoftEntries?: number;
    maxSoftBytes?: number;
    maxIdleMs?: number;
    maxExactAliases?: number;
    beforeCandidateScan?: () => Promise<void>;
    beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
    afterQuarantineBatch?: (batch: {
      kind: "generation" | "alias" | "maintenance";
      quarantinedPaths: number;
    }) => Promise<void> | void;
    afterQuarantineMove?: (kind: "generation" | "alias", destination: string) => void;
    afterMetadataRead?: (path: string) => void;
  } = {},
): GraphGenerationGarbageCollector {
  return new GraphGenerationGarbageCollector({
    cacheRoot: root,
    lifecycle: options.lifecycle ?? lifecycleFor(root),
    repositoryMirrors: options.repositoryMirrors ?? { releaseSourceOwner: async () => 0 },
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxSoftEntries ? { maxSoftEntries: options.maxSoftEntries } : {}),
    ...(options.maxSoftBytes ? { maxSoftBytes: options.maxSoftBytes } : {}),
    ...(options.maxIdleMs ? { maxIdleMs: options.maxIdleMs } : {}),
    ...(options.maxExactAliases ? { maxExactAliases: options.maxExactAliases } : {}),
    ...(options.beforeCandidateScan ? { beforeCandidateScan: options.beforeCandidateScan } : {}),
    ...(options.beforePhysicalCleanup ? { beforePhysicalCleanup: options.beforePhysicalCleanup } : {}),
    ...(options.afterQuarantineBatch ? { afterQuarantineBatch: options.afterQuarantineBatch } : {}),
    ...(options.afterQuarantineMove ? { afterQuarantineMove: options.afterQuarantineMove } : {}),
    ...(options.afterMetadataRead ? { afterMetadataRead: options.afterMetadataRead } : {}),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function lifecycleFor(root: string): GraphGenerationLifecycle {
  return new GraphGenerationLifecycle({
    cacheRoot: root,
    processIdentity: () => "test-process",
    processAlive: () => true,
  });
}

function rootAuthority(generationPaths: readonly string[] = []) {
  const snapshot = {
    revision: "static-test-roots",
    generationPaths: new Set(generationPaths),
  };
  return {
    async snapshotGenerationRoots() {
      return snapshot;
    },
    generationRootSnapshotIsCurrent(candidate: typeof snapshot) {
      return candidate.revision === snapshot.revision;
    },
  };
}

function generation(
  root: string,
  relativePath: string,
  bytes: number,
  metadata?: Record<string, unknown>,
): string {
  const path = join(root, relativePath);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, "payload.bin"), Buffer.alloc(bytes, 1));
  if (metadata) {
    const metadataPath = relativePath.startsWith("pr-artifacts/")
      ? join(path, "head", "metadata.json")
      : join(path, "metadata.json");
    writeJson(metadataPath, metadata);
  }
  return path;
}

function current(entry: string, generationId: string, touchedAtMs: number): void {
  const path = join(entry, "current.json");
  writeJson(path, { formatVersion: 1, generationId });
  const at = new Date(touchedAtMs);
  utimesSync(path, at, at);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value)}\n`);
}

function writeFile(path: string, value: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
}

function writeExactAlias(root: string, baseSha: string, generationId: string): string {
  const path = prExactLookupFile(
    root,
    REPOSITORY_KEY,
    SECURITY_DIGEST,
    SUBDIR_KEY,
    COMMIT,
    baseSha,
    ANALYSIS_KEY,
  );
  writeJson(path, {
    formatVersion: 1,
    repositoryKey: REPOSITORY_KEY,
    securityDigest: SECURITY_DIGEST,
    headSha: COMMIT,
    baseSha,
    mergeBaseSha: COMMIT,
    analysisKey: ANALYSIS_KEY,
    generationId,
  });
  return path;
}

function prPaths(root: string, headGeneration: string, baseGeneration: string): {
  headRelative: string;
  baseRelative: string;
} {
  return {
    headRelative: portable(relative(root, finalizedGenerationDirectory(
      prHeadArtifactEntry(
        root,
        REPOSITORY_KEY,
        SECURITY_DIGEST,
        SUBDIR_KEY,
        COMMIT,
        COMMIT,
        ANALYSIS_KEY,
      ),
      headGeneration,
    ))),
    baseRelative: portable(relative(root, finalizedGenerationDirectory(
      prBaseArtifactEntry(
        root,
        REPOSITORY_KEY,
        SECURITY_DIGEST,
        SUBDIR_KEY,
        COMMIT,
        ANALYSIS_KEY,
        "populated",
      ),
      baseGeneration,
    ))),
  };
}

function artifactGeneration(root: string, repositoryKey: string, generationId: string): string {
  return portable(relative(root, finalizedGenerationDirectory(
    repositoryArtifactEntry(root, repositoryKey, COMMIT, ANALYSIS_KEY),
    generationId,
  )));
}

function batchGenerations(root: string, count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => generation(
    root,
    artifactGeneration(root, REPOSITORY_KEY, `${prefix}-${String(index).padStart(3, "0")}`),
    10,
  ));
}

function dirnameOfGeneration(generationPath: string): string {
  return join(generationPath, "..", "..");
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-generation-gc-"));
  roots.push(root);
  return root;
}

function rejectedPaths(root: string): string[] {
  const rejected = join(root, "graph-generation-gc", "v1", "rejected");
  return readdirSync(rejected).map((name) => join(rejected, name));
}
