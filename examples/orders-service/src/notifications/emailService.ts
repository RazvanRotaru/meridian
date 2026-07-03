import type { Order } from "../domain/order.js";

/** Sends transactional email to customers. */
export class EmailService {
  /** Let the customer know their order went through. */
  sendOrderConfirmation(order: Order): void {
    const body = this.renderConfirmation(order);
    this.deliver(order.customerId, "Your order is confirmed", body);
  }

  /** Build the human-readable confirmation text. */
  private renderConfirmation(order: Order): string {
    const total = (order.totalCents / 100).toFixed(2);
    return `Thanks! Order ${order.id} totalling $${total} is confirmed.`;
  }

  /** Hand the message off to the mail transport. */
  private deliver(to: string, subject: string, body: string): void {
    // Stand-in for a real transport (SES, SendGrid, ...).
    void to;
    void subject;
    void body;
  }
}
