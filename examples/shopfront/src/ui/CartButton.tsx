import type { ReactElement } from "react";
import { useCart } from "../hooks/useCart.js";

/** Nav-bar cart indicator. Reads the cart total via useCart(). */
export function CartButton(): ReactElement {
  const cart = useCart();
  return (
    <button className="cart-button">
      Cart · {cart.total} · {cart.cart.items.length}
    </button>
  );
}
