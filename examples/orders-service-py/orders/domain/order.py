"""Core order shapes that move through the system."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class OrderLine:
    """A single thing a customer wants to buy, and how many."""

    sku: str
    quantity: int
    unit_price_cents: int


@dataclass
class OrderRequest:
    """What a customer submits when they want to place an order."""

    customer_id: str
    lines: list[OrderLine]
    discount_code: str | None = None


@dataclass
class Order:
    """A priced, validated order ready to be stored and confirmed."""

    id: str
    customer_id: str
    lines: list[OrderLine]
    subtotal_cents: int
    discount_cents: int
    tax_cents: int
    total_cents: int
    created_at: str
