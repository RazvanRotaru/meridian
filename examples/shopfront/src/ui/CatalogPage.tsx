import type { ReactElement } from "react";
import { useCatalog } from "../hooks/useCatalog.js";
import { useSavedItems } from "../hooks/useSavedItems.js";
import { CategoryFilter } from "./CategoryFilter.js";
import { ProductGrid } from "./ProductGrid.js";
import { SavedItemsPanel } from "./SavedItemsPanel.js";

/** The main shopping surface. Reads products via useCatalog() and composes the grid. */
export function CatalogPage(): ReactElement {
  const catalog = useCatalog();
  const saved = useSavedItems();
  return (
    <section className="catalog-page">
      <CategoryFilter />
      <ProductGrid products={catalog.products} savedProductIds={saved.productIds} onSave={saved.save} />
      <SavedItemsPanel items={saved.items} onRemove={saved.remove} />
    </section>
  );
}
