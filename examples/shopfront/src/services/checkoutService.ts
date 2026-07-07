import type { Cart } from "../domain/cart.js";
import type { CheckoutRequest, Order } from "../domain/order.js";
import { CartService } from "./cartService.js";
import { PricingService } from "./pricingService.js";
import { PromotionService } from "./promotionService.js";
import { InventoryService } from "./inventoryService.js";
import { PaymentService } from "./paymentService.js";
import { NotificationService } from "./notificationService.js";
import { UserService } from "./userService.js";
import { AuditService } from "./auditService.js";
import { OrderRepository } from "../repository/orderRepository.js";
import { assembleOrder } from "./orderFactory.js";
import { formatMoney } from "../domain/money.js";
import { log } from "../utils/logger.js";
import { err, ok, type Result } from "../utils/result.js";

/**
 * The fan-out orchestrator. placeOrder() is deliberately the busiest method in the codebase:
 * it pulls together nine other collaborators to turn a cart into a paid, stored, confirmed
 * order. Order assembly moved out to orderFactory — this class now only sequences the flow.
 */
export class CheckoutService {
  constructor(
    private readonly _cart: CartService,
    private readonly _pricing: PricingService,
    private readonly _promotion: PromotionService,
    private readonly _inventory: InventoryService,
    private readonly _payment: PaymentService,
    private readonly _orders: OrderRepository,
    private readonly _notifications: NotificationService,
    private readonly _audit: AuditService,
    private readonly _users: UserService,
  ) {}

  /** Validate, price, promote, reserve, charge, store, and confirm a checkout. */
  placeOrder(request: CheckoutRequest): Result<Order> {
    const cart = this._cart.getCart(request.cartId);
    const user = this._users.findById(request.userId);
    if (!user) {
      return err("unknown user");
    }
    const price = this._pricing.priceCart(cart);
    const campaigns = this._promotion.eligibleCampaigns(cart);
    this.reserveAll(cart);
    const payment = this._payment.charge(request.paymentToken, price.total);
    if (!payment.ok) {
      this._audit.record("checkout-failed", request.cartId);
      return err("payment declined");
    }
    const order = assembleOrder(cart, user, price);
    this._orders.record(order);
    this._notifications.sendOrderConfirmation(order);
    this._audit.record("checkout-ok", `${order.id} ${campaigns.join(",")}`);
    log(`order ${order.id} placed for ${formatMoney(price.total)}`);
    return ok(order);
  }

  /** Preview the total without committing — reuses the pricing path. */
  quote(cartId: string): string {
    const breakdown = this._pricing.priceCart(this._cart.getCart(cartId));
    return formatMoney(breakdown.total);
  }

  /** Put a hold on every line before we charge. */
  private reserveAll(cart: Cart): void {
    for (const item of cart.items) {
      this._inventory.reserveStock(item.productId, item.quantity);
    }
  }
}
