import type { ReactElement } from "react";
import { useCatalog } from "../hooks/useCatalog.js";
import { CategoryFilter } from "./CategoryFilter.js";
import { ProductGrid } from "./ProductGrid.js";

/** The main shopping surface. Reads products via useCatalog() and composes the grid. */
export function CatalogPage(): ReactElement {
  const catalog = useCatalog();
  return (
    <section className="catalog-page">
      <CategoryFilter />
      <ProductGrid products={catalog.products} />
    </section>
  );
}
