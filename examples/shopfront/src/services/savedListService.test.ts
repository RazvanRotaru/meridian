import type { UserId } from "../domain/user.js";
import { InventoryRepository } from "../repository/inventoryRepository.js";
import { ProductRepository } from "../repository/productRepository.js";
import { SavedListRepository } from "../repository/savedListRepository.js";
import { CatalogService } from "./catalogService.js";
import { InventoryService } from "./inventoryService.js";
import { SavedListService } from "./savedListService.js";

const USER_ID: UserId = "user_saved_items_test";
const PRODUCT_ID = "sku_saved_umbrella";

/** Tiny assertion helper so this fixture remains runnable without a test framework. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Construct the real repository/service chain with one active, in-stock catalog product. */
function buildSubject(): SavedListService {
  const products = new ProductRepository();
  products.save({
    id: PRODUCT_ID,
    title: "Packable umbrella",
    category: "apparel",
    price: { amountCents: 2499, currency: "USD" },
    tags: ["travel", "rain"],
    active: true,
  });

  const inventory = new InventoryRepository();
  inventory.save({ id: PRODUCT_ID, productId: PRODUCT_ID, onHand: 12, reserved: 0 });
  const catalog = new CatalogService(products, new InventoryService(inventory));
  return new SavedListService(new SavedListRepository(), catalog);
}

/** Saving a known product returns its display data and keeps duplicate saves idempotent. */
export function savesKnownProductsForOneUser(): void {
  const subject = buildSubject();

  const first = subject.save(USER_ID, PRODUCT_ID);
  assert(first.ok, "expected the catalog product to be saved");
  assert(first.value.title === "Packable umbrella", "expected current catalog title");
  assert(first.value.formattedPrice === "$24.99", "expected current catalog price");
  assert(subject.contains(USER_ID, PRODUCT_ID), "expected saved-list membership");

  const second = subject.save(USER_ID, PRODUCT_ID);
  assert(second.ok, "expected a repeated save to succeed");
  assert(subject.list(USER_ID).length === 1, "expected repeated saves to remain idempotent");
}

/** Products outside the active catalog are rejected without mutating the list. */
export function rejectsUnknownProductsForOneUser(): void {
  const subject = buildSubject();

  const result = subject.save(USER_ID, "sku_missing");
  assert(!result.ok, "expected an unknown product to be rejected");
  assert(subject.list(USER_ID).length === 0, "expected a failed save to leave the list empty");
}

/** Removing a saved product returns the refreshed empty list. */
export function removesProductsForOneUser(): void {
  const subject = buildSubject();
  const saved = subject.save(USER_ID, PRODUCT_ID);
  assert(saved.ok, "expected setup save to succeed");

  const remaining = subject.remove(USER_ID, PRODUCT_ID);
  assert(remaining.length === 0, "expected the saved product to be removed");
  assert(!subject.contains(USER_ID, PRODUCT_ID), "expected membership to be cleared");
}

/** Execute the contract tests when this module is run directly by a TypeScript loader. */
export function runSavedListServiceTests(): void {
  savesKnownProductsForOneUser();
  rejectsUnknownProductsForOneUser();
  removesProductsForOneUser();
}

runSavedListServiceTests();
