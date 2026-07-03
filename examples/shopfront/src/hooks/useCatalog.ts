import { useState } from "react";
import type { Category, ProductView } from "../domain/product.js";
import { services } from "../app.js";
import { log } from "../utils/logger.js";

/** Catalog data plus filter/search actions exposed to components. */
export interface CatalogController {
  /** All active products, display-shaped. */
  products: ProductView[];
  /** Narrow the catalog to a category. */
  filter(category: Category): ProductView[];
  /** Full-text search over the catalog. */
  search(term: string): ProductView[];
}

/** React hook: expose the catalog and its filter/search actions to the UI. */
export function useCatalog(): CatalogController {
  const [term, setTerm] = useState("");
  log(`useCatalog term=${term}`);
  return {
    products: services.catalog.listProducts(),
    filter: (category) => services.catalog.byCategory(category),
    search: (next) => {
      setTerm(next);
      return services.catalog.search(next);
    },
  };
}
