import type { ReactElement } from "react";
import { useCart } from "../hooks/useCart.js";
import { CartLine } from "./CartLine.js";
import { CheckoutBar } from "./CheckoutBar.js";

/** The slide-out basket panel. Maps CartLine per item and renders the CheckoutBar. */
export function CartPanel(): ReactElement {
  const cart = useCart();
  return (
    <aside className="cart-panel">
      <h2>Your cart · {cart.total}</h2>
      <ul>
        {cart.cart.items.map((item) => (
          <CartLine key={item.productId} item={item} />
        ))}
      </ul>
      <CheckoutBar />
    </aside>
  );
}
