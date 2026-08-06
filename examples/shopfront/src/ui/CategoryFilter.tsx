import type { ReactElement } from "react";
import type { Category } from "../domain/product.js";
import { useCatalog } from "../hooks/useCatalog.js";

const CATEGORIES: Category[] = ["apparel", "books", "electronics", "home", "toys"];

/** Category chips that re-filter the catalog via useCatalog(). */
export function CategoryFilter(): ReactElement {
  const catalog = useCatalog();
  return (
    <ul className="category-filter">
      {CATEGORIES.map((category) => (
        <li key={category}>
          <button type="button" onClick={() => catalog.filter(category)}>{category}</button>
        </li>
      ))}
    </ul>
  );
}
