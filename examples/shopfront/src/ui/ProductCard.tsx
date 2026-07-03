import type { ReactElement } from "react";
import type { ProductView } from "../domain/product.js";
import type { Money } from "../domain/money.js";
import { PriceTag } from "./PriceTag.js";
import { AddToCartButton } from "./AddToCartButton.js";

/** Props for a product card: the display row to render. */
export interface ProductCardProps {
  product: ProductView;
}

/** A single catalog tile. Renders a PriceTag and an AddToCartButton. */
export function ProductCard({ product }: ProductCardProps): ReactElement {
  const price: Money = { amountCents: 0, currency: "USD" };
  return (
    <div className="product-card">
      <h3>{product.title}</h3>
      <PriceTag price={price} />
      <AddToCartButton productId={product.id} disabled={!product.inStock} />
    </div>
  );
}
