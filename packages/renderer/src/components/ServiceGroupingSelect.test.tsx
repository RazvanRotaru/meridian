import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SERVICE_GROUPING_OPTIONS } from "../derive/serviceClusteringModes";
import { SERVICE_GROUPING_TARGET_SIZES } from "../state/serviceGroupingTargetSize";
import {
  SERVICE_GROUPING_INFO,
  ServiceGroupingInfoPanel,
  ServiceGroupingTargetSizeControl,
  serviceGroupingUsesTargetSize,
} from "./ServiceGroupingSelect";

describe("Service grouping information", () => {
  it("documents every available grouping mode with external sources", () => {
    expect(Object.keys(SERVICE_GROUPING_INFO).sort()).toEqual(
      SERVICE_GROUPING_OPTIONS.map((option) => option.id).sort(),
    );

    for (const option of SERVICE_GROUPING_OPTIONS) {
      const info = SERVICE_GROUPING_INFO[option.id];
      expect(info.summary.length).toBeGreaterThan(30);
      expect(info.evidence.length).toBeGreaterThan(30);
      expect(info.optimization.length).toBeGreaterThan(30);
      expect(info.implementation.length).toBeGreaterThan(30);
      expect(info.caveat.length).toBeGreaterThan(30);
      expect(info.badge.length).toBeGreaterThan(5);
      expect(info.sources.length).toBeGreaterThan(0);
      expect(info.sources.every((source) => source.href.startsWith("https://"))).toBe(true);
    }
  });

  it.each(SERVICE_GROUPING_OPTIONS)("renders an accessible $label information region", (option) => {
    const markup = renderToStaticMarkup(
      <ServiceGroupingInfoPanel mode={option.id} id={`info-${option.id}`} headingId={`title-${option.id}`} />,
    );

    expect(markup).toContain(`id="info-${option.id}"`);
    expect(markup).toContain('role="region"');
    expect(markup).toContain(`aria-labelledby="title-${option.id}"`);
    expect(markup).toContain(SERVICE_GROUPING_INFO[option.id].badge);
    expect(markup).toContain("already-derived service composition frames");
    expect(markup).toContain("Implementation");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
  });

  it("does not present Similar API grouping as duplicate-code proof", () => {
    expect(SERVICE_GROUPING_INFO.api.caveat).toMatch(/not .* clone detection/i);
    expect(SERVICE_GROUPING_INFO.api.caveat).toMatch(/does not prove duplicated/i);
  });

  it("describes Dependency grouping as an indirect—not exact—edge reduction", () => {
    expect(SERVICE_GROUPING_INFO.dependency.summary).toMatch(/static/i);
    expect(SERVICE_GROUPING_INFO.dependency.evidence).toMatch(/frequency are collapsed/i);
    expect(SERVICE_GROUPING_INFO.dependency.caveat).toMatch(/indirectly/i);
    expect(SERVICE_GROUPING_INFO.dependency.caveat).toMatch(/not solve an exact minimum-edge-cut/i);
  });

  it("distinguishes the four new custom implementations from their reference algorithms", () => {
    expect(SERVICE_GROUPING_INFO["edge-cut"].implementation).toMatch(/custom Meridian/i);
    expect(SERVICE_GROUPING_INFO["edge-cut"].implementation).toMatch(/not METIS/i);
    expect(SERVICE_GROUPING_INFO["edge-cut"].implementation).toMatch(/does not compute an exact minimum cut/i);

    expect(SERVICE_GROUPING_INFO["coupling-cut"].implementation).toMatch(/custom Meridian/i);
    expect(SERVICE_GROUPING_INFO["coupling-cut"].implementation).toMatch(/does not guarantee the global minimum/i);

    expect(SERVICE_GROUPING_INFO.leiden.implementation).toMatch(/custom deterministic Leiden/i);
    expect(SERVICE_GROUPING_INFO.leiden.implementation).toMatch(/does not claim every formal connectivity guarantee/i);
    expect(SERVICE_GROUPING_INFO.leiden.sources.map((source) => source.href)).toContain(
      "https://doi.org/10.1038/s41598-019-41695-z",
    );

    expect(SERVICE_GROUPING_INFO.bunch.optimization).toMatch(/TurboMQ/i);
    expect(SERVICE_GROUPING_INFO.bunch.optimization).toMatch(/affinity-packed/i);
    expect(SERVICE_GROUPING_INFO.bunch.implementation).toMatch(/implements the TurboMQ objective directly/i);
    expect(SERVICE_GROUPING_INFO.bunch.implementation).toMatch(/custom deterministic hill-climb/i);
    expect(SERVICE_GROUPING_INFO.bunch.implementation).toMatch(/does not run the Bunch tool/i);
  });
});

describe("Service grouping target size", () => {
  it.each(["edge-cut", "coupling-cut", "leiden", "bunch"] as const)(
    "enables the target-size selector for %s",
    (mode) => {
      const markup = renderToStaticMarkup(
        <ServiceGroupingTargetSizeControl
          mode={mode}
          targetSize={12}
          disabled={false}
          onChange={() => undefined}
        />,
      );

      expect(serviceGroupingUsesTargetSize(mode)).toBe(true);
      expect(markup).toContain('aria-label="Target services per cluster"');
      expect(markup).not.toMatch(/<select[^>]*disabled=""/);
      expect(markup).toContain(
        mode === "leiden"
          ? "Soft size target"
          : mode === "bunch"
            ? "Preferred services per visual parent"
            : "Preferred services per parent",
      );
      for (const size of SERVICE_GROUPING_TARGET_SIZES) {
        expect(markup).toContain(`>${size} services</option>`);
      }
    },
  );

  it.each(SERVICE_GROUPING_OPTIONS.filter(
    (option) => option.id !== "edge-cut" && option.id !== "coupling-cut" && option.id !== "leiden" && option.id !== "bunch",
  ))("shows automatic inferred sizing for $label", (option) => {
    const markup = renderToStaticMarkup(
      <ServiceGroupingTargetSizeControl
        mode={option.id}
        targetSize={12}
        disabled={false}
        onChange={() => undefined}
      />,
    );

    expect(serviceGroupingUsesTargetSize(option.id)).toBe(false);
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toContain("Automatic");
    expect(markup).toContain(`${option.label} infers cluster sizes from its objective.`);
  });

  it("keeps the target-size selector disabled while whole-system grouping is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ServiceGroupingTargetSizeControl
        mode="edge-cut"
        targetSize={24}
        disabled={true}
        onChange={() => undefined}
      />,
    );

    expect(markup).toMatch(/<select[^>]*disabled=""/);
  });
});
