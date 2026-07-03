import type { ReactElement } from "react";
import { useCatalog } from "../hooks/useCatalog.js";

/** Nav-bar search input. onChange runs a catalog search via useCatalog(). */
export function SearchBox(): ReactElement {
  const catalog = useCatalog();
  return (
    <input
      className="search"
      placeholder="Search products…"
      onChange={(event) => catalog.search(event.currentTarget.value)}
    />
  );
}
