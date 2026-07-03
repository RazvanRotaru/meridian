import type { ReactElement } from "react";
import { CheckoutButton } from "./CheckoutButton.js";

/** The action bar pinned to the bottom of the cart panel. Renders CheckoutButton. */
export function CheckoutBar(): ReactElement {
  return (
    <div className="checkout-bar">
      <CheckoutButton cartId="cart_demo" userId="user_demo" />
    </div>
  );
}
