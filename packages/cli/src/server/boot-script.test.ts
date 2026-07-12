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
    expect(html).toContain('"traceUrl":"/api/traces"');
    expect(html).toContain('"telemetrySources":[{"id":"demo","kind":"mock","label":"Synthetic demo","provenance":"synthetic","environments":["demo","dev","staging","prod"],"environmentMode":"arbitrary","supportsMetrics":true,"supportsTraces":true}]');
    expect(html).toContain('"preselectedTelemetrySourceId":"demo"');
    expect(html).toContain('"preselectedEnv":"staging"');
    expect(html).toContain('"defaultEnv":null');
    expect(html).toContain('"githubSource":false');
  });

  it("advertises an explicit custom mock environment without turning suggestions into an allowlist", () => {
    const html = injectBootScript("<head></head>", { kind: "mock" }, "qa-west", null);

    expect(html).toContain('"environments":["demo","dev","staging","prod","qa-west"]');
    expect(html).toContain('"environmentMode":"arbitrary"');
  });

  it("advertises the source endpoint only when a source root is configured", () => {
    expect(injectBootScript("<head></head>", { kind: "mock" }, null, "/repo")).toContain('"sourceUrl":"/api/source"');
    expect(injectBootScript("<head></head>", { kind: "mock" }, null, null)).toContain('"sourceUrl":null');
  });

  it("advertises a narrow built-in demo while leaving source and environment unselected", () => {
    const html = injectBootScript("<head></head>", { kind: "none" }, null, null);
    expect(html).toContain('"telemetrySources":[{"id":"demo"');
    expect(html).toContain('"environments":["demo"]');
    expect(html).toContain('"preselectedTelemetrySourceId":null');
    expect(html).toContain('"preselectedEnv":null');
    expect(html).toContain('"hasOverlay":false');
  });
});
