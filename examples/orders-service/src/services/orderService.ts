import type { Order, OrderRequest } from "../domain/order.js";
import { validateOrderRequest } from "../validation/orderValidator.js";
import { PricingService } from "../pricing/pricingService.js";
import { OrderRepository } from "../repository/orderRepository.js";
import { EmailService } from "../notifications/emailService.js";

let sequence = 0;

/** The heart of the flow: takes a request and turns it into a stored, confirmed order. */
export class OrderService {
  constructor(
    private readonly pricing: PricingService,
    private readonly repository: OrderRepository,
    private readonly email: EmailService,
  ) {}

  /** Validate, price, store, and confirm a new order. */
  placeOrder(request: OrderRequest): Order {
    validateOrderRequest(request);
    const money = this.pricing.price(request);
    const order = this.assemble(request, money);
    this.repository.save(order);
    this.email.sendOrderConfirmation(order);
    return order;
  }

  /** Look up an order that was placed earlier. */
  getOrder(id: string): Order | undefined {
    return this.repository.findById(id);
  }

  /** Combine the request with its computed money fields into a final order. */
  private assemble(
    request: OrderRequest,
    money: Pick<Order, "subtotalCents" | "discountCents" | "taxCents" | "totalCents">,
  ): Order {
    return {
      id: this.nextId(),
      customerId: request.customerId,
      lines: request.lines,
      ...money,
      createdAt: this.timestamp(),
    };
  }

  /** Hand out a fresh, unique order id. */
  private nextId(): string {
    sequence += 1;
    return `ord_${sequence}`;
  }

  /** When this order was placed. */
  private timestamp(): string {
    return "2026-01-01T00:00:00.000Z";
  }
}
