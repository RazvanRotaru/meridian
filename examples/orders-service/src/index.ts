import { OrderRoutes } from "./api/orderRoutes.js";
import { OrderService } from "./services/orderService.js";
import { PricingService } from "./pricing/pricingService.js";
import { OrderRepository } from "./repository/orderRepository.js";
import { EmailService } from "./notifications/emailService.js";

/** Wire the whole order-processing flow together and return the HTTP entry points. */
export function buildOrdersApp(): OrderRoutes {
  const pricing = new PricingService();
  const repository = new OrderRepository();
  const email = new EmailService();
  const orders = new OrderService(pricing, repository, email);
  return new OrderRoutes(orders);
}
