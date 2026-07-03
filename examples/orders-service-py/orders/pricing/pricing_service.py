"""Turn a raw request into the money side of an order."""

from __future__ import annotations

from ..domain.order import OrderLine, OrderRequest

TAX_RATE = 0.2


class PricingService:
    """Computes subtotal, discount, tax, and total for an order request."""

    def price(self, request: OrderRequest) -> dict[str, int]:
        """Compute every monetary field for an order request."""
        subtotal_cents = self._subtotal(request.lines)
        discount_cents = self._discount_for(subtotal_cents, request.discount_code)
        taxed_base = subtotal_cents - discount_cents
        tax_cents = self._tax(taxed_base)
        return {
            "subtotal_cents": subtotal_cents,
            "discount_cents": discount_cents,
            "tax_cents": tax_cents,
            "total_cents": taxed_base + tax_cents,
        }

    def _subtotal(self, lines: list[OrderLine]) -> int:
        """Add up the price of every line."""
        return sum(line.quantity * line.unit_price_cents for line in lines)

    def _discount_for(self, subtotal_cents: int, code: str | None) -> int:
        """Apply a flat 10% discount when a known code is present."""
        if not code or not self._is_known_code(code):
            return 0
        return round(subtotal_cents * 0.1)

    def _is_known_code(self, code: str) -> bool:
        """Whether a discount code is one we honor."""
        return code in ("WELCOME10", "LOYAL10")

    def _tax(self, base_cents: int) -> int:
        """Sales tax on the post-discount amount."""
        return round(base_cents * TAX_RATE)
