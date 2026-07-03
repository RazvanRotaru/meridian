/**
 * Core order shapes that move through the system.
 */

/** A single thing a customer wants to buy, and how many. */
export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

/** What a customer submits when they want to place an order. */
export interface OrderRequest {
  customerId: string;
  lines: OrderLine[];
  discountCode?: string;
}

/** A priced, validated order ready to be stored and confirmed. */
export interface Order {
  id: string;
  customerId: string;
  lines: OrderLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
}
