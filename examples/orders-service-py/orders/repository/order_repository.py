"""Stores orders and reads them back."""

from __future__ import annotations

from ..domain.order import Order


class OrderRepository:
    """In-memory stand-in for a database."""

    def __init__(self) -> None:
        self._by_id: dict[str, Order] = {}

    def save(self, order: Order) -> None:
        """Persist an order so it can be looked up later."""
        self._by_id[order.id] = order

    def find_by_id(self, order_id: str) -> Order | None:
        """Find a previously saved order, or None if we have never seen it."""
        return self._by_id.get(order_id)

    def count(self) -> int:
        """How many orders we are currently holding."""
        return len(self._by_id)
