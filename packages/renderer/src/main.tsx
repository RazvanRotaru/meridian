/**
 * Entry point. Commit the renderer-shaped shell synchronously, mount the live store after the
 * first bounded projection arrives, then hydrate URL/layout state while progress remains visible.
 * The boot config is read
 * from `window.__MERIDIAN__`; a missing config falls back to the bundled dev sample without
 * ever touching the production code path.
 */

import "@xyflow/react/dist/style.css";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { prepareBootstrap } from "./boot/bootstrap";
import { measurePerformance, markPerformance, PERFORMANCE } from "./boot/performanceMarks";
import { App } from "./App";
import { BootSplash } from "./components/BootSplash";
import { RendererBootShell } from "./components/RendererBootShell";

markPerformance(PERFORMANCE.bootStart);
const root = createRoot(mountElement());
flushSync(() => root.render(<RendererBootShell />));
markPerformance(PERFORMANCE.shellMounted);
void start(root);

async function start(target: Root): Promise<void> {
  try {
    const prepared = await prepareBootstrap();
    // Commit the live renderer before URL hydration. A deep-linked PR can now paint its real
    // resolve/git/extract/publish stages instead of remaining hidden behind a boot splash.
    flushSync(() => target.render(
      <StrictMode>
        <App store={prepared.store} boot={prepared.boot} />
      </StrictMode>,
    ));
    await prepared.hydrate();
    markFirstUsablePaintAfterCommit();
  } catch (error) {
    target.render(<BootSplash tone="error" message={describe(error)} />);
  }
}

function markFirstUsablePaintAfterCommit(): void {
  // One frame commits any final external-store notification; the following frame proves at least
  // one browser paint has occurred with the first complete scene.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      markPerformance(PERFORMANCE.firstUsablePaint);
      measurePerformance(
        PERFORMANCE.bootToFirstUsablePaint,
        PERFORMANCE.bootStart,
        PERFORMANCE.firstUsablePaint,
      );
    });
  });
}

function mountElement(): HTMLElement {
  const element = document.getElementById("root");
  if (!element) {
    throw new Error("missing #root mount element");
  }
  return element;
}

function describe(error: unknown): string {
  return error instanceof Error ? `Failed to load blueprint: ${error.message}` : "Failed to load blueprint.";
}
