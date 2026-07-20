/**
 * Entry point. Boot is asynchronous (fetch graph + first ELK layout), so we paint a splash,
 * then swap in the app on success or a boot-error splash on failure. The boot config is read
 * from `window.__MERIDIAN__`; a missing config falls back to the bundled dev sample without
 * ever touching the production code path.
 */

import "@xyflow/react/dist/style.css";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootstrap } from "./boot/bootstrap";
import { App } from "./App";
import { BootSplash } from "./components/BootSplash";

const root = createRoot(mountElement());
root.render(<BootSplash message="Loading blueprint…" />);
start(root);

async function start(target: Root): Promise<void> {
  try {
    const { store, boot } = await bootstrap();
    target.render(
      <StrictMode>
        <App store={store} boot={boot} />
      </StrictMode>,
    );
  } catch (error) {
    target.render(<BootSplash tone="error" message={describe(error)} />);
  }
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
