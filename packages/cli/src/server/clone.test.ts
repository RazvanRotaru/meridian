/**
 * The pure, network-free half of source resolution: the GitHub-input allowlist, the git auth
 * argv (token -> `http.extraHeader`, never the URL), and the subdir containment check. The
 * clone spawn itself is covered by the live smoke test, not here.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { base64Auth, buildCloneArgs, parseGitHubSource, resolveExtractionSubdir, sanitizeSubdir } from "./clone";
import { WebError } from "./web-error";

describe("parseGitHubSource", () => {
  it("expands owner/repo to an https clone URL", () => {
    expect(parseGitHubSource("sindresorhus/type-fest")).toBe("https://github.com/sindresorhus/type-fest.git");
  });

  it("accepts a full https git URL", () => {
    expect(parseGitHubSource("https://gitlab.com/group/project.git")).toBe("https://gitlab.com/group/project.git");
  });

  it("rejects ssh, file, and shell-metacharacter inputs", () => {
    expect(() => parseGitHubSource("git@github.com:owner/repo.git")).toThrow(WebError);
    expect(() => parseGitHubSource("file:///etc/passwd")).toThrow(WebError);
    expect(() => parseGitHubSource("owner/repo; rm -rf /")).toThrow(WebError);
    expect(() => parseGitHubSource("https://github.com/o/r; echo hi")).toThrow(WebError);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => parseGitHubSource("https://user:pass@github.com/o/r.git")).toThrow(WebError);
  });
});

describe("buildCloneArgs", () => {
  it("stays anonymous with no token", () => {
    const args = buildCloneArgs("https://github.com/o/r.git", "/tmp/x", {});
    expect(args.join(" ")).not.toContain("http.extraHeader");
    expect(args).toEqual([
      "-c",
      "core.longpaths=true",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--",
      "https://github.com/o/r.git",
      "/tmp/x",
    ]);
  });

  it("injects an Authorization extraHeader from the token, before the subcommand", () => {
    const token = "ghp_secret123";
    const args = buildCloneArgs("https://github.com/o/r.git", "/tmp/x", { token });
    const expected = Buffer.from("x-access-token:ghp_secret123").toString("base64");
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe(`http.extraHeader=AUTHORIZATION: basic ${expected}`);
    expect(args.indexOf("-c")).toBeLessThan(args.indexOf("clone"));
    // The raw token never appears in the argv — only its base64 header form.
    expect(args.join(" ")).not.toContain(token);
  });

  it("adds --branch only when a ref is given", () => {
    expect(buildCloneArgs("u", "d", { ref: "next" })).toContain("--branch");
    expect(buildCloneArgs("u", "d", { ref: "next" })).toContain("next");
    expect(buildCloneArgs("u", "d", {})).not.toContain("--branch");
  });
});

describe("base64Auth", () => {
  it("encodes x-access-token:<token>", () => {
    expect(base64Auth("abc")).toBe(Buffer.from("x-access-token:abc").toString("base64"));
  });
});

describe("sanitizeSubdir", () => {
  it("joins a normal subfolder within the clone", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-subdir-"));
    try {
      mkdirSync(join(root, "src"));
      expect(sanitizeSubdir(root, "src")).toBe(realpathSync.native(join(root, "src")));
      expect(sanitizeSubdir(root, "  ")).toBe(realpathSync.native(root));
      expect(sanitizeSubdir(root, undefined)).toBe(realpathSync.native(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a `..` escape out of the clone", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-subdir-"));
    try {
      expect(() => sanitizeSubdir(root, "../etc")).toThrow(WebError);
      expect(() => sanitizeSubdir(root, "../../..")).toThrow(WebError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects repository symlinks and nested symlink components that escape the clone", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-subdir-"));
    const outside = mkdtempSync(join(tmpdir(), "meridian-outside-"));
    try {
      mkdirSync(join(root, "packages"));
      symlinkSync(outside, join(root, "escaped"));
      symlinkSync(outside, join(root, "packages", "escaped"));
      expect(() => sanitizeSubdir(root, "escaped")).toThrow(WebError);
      expect(() => sanitizeSubdir(root, "packages/escaped")).toThrow(WebError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects missing and non-directory subfolders", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-subdir-"));
    try {
      writeFileSync(join(root, "file.ts"), "export {};\n", "utf8");
      expect(() => sanitizeSubdir(root, "missing")).toThrow(WebError);
      expect(() => sanitizeSubdir(root, "file.ts")).toThrow(WebError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an extraction root linked outside the clone", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-clone-root-"));
    const outside = mkdtempSync(join(tmpdir(), "meridian-clone-outside-"));
    const linked = join(root, "linked");
    try {
      mkdirSync(join(outside, "src"));
      symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
      expect(() => resolveExtractionSubdir(root, "linked")).toThrow("escapes the repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
