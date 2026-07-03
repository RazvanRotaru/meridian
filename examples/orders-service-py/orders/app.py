"""Wire the whole order-processing flow together."""

from __future__ import annotations

from .api.order_routes import OrderRoutes
from .notifications.email_service import EmailService
from .pricing.pricing_service import PricingService
from .repository.order_repository import OrderRepository
from .services.order_service import OrderService


def build_orders_app() -> OrderRoutes:
    """Wire the whole order-processing flow together and return the HTTP entry points."""
    pricing = PricingService()
    repository = OrderRepository()
    email = EmailService()
    orders = OrderService(pricing, repository, email)
    return OrderRoutes(orders)
