import { describe, it } from "vitest";

import {
  testGetOrderFindsWhatWasPlaced,
  testPlaceOrderStoresAndPrices,
} from "../src/__tests__/orderService.test";
import {
  testPriceHonorsKnownDiscountCode,
  testPriceWithoutDiscount,
} from "../src/__tests__/pricingService.test";

/**
 * Keep the fixture's tests framework-free for extraction, while letting Vitest execute the exact
 * same exported scenarios when Meridian needs real branch counters for its sample artifact.
 */
describe("orders-service sample scenarios", () => {
  it("stores and prices an order", testPlaceOrderStoresAndPrices);
  it("finds an order after it is placed", testGetOrderFindsWhatWasPlaced);
  it("prices an order without a discount", testPriceWithoutDiscount);
  it("honors a known discount code", testPriceHonorsKnownDiscountCode);
});
