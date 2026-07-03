import type { Order } from "../domain/order.js";
import { UserService } from "./userService.js";
import { formatMoney } from "../utils/legacy.js";
import { Logger } from "../utils/logger.js";

/** Sends transactional messages. Depends on UserService to resolve who to email. */
export class NotificationService {
  private readonly log = new Logger("notify");

  constructor(private readonly _users: UserService) {}

  /** Tell the shopper their order went through. */
  sendOrderConfirmation(order: Order): void {
    const email = this._users.emailFor(order.userId);
    this.log.info(`emailing ${email}: order ${order.id} total ${formatMoney(order.price.total)}`);
  }

  /** Welcome a freshly registered shopper. */
  sendWelcome(userId: string): void {
    const email = this._users.emailFor(userId);
    this.log.info(`welcome email to ${email}`);
  }
}
