import type { Money } from "./money.js";

/** A stable product identifier (an opaque SKU string in this fixture). */
export type ProductId = string;

/** Coarse product grouping the catalog and filters organize around. */
export type Category = "apparel" | "books" | "electronics" | "home" | "toys";

/** A sellable item in the catalog. */
export interface Product {
  id: ProductId;
  title: string;
  category: Category;
  price: Money;
  tags: string[];
  active: boolean;
}

/** A catalog row shaped for the UI: the product plus a pre-formatted price string. */
export interface ProductView {
  id: ProductId;
  title: string;
  category: Category;
  formattedPrice: string;
  inStock: boolean;
}
