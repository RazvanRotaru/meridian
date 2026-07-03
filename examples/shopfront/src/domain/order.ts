import type { PriceBreakdown } from "./money.js";
import type { CartItem } from "./cart.js";

/** Where an order is in its lifecycle. */
export type OrderStatus = "pending" | "paid" | "failed" | "cancelled";

/** A single purchased line, frozen at checkout time. */
export interface OrderLine {
  productId: string;
  title: string;
  quantity: number;
  lineTotalCents: number;
}

/** A placed, priced order ready to be stored and confirmed. */
export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  lines: OrderLine[];
  price: PriceBreakdown;
  createdAt: string;
}

/** What checkout receives before it turns a cart into an order. */
export interface CheckoutRequest {
  cartId: string;
  userId: string;
  paymentToken: string;
  promotionCode?: string;
}

/** Helper alias used when assembling order lines from cart items. */
export type SourceItems = readonly CartItem[];
