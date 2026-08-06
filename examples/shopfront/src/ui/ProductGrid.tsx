import type { ReactElement } from "react";
import type { ProductId, ProductView } from "../domain/product.js";
import { ProductCard } from "./ProductCard.js";

/** Props for the grid: the products to lay out. */
export interface ProductGridProps {
  products: ProductView[];
  savedProductIds: ReadonlySet<ProductId>;
  onSave(productId: ProductId): void;
}

/** Lays out a ProductCard per product in a responsive grid. */
export function ProductGrid({ products, savedProductIds, onSave }: ProductGridProps): ReactElement {
  return (
    <div className="product-grid">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          saved={savedProductIds.has(product.id)}
          onSave={onSave}
        />
      ))}
    </div>
  );
}
