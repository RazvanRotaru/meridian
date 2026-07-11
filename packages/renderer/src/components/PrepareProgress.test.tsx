import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrepareProgress } from "./PrepareProgress";

const STEPS = [
  { id: "fetch", label: "Fetch source" },
  { id: "build", label: "Build model" },
  { id: "open", label: "Open result" },
] as const;

describe("PrepareProgress", () => {
  it("renders arbitrary steps around the active stage with live-region semantics", () => {
    const markup = renderToStaticMarkup(
      <PrepareProgress
        title="Preparing model"
        steps={STEPS}
        activeStep="build"
        actions={<button type="button">Cancel</button>}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("Preparing model: Build model");
    expect(markup).toContain('data-state="done"');
    expect(markup).toContain('data-state="active" aria-current="step"');
    expect(markup).toContain('data-state="pending"');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
    expect(markup).toContain("Preparing model");
    expect(markup).toContain("Cancel");
  });

  it("falls back to the first step when no active stage is available", () => {
    const markup = renderToStaticMarkup(
      <PrepareProgress title="Preparing model" steps={STEPS} activeStep={null} />,
    );

    expect(markup).toContain('data-state="active" aria-current="step"');
    expect(markup).toContain("Preparing model: Fetch source");
    expect(markup).not.toContain('data-state="done"');
  });

  it("offers a compact variant that announces only the active step", () => {
    const markup = renderToStaticMarkup(
      <PrepareProgress title="Preparing model" steps={STEPS} activeStep="build" variant="inline" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Preparing model: ");
    expect(markup).toContain("Build model");
    expect(markup).not.toContain("Fetch source");
    expect(markup).not.toContain("Open result");
  });
});
