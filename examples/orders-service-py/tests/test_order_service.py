"""Tests for the order-placing flow — the Python twin of the TS fixture's test files.

Framework-free on purpose: this exercises meridian's test detection (``tests/test_*.py``)
and static coverage (direct hits on ``OrderService``, transitive reach into pricing,
validation, repository, and email), not a test runner. The annotated ``_service`` attribute
is what lets the stdlib-ast analyzer resolve the method calls statically.
"""

from orders.domain.order import OrderLine, OrderRequest
from orders.notifications.email_service import EmailService
from orders.pricing.pricing_service import PricingService
from orders.repository.order_repository import OrderRepository
from orders.services.order_service import OrderService


def _sample_request() -> OrderRequest:
    """A well-formed two-line order request."""
    return OrderRequest(
        customer_id="cust_1",
        lines=[
            OrderLine(sku="tea", quantity=2, unit_price_cents=450),
            OrderLine(sku="mug", quantity=1, unit_price_cents=1200),
        ],
    )


class TestOrderService:
    """Places orders through the real service wiring and checks the money math."""

    _service: OrderService

    def _make_service(self) -> None:
        self._service = OrderService(PricingService(), OrderRepository(), EmailService())

    def test_place_order_stores_and_prices(self) -> None:
        self._make_service()
        order = self._service.place_order(_sample_request())
        assert order.subtotal_cents == 2100
        assert order.total_cents == 2520

    def test_get_order_finds_what_was_placed(self) -> None:
        self._make_service()
        placed = self._service.place_order(_sample_request())
        found = self._service.get_order(placed.id)
        assert found is not None and found.id == placed.id
