import type { ProductId } from "./product.js";

/** How much of a product we hold, and how much is spoken for. */
export interface InventoryRecord {
  productId: ProductId;
  onHand: number;
  reserved: number;
}

/** A coarse stock signal the UI and catalog can render without exact counts. */
export type StockLevel = "out" | "low" | "in";

/** A request to hold stock for a product during checkout. */
export interface Reservation {
  productId: ProductId;
  quantity: number;
}
