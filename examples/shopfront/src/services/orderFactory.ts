import type { Cart } from "../domain/cart.js";
import type { Order, OrderLine } from "../domain/order.js";
import type { PriceBreakdown } from "../domain/money.js";
import type { User } from "../domain/user.js";
import { mintId } from "../utils/ids.js";
import { nowIso } from "../utils/clock.js";

/**
 * Turns a priced cart into an immutable Order. Extracted from CheckoutService so the
 * orchestrator only orchestrates — the shape of an order is decided here, in one place.
 */
export function assembleOrder(cart: Cart, user: User, price: PriceBreakdown): Order {
  return {
    id: mintId("order"),
    userId: user.id,
    status: "paid",
    lines: assembleLines(cart),
    price,
    createdAt: nowIso(),
  };
}

/** Freeze cart items into immutable order lines. */
function assembleLines(cart: Cart): OrderLine[] {
  return cart.items.map((item) => ({
    productId: item.productId,
    title: item.productId,
    quantity: item.quantity,
    lineTotalCents: item.unitPrice.amountCents * item.quantity,
  }));
}
