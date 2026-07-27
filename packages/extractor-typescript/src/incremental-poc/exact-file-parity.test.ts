import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exactRegularFilesEqual } from "./exact-file-parity";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("exact regular-file parity", () => {
  it("compares every byte and rejects same-size, truncated, and extended inputs", async () => {
    const directory = temporaryDirectory();
    const left = join(directory, "left");
    const right = join(directory, "right");
    writeFileSync(left, "abcdef");
    writeFileSync(right, "abcdef");
    await expect(exactRegularFilesEqual(left, right)).resolves.toBe(true);

    writeFileSync(right, "abcxef");
    await expect(exactRegularFilesEqual(left, right)).resolves.toBe(false);
    writeFileSync(right, "abcde");
    await expect(exactRegularFilesEqual(left, right)).resolves.toBe(false);
    writeFileSync(right, "abcdefg");
    await expect(exactRegularFilesEqual(left, right)).resolves.toBe(false);
  });

  it("refuses a final-component symlink and enforces the allocation bound", async () => {
    const directory = temporaryDirectory();
    const left = join(directory, "left");
    const right = join(directory, "right");
    const link = join(directory, "link");
    writeFileSync(left, "abcdef");
    writeFileSync(right, "abcdef");
    if (process.platform !== "win32") {
      symlinkSync("right", link);
      await expect(exactRegularFilesEqual(left, link)).rejects.toMatchObject({
        code: expect.stringMatching(/ELOOP|EMLINK/),
      });
    }
    await expect(exactRegularFilesEqual(left, right, 5)).rejects.toThrow(
      "regular-file limit",
    );
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "meridian-exact-parity-"));
  directories.push(directory);
  return directory;
}
