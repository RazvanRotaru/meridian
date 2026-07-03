import type { OrderRequest } from "../domain/order.js";

/** Raised when an incoming order request does not make sense. */
export class ValidationError extends Error {}

/** Check that an order request is well-formed before we price it. */
export function validateOrderRequest(request: OrderRequest): void {
  if (!request.customerId) {
    throw new ValidationError("order is missing a customer");
  }
  if (request.lines.length === 0) {
    throw new ValidationError("order has no items");
  }
  for (const line of request.lines) {
    assertLineIsSane(line.sku, line.quantity, line.unitPriceCents);
  }
}

/** Reject negative quantities, empty SKUs, and impossible prices. */
function assertLineIsSane(sku: string, quantity: number, unitPriceCents: number): void {
  if (!sku) {
    throw new ValidationError("order line is missing a product");
  }
  if (quantity <= 0) {
    throw new ValidationError(`order line for ${sku} has a non-positive quantity`);
  }
  if (unitPriceCents < 0) {
    throw new ValidationError(`order line for ${sku} has a negative price`);
  }
}
