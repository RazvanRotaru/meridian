/**
 * Composition root. buildServices() is a big fan-out of instantiations — every repository and
 * service is constructed and wired here, including the late-bind that breaks the
 * Pricing <-> Promotion construction cycle. The exported `services` singleton is what the
 * React hooks reach into.
 */

import { ProductRepository } from "./repository/productRepository.js";
import { CartRepository } from "./repository/cartRepository.js";
import { OrderRepository } from "./repository/orderRepository.js";
import { UserRepository } from "./repository/userRepository.js";
import { InventoryRepository } from "./repository/inventoryRepository.js";
import { SavedListRepository } from "./repository/savedListRepository.js";
import { AuditService } from "./services/auditService.js";
import { UserService } from "./services/userService.js";
import { NotificationService } from "./services/notificationService.js";
import { InventoryService } from "./services/inventoryService.js";
import { PaymentService } from "./services/paymentService.js";
import { PricingService } from "./services/pricingService.js";
import { PromotionService } from "./services/promotionService.js";
import { CatalogService } from "./services/catalogService.js";
import { RecommendationService } from "./services/recommendationService.js";
import { CartService } from "./services/cartService.js";
import { CheckoutService } from "./services/checkoutService.js";
import { SavedListService } from "./services/savedListService.js";
import { CatalogRoutes } from "./api/catalogRoutes.js";
import { CartRoutes } from "./api/cartRoutes.js";
import { CheckoutRoutes } from "./api/checkoutRoutes.js";
import { UserRoutes } from "./api/userRoutes.js";
import { log } from "./utils/logger.js";

/** The fully-wired service layer, typed so hook calls through it resolve. */
export interface ShopfrontServices {
  catalog: CatalogService;
  cart: CartService;
  checkout: CheckoutService;
  user: UserService;
  recommendation: RecommendationService;
  savedList: SavedListService;
}

/** The HTTP surface, one route class per resource. */
export interface ShopfrontApp {
  catalogRoutes: CatalogRoutes;
  cartRoutes: CartRoutes;
  checkoutRoutes: CheckoutRoutes;
  userRoutes: UserRoutes;
  services: ShopfrontServices;
}

/** Construct and wire every collaborator. The instantiation fan-out lives here. */
export function buildServices(): ShopfrontServices {
  const productRepo = new ProductRepository();
  const cartRepo = new CartRepository();
  const orderRepo = new OrderRepository();
  const userRepo = new UserRepository();
  const inventoryRepo = new InventoryRepository();
  const savedListRepo = new SavedListRepository();

  const audit = new AuditService();
  const user = new UserService(userRepo);
  const notifications = new NotificationService(user);
  const inventory = new InventoryService(inventoryRepo);
  const payment = new PaymentService(audit);
  const pricing = new PricingService();
  const promotion = new PromotionService(pricing, user);
  pricing.setPromotion(promotion);
  const catalog = new CatalogService(productRepo, inventory);
  const recommendation = new RecommendationService(productRepo, catalog);
  const savedList = new SavedListService(savedListRepo, catalog);
  const cart = new CartService(cartRepo, catalog, inventory, pricing);
  const checkout = new CheckoutService(
    cart,
    pricing,
    promotion,
    inventory,
    payment,
    orderRepo,
    notifications,
    audit,
    user,
  );

  log("shopfront services wired");
  return { catalog, cart, checkout, user, recommendation, savedList };
}

/** Build the HTTP app: wire the routes on top of the services. */
export function buildShopfrontApp(): ShopfrontApp {
  const s = buildServices();
  const notifications = new NotificationService(s.user);
  return {
    catalogRoutes: new CatalogRoutes(s.catalog, s.recommendation),
    cartRoutes: new CartRoutes(s.cart),
    checkoutRoutes: new CheckoutRoutes(s.checkout),
    userRoutes: new UserRoutes(s.user, notifications),
    services: s,
  };
}

/** The process-wide service singleton the React hooks call into. */
export const services: ShopfrontServices = buildServices();
