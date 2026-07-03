import type { Order, OrderRequest } from "../domain/order.js";
import { OrderService } from "../services/orderService.js";
import { ValidationError } from "../validation/orderValidator.js";

/** A minimal HTTP-style response. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Translates incoming HTTP requests into order-service calls. The system's front door. */
export class OrderRoutes {
  constructor(private readonly orders: OrderService) {}

  /** POST /orders — place a new order. */
  handleCreateOrder(request: OrderRequest): ApiResponse {
    try {
      const order = this.orders.placeOrder(request);
      return this.created(order);
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /** GET /orders/:id — fetch a previously placed order. */
  handleGetOrder(id: string): ApiResponse {
    const order = this.orders.getOrder(id);
    if (!order) {
      return { status: 404, body: { error: "order not found" } };
    }
    return { status: 200, body: order };
  }

  /** Shape a 201 response for a freshly placed order. */
  private created(order: Order): ApiResponse {
    return { status: 201, body: order };
  }

  /** Map domain errors onto HTTP status codes. */
  private toErrorResponse(error: unknown): ApiResponse {
    if (error instanceof ValidationError) {
      return { status: 400, body: { error: error.message } };
    }
    return { status: 500, body: { error: "internal error" } };
  }
}
