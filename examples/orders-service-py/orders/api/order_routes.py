"""Translate incoming HTTP requests into order-service calls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..domain.order import Order, OrderRequest
from ..services.order_service import OrderService
from ..validation.order_validator import ValidationError


@dataclass
class ApiResponse:
    """A minimal HTTP-style response."""

    status: int
    body: Any


class OrderRoutes:
    """The system's front door."""

    def __init__(self, orders: OrderService) -> None:
        self._orders = orders

    def handle_create_order(self, request: OrderRequest) -> ApiResponse:
        """POST /orders — place a new order."""
        try:
            order = self._orders.place_order(request)
            return self._created(order)
        except ValidationError as error:
            return ApiResponse(status=400, body={"error": str(error)})

    def handle_get_order(self, order_id: str) -> ApiResponse:
        """GET /orders/:id — fetch a previously placed order."""
        order = self._orders.get_order(order_id)
        if order is None:
            return ApiResponse(status=404, body={"error": "order not found"})
        return ApiResponse(status=200, body=order)

    def _created(self, order: Order) -> ApiResponse:
        """Shape a 201 response for a freshly placed order."""
        return ApiResponse(status=201, body=order)
