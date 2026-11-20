"""One owner's holdings and equity, derived from its capital plus its order rows.

A resting order moves nothing between an owner's *total* holdings: it only holds
funds, so `reserved_*` rises and `available_*` falls.  Totals come from filled
parts alone (proceeds for a sell, cost and fees for a buy).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from .money import BUY
from .store import LIVE_STATUSES, Store

D = Decimal


@dataclass(frozen=True)
class Holding:
    """One owner's totals for one product, in that product's quote and base currency.

    `quote` and `base` are totals: reservations are NOT subtracted from them.
    """

    quote: Decimal
    base: Decimal
    reserved_quote: Decimal
    reserved_base: Decimal

    @property
    def available_quote(self) -> Decimal:
        """Quote currency still free to spend."""
        return self.quote - self.reserved_quote

    @property
    def available_base(self) -> Decimal:
        """Base currency not already committed to a resting sell."""
        return self.base - self.reserved_base


EMPTY = Holding(D(0), D(0), D(0), D(0))


class Ledger:
    """Reads a `Store`; holds no state of its own beyond the fee rate."""

    def __init__(self, store: Store, *, fee_rate: Decimal):
        self.store = store
        self.fee_rate = D(fee_rate)

    # ------------------------------------------------ per (owner, product) totals
    def _holdings(
        self, owner: Optional[str] = None
    ) -> dict[tuple[str, str], Holding]:
        """(owner, product) pairs — all of them, or just *owner*'s — with capital."""
        acc: dict[tuple[str, str], list[Decimal]] = {}

        def slot(own: str, product: str) -> list[Decimal]:
            return acc.setdefault((own, product), [D(0), D(0), D(0), D(0)])

        # A bot's capital is counted once, on its own product, even when it has
        # orders in other products.  Filtered in SQL: only the owner's own rows
        # (bots and orders) are read when an owner is given.
        if owner is None:
            bots = self.store.list_bots()
        else:
            bot = self.store.get_bot(owner)
            bots = [bot] if bot is not None else []
        for bot in bots:
            row = slot(bot["id"], bot["product"])
            row[0] += bot["capital_quote"]
            row[1] += bot["capital_base"]

        # Owners with no bot row (orphan, ai, a removed bot) start from zero.
        for o in self.store.orders(owner=owner):
            row = slot(o["owner"], o["product"])
            filled_size, filled_value, fees = (
                o["filled_size"],
                o["filled_value"],
                o["fees"],
            )
            live = o["status"] in LIVE_STATUSES
            remaining = (o["size"] - filled_size) if live else D(0)
            if o["side"] == BUY:
                row[0] -= filled_value + fees
                row[1] += filled_size
                if live:  # the fee is included in the reservation
                    row[2] += remaining * o["price"] * (1 + self.fee_rate)
            else:
                row[0] += filled_value - fees
                row[1] -= filled_size
                if live:
                    row[3] += remaining

        return {key: Holding(*values) for key, values in acc.items()}

    def _product_for(self, owner: str, product: Optional[str]) -> str:
        """The product to report on: explicit, else the owner's bot product."""
        if product is not None:
            return product
        bot = self.store.get_bot(owner)
        if bot is None:
            raise ValueError(f"owner {owner!r} has no bot row; pass a product")
        return bot["product"]

    # ------------------------------------------------ public API
    def holding(self, owner: str, product: Optional[str] = None) -> Holding:
        """The owner's holdings on *product* (default: its bot's own product)."""
        prod = self._product_for(owner, product)
        return self._holdings(owner).get((owner, prod), EMPTY)

    def equity(
        self,
        owner: str,
        prices: dict[str, Decimal],
        product: Optional[str] = None,
    ) -> Decimal:
        """Mark-to-market value: quote plus base at the product's price."""
        prod = self._product_for(owner, product)
        h = self.holding(owner, prod)
        return h.quote + h.base * D(prices[prod])

    def unallocated(self, totals: dict[str, Decimal]) -> dict[str, Decimal]:
        """Per currency: the exchange total minus what every owner holds.

        Negative values are returned as they are (the exchange is short).  Every
        currency seen in *totals* or in any owner's holdings appears in the result.
        """
        held: dict[str, Decimal] = {}
        for (_owner, product), h in self._holdings().items():
            base, quote = product.split("-", 1)
            held[quote] = held.get(quote, D(0)) + h.quote
            held[base] = held.get(base, D(0)) + h.base
        return {
            cur: D(totals.get(cur, D(0))) - held.get(cur, D(0))
            for cur in set(totals) | set(held)
        }