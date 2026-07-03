import type { ReactElement } from "react";
import { StoreLayout } from "./StoreLayout.js";

/** Root component: mounts the whole storefront. */
export function App(): ReactElement {
  return <StoreLayout />;
}
