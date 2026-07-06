/**
 * Direct tests for the pricing math — gives PricingService.price a first-degree ("tested
 * directly") coverage verdict, distinct from the transitive reach it also gets via
 * OrderService.placeOrder.
 */

import { PricingService } from "../pricing/pricingService.js";
import type { OrderRequest } from "../domain/order.js";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function requestWith(discountCode?: string): OrderRequest {
  return {
    customerId: "cust_2",
    lines: [{ sku: "kettle", quantity: 1, unitPriceCents: 10000 }],
    discountCode,
  };
}

export function testPriceWithoutDiscount(): void {
  const money = new PricingService().price(requestWith());
  expectEqual(money.discountCents, 0, "no discount");
  expectEqual(money.totalCents, 12000, "subtotal + 20% tax");
}

export function testPriceHonorsKnownDiscountCode(): void {
  const money = new PricingService().price(requestWith("WELCOME10"));
  expectEqual(money.discountCents, 1000, "10% discount");
  expectEqual(money.totalCents, 10800, "discounted base + tax");
}
