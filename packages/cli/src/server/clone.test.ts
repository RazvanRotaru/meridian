/**
 * The pure, network-free half of source resolution: the GitHub-input allowlist, the git auth
 * argv (token -> `http.extraHeader`, never the URL), and the subdir containment check. The
 * clone spawn itself is covered by the live smoke test, not here.
 */

import { describe, expect, it } from "vitest";
import { base64Auth, buildCloneArgs, parseGitHubSource, sanitizeSubdir } from "./clone";
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
    expect(sanitizeSubdir("/repo", "src")).toBe("/repo/src");
    expect(sanitizeSubdir("/repo", "  ")).toBe("/repo");
    expect(sanitizeSubdir("/repo", undefined)).toBe("/repo");
  });

  it("rejects a `..` escape out of the clone", () => {
    expect(() => sanitizeSubdir("/repo", "../etc")).toThrow(WebError);
    expect(() => sanitizeSubdir("/repo", "../../..")).toThrow(WebError);
  });
});
