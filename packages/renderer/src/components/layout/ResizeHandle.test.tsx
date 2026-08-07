import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResizeHandle, resizeHandlePointerGeometry } from "./ResizeHandle";

describe("ResizeHandle", () => {
  it("renders the host's exact accessible separator contract and inactive visuals", () => {
    const markup = renderToStaticMarkup(
      <ResizeHandle
        orientation="vertical"
        label="Resize primary and secondary"
        controls="primary-pane secondary-pane"
        valueMin={20}
        valueMax={80}
        valueNow={55}
        valueText="Primary 55%; secondary 45%"
        keyShortcuts="ArrowLeft ArrowRight Home End Enter"
        title="Drag or use the keyboard"
        dataAttributes={{ "data-test-resize-state": "split" }}
        style={(active) => ({ opacity: active ? 1 : 0.5, cursor: "col-resize" })}
        renderGrip={(active) => <span data-active-grip={active ? "true" : "false"}>grip</span>}
        onDrag={() => {}}
        onKeyDown={() => {}}
        onReset={() => {}}
      />,
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize primary and secondary"');
    expect(markup).toContain('aria-controls="primary-pane secondary-pane"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuemin="20"');
    expect(markup).toContain('aria-valuemax="80"');
    expect(markup).toContain('aria-valuenow="55"');
    expect(markup).toContain('aria-valuetext="Primary 55%; secondary 45%"');
    expect(markup).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"');
    expect(markup).toContain('data-test-resize-state="split"');
    expect(markup).toContain('style="opacity:0.5;cursor:col-resize"');
    expect(markup).toContain('data-active-grip="false"');
  });
});

describe("resizeHandlePointerGeometry", () => {
  const bounds = { left: 70, top: 200, width: 8, height: 10 };

  it("uses vertical screen coordinates for a horizontal separator", () => {
    expect(resizeHandlePointerGeometry(
      "horizontal",
      { clientX: 999, clientY: 206 },
      bounds,
    )).toEqual({ clientPosition: 206, grabOffset: 6 });
  });

  it("uses horizontal screen coordinates for a vertical separator and clamps the grab point", () => {
    expect(resizeHandlePointerGeometry(
      "vertical",
      { clientX: 74, clientY: 999 },
      bounds,
    )).toEqual({ clientPosition: 74, grabOffset: 4 });
    expect(resizeHandlePointerGeometry(
      "vertical",
      { clientX: 50, clientY: 999 },
      bounds,
    ).grabOffset).toBe(0);
    expect(resizeHandlePointerGeometry(
      "vertical",
      { clientX: 100, clientY: 999 },
      bounds,
    ).grabOffset).toBe(8);
  });
});
