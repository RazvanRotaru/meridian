import type { ReactElement } from "react";
import type { ProductView } from "../domain/product.js";
import { ProductCard } from "./ProductCard.js";

/** Props for the grid: the products to lay out. */
export interface ProductGridProps {
  products: ProductView[];
}

/** Lays out a ProductCard per product in a responsive grid. */
export function ProductGrid({ products }: ProductGridProps): ReactElement {
  return (
    <div className="product-grid">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
