/**
 * Browser entry point. Mounts <App/> into the DOM. The ReactDOM call is stubbed so the
 * fixture never needs react-dom installed to be statically analyzed.
 */

import { App } from "./ui/App.js";

/** A stand-in for ReactDOM.createRoot().render(); keeps the fixture dependency-free. */
function renderInto(container: unknown, element: unknown): void {
  void container;
  void element;
}

/** Boot the storefront against the page's #root element. */
export function main(): void {
  const root = typeof document === "undefined" ? null : document.getElementById("root");
  renderInto(root, <App />);
}

main();
