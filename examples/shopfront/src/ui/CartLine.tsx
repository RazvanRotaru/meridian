import type { ReactElement } from "react";
import type { CartItem } from "../domain/cart.js";
import { useCart } from "../hooks/useCart.js";
import { PriceTag } from "./PriceTag.js";

/** Props for one cart line: the item to render. */
export interface CartLineProps {
  item: CartItem;
}

/** One row in the cart panel, with a remove action wired to useCart(). */
export function CartLine({ item }: CartLineProps): ReactElement {
  const cart = useCart();
  return (
    <li className="cart-line">
      <span>{item.productId} × {item.quantity}</span>
      <PriceTag price={item.unitPrice} />
      <button onClick={() => cart.remove(item.productId)}>remove</button>
    </li>
  );
}
