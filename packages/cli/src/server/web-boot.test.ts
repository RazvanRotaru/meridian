/**
 * The `/view` boot payload's PR-review fields: empty for a normal view, seeded for a PR, and
 * always html-escaped so a hostile affected-file path can't terminate the inline <script> tag.
 */

import { describe, expect, it } from "vitest";
import { injectViewBoot } from "./web-boot";

describe("injectViewBoot", () => {
  it("injects empty review fields for a non-PR view and never defaults the environment", () => {
    const html = injectViewBoot("<head></head>", "abc123");
    expect(html).toContain('"graphUrl":"/api/graph?id=abc123"');
    expect(html).toContain('"affectedFiles":[]');
    expect(html).toContain('"reviewScopeRef":null');
    expect(html).toContain('"reviewTruncated":false');
    expect(html).toContain('"defaultEnv":null');
  });

  it("seeds the affected files and scope ref for a PR view", () => {
    const html = injectViewBoot("<head></head>", "id1", { affectedFiles: ["src/a.ts", "src/b.ts"], reviewScopeRef: "pr42" });
    expect(html).toContain('"affectedFiles":["src/a.ts","src/b.ts"]');
    expect(html).toContain('"reviewScopeRef":"pr42"');
    expect(html).toContain('"reviewTruncated":false');
  });

  it("flags a truncated PR file list in the boot payload", () => {
    const html = injectViewBoot("<head></head>", "id3", { affectedFiles: ["src/a.ts"], reviewScopeRef: "pr7", truncated: true });
    expect(html).toContain('"reviewTruncated":true');
  });

  it("escapes a hostile affected file so it cannot break out of the script tag", () => {
    const hostile = "</script><script>alert(1)</script>";
    const html = injectViewBoot("<head></head>", "id2", { affectedFiles: [hostile], reviewScopeRef: "pr1" });
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
