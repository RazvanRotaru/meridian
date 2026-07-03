/**
 * Regression: a hostile `--env` value must not be able to break out of the inline boot
 * <script> tag. The escaped `<`/`>` still parse back to the same characters as JSON.
 */

import { describe, expect, it } from "vitest";
import { injectBootScript } from "./boot-script";

describe("injectBootScript", () => {
  it("escapes a hostile preselected env so it cannot terminate the script tag", () => {
    const hostile = "</script><script>alert(document.domain)</script>";
    const html = injectBootScript("<head></head>", { kind: "mock" }, hostile, null);
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("still injects a parseable boot object that never defaults the environment", () => {
    const html = injectBootScript("<head></head>", { kind: "mock" }, "staging", null);
    expect(html).toContain('"preselectedEnv":"staging"');
    expect(html).toContain('"defaultEnv":null');
  });

  it("advertises the source endpoint only when a source root is configured", () => {
    expect(injectBootScript("<head></head>", { kind: "mock" }, null, "/repo")).toContain('"sourceUrl":"/api/source"');
    expect(injectBootScript("<head></head>", { kind: "mock" }, null, null)).toContain('"sourceUrl":null');
  });
});
