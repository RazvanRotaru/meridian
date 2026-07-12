import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PackageCardBody } from "./PackageOverviewNode";

describe("package-card interaction contract", () => {
  it("leaves the whole body to the shared node-selection handler", () => {
    const element = PackageCardBody({ children: "directory" });
    expect(element.props.style).not.toMatchObject({ cursor: "pointer" });
    expect(element.props.onClick).toBeUndefined();
    expect(element.props.onDoubleClick).toBeUndefined();
  });

  it("does not mint a review-only disclosure control", () => {
    const markup = renderToStaticMarkup(<PackageCardBody>directory</PackageCardBody>);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("files ▸");
    expect(markup).not.toContain("Expand all");
  });
});
