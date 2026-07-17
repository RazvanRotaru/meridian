import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimPathForCleanup,
  moveClaimedPath,
  removeClaimedPath,
} from "./claimed-path-cleanup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("claimed path cleanup", () => {
  it("streams wide trees in bounded batches without following symbolic links", async () => {
    const root = temporaryRoot("cleanup");
    const outside = temporaryRoot("outside");
    const claimed = join(root, "claimed");
    mkdirSync(join(claimed, "nested"), { recursive: true });
    // More than two 32-entry directory buffers exercises both bounded streaming and the explicit
    // event-loop yield between buffers. Nest some entries as well so depth remains covered.
    for (let index = 0; index < 97; index += 1) {
      const parent = index % 3 === 0 ? join(claimed, "nested") : claimed;
      writeFileSync(join(parent, `${index}.bin`), Buffer.alloc(128, index));
    }
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    symlinkSync(outside, join(claimed, "escape"), "dir");

    let finished = false;
    const removal = removeClaimedPath(claimPathForCleanup(claimed)).finally(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(finished).toBe(false);
    await removal;
    expect(existsSync(claimed)).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("preserves both the moved inode and a raced destination replacement", () => {
    const root = temporaryRoot("move-race");
    const source = join(root, "source");
    const destination = join(root, "destination");
    const displaced = join(root, "displaced-original");
    const rejected = join(root, "rejected-replacement");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "original.bin"), "original");
    const expected = claimPathForCleanup(source);

    expect(() => moveClaimedPath({
      source,
      expected,
      destination,
      rejected,
      label: "test claim",
      afterRename: (moved) => {
        renameSync(moved, displaced);
        mkdirSync(moved, { mode: 0o700 });
        writeFileSync(join(moved, "replacement.bin"), "replacement");
      },
    })).toThrow(/changed during quarantine and was preserved/);

    expect(readFileSync(join(displaced, "original.bin"), "utf8")).toBe("original");
    expect(readFileSync(join(rejected, "replacement.bin"), "utf8")).toBe("replacement");
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["file", "directory"] as const)(
    "never removes a %s replacement introduced after validation but before the private claim",
    async (kind) => {
      const root = temporaryRoot(`cleanup-${kind}-race`);
      const path = join(root, "claimed");
      const displaced = join(root, "displaced-original");
      if (kind === "file") writeFileSync(path, "original");
      else {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "original.bin"), "original");
      }
      const claim = claimPathForCleanup(path);

      const failure = await removeClaimedPath(claim, undefined, {
        beforePrivateClaim: (validatedPath) => {
          renameSync(validatedPath, displaced);
          if (kind === "file") writeFileSync(validatedPath, "replacement");
          else {
            mkdirSync(validatedPath, { mode: 0o700 });
            writeFileSync(join(validatedPath, "replacement.bin"), "replacement");
          }
        },
      }).catch((error: unknown) => error);

      expect(String(failure)).toMatch(/changed before quarantine/);
      if (kind === "file") {
        expect(readFileSync(displaced, "utf8")).toBe("original");
        expect(readFileSync(path, "utf8")).toBe("replacement");
      } else {
        expect(readFileSync(join(displaced, "original.bin"), "utf8")).toBe("original");
        expect(readFileSync(join(path, "replacement.bin"), "utf8")).toBe("replacement");
      }
    },
  );

  it.each(["file", "directory"] as const)(
    "removes only the private %s claim when the public name is reused",
    async (kind) => {
      const root = temporaryRoot(`cleanup-${kind}-reuse`);
      const path = join(root, "claimed");
      if (kind === "file") writeFileSync(path, "original");
      else {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "original.bin"), "original");
      }

      await removeClaimedPath(claimPathForCleanup(path), undefined, {
        afterPrivateClaim: () => {
          if (kind === "file") writeFileSync(path, "replacement");
          else {
            mkdirSync(path, { mode: 0o700 });
            writeFileSync(join(path, "replacement.bin"), "replacement");
          }
        },
      });

      if (kind === "file") expect(readFileSync(path, "utf8")).toBe("replacement");
      else expect(readFileSync(join(path, "replacement.bin"), "utf8")).toBe("replacement");
    },
  );

  it("honors cancellation after the private claim without returning to the reused public path", async () => {
    const root = temporaryRoot("cleanup-abort");
    const path = join(root, "claimed");
    writeFileSync(path, "original");
    const controller = new AbortController();
    const reason = new Error("stop cleanup");

    const failure = await removeClaimedPath(
      claimPathForCleanup(path),
      controller.signal,
      { afterPrivateClaim: () => controller.abort(reason) },
    ).catch((error: unknown) => error);

    expect(failure).toBe(reason);
    expect(existsSync(path)).toBe(false);
    const [removalRoot] = readdirSync(root).filter((name) => name.startsWith(".meridian-removal-"));
    expect(removalRoot).toBeDefined();
    expect(readFileSync(join(root, removalRoot!, "claimed"), "utf8")).toBe("original");
  });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `meridian-${label}-`));
  roots.push(root);
  return root;
}
