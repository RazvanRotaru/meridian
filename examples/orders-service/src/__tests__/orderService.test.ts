/**
 * Tests for the order-placing flow. Framework-free on purpose: the fixture exercises
 * meridian's test detection and static coverage (direct hits on OrderService, transitive
 * reach into pricing/validation/repository/email), not a test runner.
 */

import { OrderService } from "../services/orderService.js";
import { PricingService } from "../pricing/pricingService.js";
import { OrderRepository } from "../repository/orderRepository.js";
import { EmailService } from "../notifications/emailService.js";
import type { OrderRequest } from "../domain/order.js";

/** Minimal assertion so this fixture needs no test-framework dependency. */
function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** A well-formed two-line order request. */
function sampleRequest(): OrderRequest {
  return {
    customerId: "cust_1",
    lines: [
      { sku: "tea", quantity: 2, unitPriceCents: 450 },
      { sku: "mug", quantity: 1, unitPriceCents: 1200 },
    ],
  };
}

function buildService(): OrderService {
  return new OrderService(new PricingService(), new OrderRepository(), new EmailService());
}

export function testPlaceOrderStoresAndPrices(): void {
  const service = buildService();
  const order = service.placeOrder(sampleRequest());
  expectEqual(order.subtotalCents, 2100, "subtotal");
  expectEqual(order.totalCents, 2520, "total with 20% tax");
}

export function testGetOrderFindsWhatWasPlaced(): void {
  const service = buildService();
  const placed = service.placeOrder(sampleRequest());
  expectEqual(service.getOrder(placed.id)?.id, placed.id, "round-trip id");
}
