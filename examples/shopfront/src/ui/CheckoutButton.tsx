import type { ReactElement } from "react";
import { useCheckout } from "../hooks/useCheckout.js";

/** Props for the checkout button: the cart and user to submit. */
export interface CheckoutButtonProps {
  cartId: string;
  userId: string;
}

/** The final button in the flow. onClick drives useCheckout().placeOrder(). */
export function CheckoutButton({ cartId, userId }: CheckoutButtonProps): ReactElement {
  const checkout = useCheckout();
  return (
    <button
      className="checkout"
      onClick={() => checkout.placeOrder({ cartId, userId, paymentToken: "tok_demo" })}
    >
      Place order · {checkout.quote}
    </button>
  );
}
