import type { ReactElement } from "react";
import type { ProductId, ProductView } from "../domain/product.js";
import type { Money } from "../domain/money.js";
import { PriceTag } from "./PriceTag.js";
import { AddToCartButton } from "./AddToCartButton.js";

/** Props for a product card: the display row to render. */
export interface ProductCardProps {
  product: ProductView;
  saved: boolean;
  onSave(productId: ProductId): void;
}

/** A single catalog tile. Renders a PriceTag and an AddToCartButton. */
export function ProductCard({ product, saved, onSave }: ProductCardProps): ReactElement {
  const price: Money = { amountCents: 0, currency: "USD" };
  return (
    <div className="product-card">
      <h3>{product.title}</h3>
      <PriceTag price={price} />
      <AddToCartButton productId={product.id} disabled={!product.inStock} />
      <button type="button" aria-pressed={saved} disabled={saved} onClick={() => onSave(product.id)}>
        {saved ? "Saved" : "Save for later"}
      </button>
    </div>
  );
}
