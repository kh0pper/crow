"""benchmark.py: the hold-the-starting-mix shadow value.

The benchmark answers one question: what would this owner's equity be if the
starting mix of base and quote had simply been held, with every resting order
forgotten?  The starting mix is a kv record on the store (`store.get` /
`store.put` only, JSON, so the Decimals go in as strings), keyed per owner, and
the valuation is `base * price + quote` at whatever price the caller marks.

`start` is a no-op once the owner has a mix, so a restart of the engine can
never reset the shadow to the current, already-traded holding.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

D = Decimal

KEY_PREFIX = "benchmark:"


def _dec(value) -> D:
    """`Decimal(str(value))`: params and rows arrive from JSON, not as Decimals."""
    return D(str(value))


class Benchmark:
    """One frozen starting mix per owner, valued at a given price."""

    def __init__(self, store: Any):
        self.store = store

    # ------------------------------------------------ keys
    @staticmethod
    def _key(owner: str) -> str:
        return f"{KEY_PREFIX}{owner}"

    def _mix(self, owner: str) -> dict:
        """The owner's stored starting mix, or `KeyError` when never started."""
        record = self.store.get(self._key(owner))
        if record is None:
            raise KeyError(owner)
        return record

    # ------------------------------------------------ public API
    def start(self, owner: str, base: Any, quote: Any, price: Any) -> None:
        """Record the mix once; a later call for the same owner changes nothing."""
        key = self._key(owner)
        if self.store.get(key) is not None:
            return
        self.store.put(
            key,
            {
                "base": str(_dec(base)),
                "quote": str(_dec(quote)),
                "price": str(_dec(price)),
            },
        )

    def value(self, owner: str, price: Any) -> D:
        """What the starting mix is worth at *price*."""
        mix = self._mix(owner)
        return _dec(mix["base"]) * _dec(price) + _dec(mix["quote"])

    def vs_hold(self, owner: str, equity: Any, price: Any) -> D:
        """The owner's equity minus the hold-the-mix shadow (positive is ahead)."""
        return _dec(equity) - self.value(owner, price)