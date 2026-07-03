import type { ReactElement } from "react";
import { useCart } from "../hooks/useCart.js";

/** Props for the add-to-cart button: which product to add. */
export interface AddToCartButtonProps {
  productId: string;
  disabled?: boolean;
}

/** A button whose onClick fires a useCart() action to add the product. */
export function AddToCartButton({ productId, disabled }: AddToCartButtonProps): ReactElement {
  const cart = useCart();
  return (
    <button className="add" disabled={disabled} onClick={() => cart.add(productId)}>
      Add to cart
    </button>
  );
}
