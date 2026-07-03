import type { CheckoutRequest } from "../domain/order.js";
import { services } from "../app.js";
import { isOk } from "../utils/result.js";
import { log } from "../utils/logger.js";

const DEFAULT_CART = "cart_demo";

/** Checkout actions exposed to components. */
export interface CheckoutController {
  /** The current previewed total. */
  quote: string;
  /** Attempt to place the order; returns whether it succeeded. */
  placeOrder(request: CheckoutRequest): boolean;
}

/** React hook: bridge the checkout button to the fan-out orchestrator. */
export function useCheckout(): CheckoutController {
  log("useCheckout render");
  return {
    quote: services.checkout.quote(DEFAULT_CART),
    placeOrder: (request) => isOk(services.checkout.placeOrder(request)),
  };
}
