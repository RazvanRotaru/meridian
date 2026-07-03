"""Validate incoming order requests before they are priced."""

from __future__ import annotations

from ..domain.order import OrderRequest


class ValidationError(Exception):
    """Raised when an incoming order request does not make sense."""


def validate_order_request(request: OrderRequest) -> None:
    """Check that an order request is well-formed before we price it."""
    if not request.customer_id:
        raise ValidationError("order is missing a customer")
    if not request.lines:
        raise ValidationError("order has no items")
    for line in request.lines:
        _assert_line_is_sane(line.sku, line.quantity, line.unit_price_cents)


def _assert_line_is_sane(sku: str, quantity: int, unit_price_cents: int) -> None:
    """Reject empty SKUs, non-positive quantities, and impossible prices."""
    if not sku:
        raise ValidationError("order line is missing a product")
    if quantity <= 0:
        raise ValidationError(f"order line for {sku} has a non-positive quantity")
    if unit_price_cents < 0:
        raise ValidationError(f"order line for {sku} has a negative price")
