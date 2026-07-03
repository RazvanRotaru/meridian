"""Sends transactional email to customers."""

from __future__ import annotations

from ..domain.order import Order


class EmailService:
    """Delivers order confirmations."""

    def send_order_confirmation(self, order: Order) -> None:
        """Let the customer know their order went through."""
        body = self._render_confirmation(order)
        self._deliver(order.customer_id, "Your order is confirmed", body)

    def _render_confirmation(self, order: Order) -> str:
        """Build the human-readable confirmation text."""
        total = order.total_cents / 100
        return f"Thanks! Order {order.id} totalling ${total:.2f} is confirmed."

    def _deliver(self, to: str, subject: str, body: str) -> None:
        """Hand the message off to the mail transport."""
        # Stand-in for a real transport (SES, SendGrid, ...).
        _ = (to, subject, body)
