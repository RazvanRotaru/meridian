"""The heart of the flow: a request becomes a stored, confirmed order."""

from __future__ import annotations

from ..domain.order import Order, OrderRequest
from ..notifications.email_service import EmailService
from ..pricing.pricing_service import PricingService
from ..repository.order_repository import OrderRepository
from ..validation.order_validator import validate_order_request

_sequence = 0


class OrderService:
    """Validates, prices, stores, and confirms new orders."""

    def __init__(self, pricing: PricingService, repository: OrderRepository, email: EmailService) -> None:
        self._pricing = pricing
        self._repository = repository
        self._email = email

    def place_order(self, request: OrderRequest) -> Order:
        """Validate, price, store, and confirm a new order."""
        validate_order_request(request)
        money = self._pricing.price(request)
        order = self._assemble(request, money)
        self._repository.save(order)
        self._email.send_order_confirmation(order)
        return order

    def get_order(self, order_id: str) -> Order | None:
        """Look up an order that was placed earlier."""
        return self._repository.find_by_id(order_id)

    def _assemble(self, request: OrderRequest, money: dict[str, int]) -> Order:
        """Combine the request with its computed money fields into a final order."""
        return Order(
            id=self._next_id(),
            customer_id=request.customer_id,
            lines=request.lines,
            subtotal_cents=money["subtotal_cents"],
            discount_cents=money["discount_cents"],
            tax_cents=money["tax_cents"],
            total_cents=money["total_cents"],
            created_at="2026-01-01T00:00:00.000Z",
        )

    def _next_id(self) -> str:
        """Hand out a fresh, unique order id."""
        global _sequence
        _sequence += 1
        return f"ord_{_sequence}"
