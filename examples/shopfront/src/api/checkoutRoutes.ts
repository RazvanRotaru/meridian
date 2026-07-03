import type { CheckoutRequest } from "../domain/order.js";
import type { CheckoutService } from "../services/index.js";
import { type ApiResponse, created, fail } from "./response.js";
import { isOk } from "../utils/result.js";
import { log } from "../utils/logger.js";

/**
 * HTTP front door for checkout. handlePlaceOrder starts the deepest chain in the graph:
 * handler -> CheckoutService.placeOrder -> PricingService.priceCart -> PromotionService.apply
 * -> PricingService.basePrice -> legacy.clamp.
 */
export class CheckoutRoutes {
  constructor(private readonly _checkout: CheckoutService) {}

  /** POST /checkout — place an order for a cart. */
  handlePlaceOrder(request: CheckoutRequest): ApiResponse {
    log(`POST /checkout cart=${request.cartId}`);
    const result = this._checkout.placeOrder(request);
    if (!isOk(result)) {
      return fail(402, result.error);
    }
    return created(result.value);
  }

  /** GET /checkout/quote — preview the total without charging. */
  handleQuote(cartId: string): ApiResponse {
    return created({ total: this._checkout.quote(cartId) });
  }
}
