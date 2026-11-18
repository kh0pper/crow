"""The order gateway's read-only check chain.

`OrderGateway.check()` answers one question — may this intent go out? — and stops
at the first refusal.  For a place intent the order is fixed:

    BAD_INTENT -> HALTED -> LIVE_DISABLED -> PRODUCT_NOT_ALLOWED -> OWNER_PAUSED
    -> STALE_MARKET -> CLOCK_SKEW -> TOO_SMALL -> ORDER_TOO_LARGE -> DAILY_CAP
    -> RATE_CAP -> INSUFFICIENT_HOLDING -> UNALLOCATED_NEGATIVE -> DRAWDOWN_STOP

A cancel intent is answered by ownership alone (NOT_OWNER) and skips every other
check, so a halt or a spent budget never blocks taking an order off the book.

`check()` is read-only: it writes no order row and never moves a high-water mark,
and it never calls the exchange — the exchange handed to the constructor is kept
for submit/cancel, which this phase does not have.  Money and size are `Decimal`
throughout (the rounding, the fee-inclusive buy cost, the maker pricing and the
minimums all come from `money.py`); the only floats are a snapshot's timestamp
and the measured clock skew.  P1 is dry-run only, so a route that is not "dry"
is refused while `live_enabled` is false.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from . import money
from .ledger import Ledger
from .limits import CapWindow, Limits
from .money import ProductSpec
from .snapshot import SnapshotCache
from .store import ACTIVE, Store
from .strategies.base import MarketSnapshot, OrderIntent

D = Decimal

# ---------------------------------------------------------------- refusal codes
BAD_INTENT = "BAD_INTENT"  # not a place/cancel, or a place missing its numbers
HALTED = "HALTED"  # the halt flag is set
LIVE_DISABLED = "LIVE_DISABLED"  # a live route while live trading is off
PRODUCT_NOT_ALLOWED = "PRODUCT_NOT_ALLOWED"  # unresolved, or outside the allow-list
OWNER_PAUSED = "OWNER_PAUSED"  # a bot source whose bot is absent or not ACTIVE
STALE_MARKET = "STALE_MARKET"  # no snapshot, or one older than 2 poll windows
CLOCK_SKEW = "CLOCK_SKEW"  # the skew is unknown or beyond the tolerance
TOO_SMALL = "TOO_SMALL"  # below the product's base or quote minimum
ORDER_TOO_LARGE = "ORDER_TOO_LARGE"  # over the per-source single-order cap
DAILY_CAP = "DAILY_CAP"  # over the global or the ai daily notional cap
RATE_CAP = "RATE_CAP"  # over the global or the ai rolling-hour order count
INSUFFICIENT_HOLDING = "INSUFFICIENT_HOLDING"  # the owner cannot fund the order
UNALLOCATED_NEGATIVE = "UNALLOCATED_NEGATIVE"  # the exchange is short of the owners
DRAWDOWN_STOP = "DRAWDOWN_STOP"  # the owner's or the portfolio's drawdown stop
NOT_OWNER = "NOT_OWNER"  # a cancel of an order this owner does not own

# The high-water mark key the portfolio drawdown stop reads and the runner
# ratchets with `portfolio_equity()`.
PORTFOLIO_OWNER = "portfolio"

# A snapshot is stale once it is older than this many poll windows.
STALE_WINDOWS = 2
# The most clock skew tolerated, in seconds (either direction).
MAX_CLOCK_SKEW_S = 5.0
# A bot's own drawdown stop when its params do not name one (percent).
DEFAULT_DRAWDOWN_PCT = 20


@dataclass(frozen=True)
class GatewayResult:
    """The outcome of a submit attempt (filled in by the submit path, Task 3c)."""

    ok: bool
    cid: Optional[str]
    refusal: Optional[str]


class OrderGateway:
    """The single gate every intent passes before it may reach the exchange.

    Constructed with its collaborators rather than reaching for them, so the
    check chain can be exercised against any store, clock and snapshot cache.
    `totals()` is the caller's cached exchange totals per currency.  The
    `CapWindow` is built by the caller on the same clock that stamps order rows;
    `now` here is only for snapshot staleness.
    """

    def __init__(
        self,
        *,
        store: Store,
        ledger: Ledger,
        limits: Limits,
        caps: CapWindow,
        snapshots: SnapshotCache,
        spec_for: Callable[[str], ProductSpec],
        fee_rate: Decimal,
        totals: Callable[[], dict[str, Decimal]],
        exchange=None,
        is_halted: Optional[Callable[[], bool]] = None,
        route_for: Optional[Callable[[str], str]] = None,
        live_enabled: bool = False,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.store = store
        self.ledger = ledger
        self.limits = limits
        self.caps = caps
        self.snapshots = snapshots
        self.spec_for = spec_for
        self.fee_rate = D(fee_rate)
        self.totals = totals
        self.exchange = exchange  # Task 3c's submit/cancel; check() never touches it
        self.is_halted = is_halted if is_halted is not None else _never_halted
        self.route_for = route_for if route_for is not None else _always_dry
        self.live_enabled = live_enabled
        self.now = now

    # ------------------------------------------------ the chain
    def check(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str] = None,
    ) -> Optional[str]:
        """Return the first refusal for *intent*, or None when it may go out.

        Place intents run the whole chain in the module docstring's order; cancel
        intents run the ownership check alone.  `source` is "bot" or "ai".
        `product` defaults to the owner's bot row product and must be given when
        the owner has no bot row ("ai").  Reads store, caps, ledger and snapshots;
        calls no exchange method and writes nothing.
        """
        if intent.action == "cancel":
            return self._check_cancel(owner, intent)

        if self._is_bad_place(intent):
            return BAD_INTENT
        if self.is_halted():
            return HALTED
        if self.route_for(owner) != "dry" and not self.live_enabled:
            return LIVE_DISABLED

        bot = self.store.get_bot(owner)
        resolved = self._resolve_product(bot, product)
        if resolved is None:
            return PRODUCT_NOT_ALLOWED
        if source == "bot" and (bot is None or bot["status"] != ACTIVE):
            return OWNER_PAUSED

        snap = self.snapshots.get(resolved)
        if snap is None or self._is_stale(snap):
            return STALE_MARKET
        skew = self.snapshots.skew_s()
        if skew is None or abs(skew) > MAX_CLOCK_SKEW_S:
            return CLOCK_SKEW

        spec = self.spec_for(resolved)
        price = money.maker_price(
            intent.side, intent.limit_price, snap.bid, snap.ask, spec.price_increment
        )
        refusal = self._check_size_and_caps(source, intent, price, spec)
        if refusal is not None:
            return refusal
        refusal = self._check_funds(owner, resolved, intent, price)
        if refusal is not None:
            return refusal
        return self._check_drawdown(source, owner, resolved, snap, bot)

    # ------------------------------------------------ cancel
    def _check_cancel(self, owner: str, intent: OrderIntent) -> Optional[str]:
        """NOT_OWNER unless the id is shaped for *owner* and the row says so."""
        cid = intent.cancel_cid
        if not cid or not cid.startswith(f"cb-{owner}-"):
            return NOT_OWNER
        row = self.store.order(cid)
        if row is None or row["owner"] != owner:
            return NOT_OWNER
        return None

    # ------------------------------------------------ step helpers
    @staticmethod
    def _is_bad_place(intent: OrderIntent) -> bool:
        """True when the intent is not a well-formed place (missing side/size/price)."""
        if intent.action != "place":
            return True
        if intent.side not in (money.BUY, money.SELL):
            return True
        if intent.size is None or intent.limit_price is None:
            return True
        return intent.size <= 0 or intent.limit_price <= 0

    def _resolve_product(
        self, bot: Optional[dict], product: Optional[str]
    ) -> Optional[str]:
        """The product to trade, or None when it cannot be resolved or is unlisted.

        A given product has to match the owner's bot row when there is one; with
        no bot row it stands alone (the "ai" owner).
        """
        if product is None:
            if bot is None:
                return None
            product = bot["product"]
        elif bot is not None and product != bot["product"]:
            return None
        return product if product in self.limits.products else None

    def _is_stale(self, snap: MarketSnapshot) -> bool:
        """True when the snapshot is older than twice the poll interval."""
        return self.now() - snap.ts > STALE_WINDOWS * self.limits.poll_seconds

    def _check_size_and_caps(
        self,
        source: str,
        intent: OrderIntent,
        price: Decimal,
        spec: ProductSpec,
    ) -> Optional[str]:
        """TOO_SMALL, ORDER_TOO_LARGE, DAILY_CAP, RATE_CAP — in that order."""
        if money.too_small(intent.size, price, spec) is not None:
            return TOO_SMALL
        notional = intent.size * price
        order_cap = (
            self.limits.ai_max_order_usd
            if source == "ai"
            else self.limits.bot_max_order_usd
        )
        if notional > order_cap:
            return ORDER_TOO_LARGE
        if self.caps.daily_notional(None) + notional > self.limits.daily_notional_usd:
            return DAILY_CAP
        if source == "ai" and (
            self.caps.daily_notional("ai") + notional
            > self.limits.ai_daily_notional_usd
        ):
            return DAILY_CAP
        if self.caps.orders_last_hour(None) + 1 > self.limits.orders_per_hour:
            return RATE_CAP
        if source == "ai" and (
            self.caps.orders_last_hour("ai") + 1 > self.limits.ai_orders_per_hour
        ):
            return RATE_CAP
        return None

    def _check_funds(
        self,
        owner: str,
        product: str,
        intent: OrderIntent,
        price: Decimal,
    ) -> Optional[str]:
        """INSUFFICIENT_HOLDING, then UNALLOCATED_NEGATIVE for a buy."""
        holding = self.ledger.holding(owner, product)
        if intent.side == money.BUY:
            cost = money.buy_cost(intent.size, price, self.fee_rate)
            if cost > holding.available_quote:
                return INSUFFICIENT_HOLDING
            quote = product.split("-")[1]
            if self.ledger.unallocated(self.totals()).get(quote, D(0)) < 0:
                return UNALLOCATED_NEGATIVE
        elif intent.size > holding.available_base:
            return INSUFFICIENT_HOLDING
        return None

    def _check_drawdown(
        self,
        source: str,
        owner: str,
        product: str,
        snap: MarketSnapshot,
        bot: Optional[dict],
    ) -> Optional[str]:
        """DRAWDOWN_STOP for the owner (bots only), then for the whole portfolio.

        The owner's high-water mark is read here, never ratcheted: the runner
        moves it.
        """
        mid = (snap.bid + snap.ask) / 2
        if source == "bot":
            hwm = self.store.hwm(owner)
            if hwm is not None and hwm > 0:
                pct = D(str(_params(bot).get("drawdown_pct", DEFAULT_DRAWDOWN_PCT)))
                equity = self.ledger.equity(owner, {product: mid}, product)
                if equity < hwm * (1 - pct / 100):
                    return DRAWDOWN_STOP
        hwm = self.store.hwm(PORTFOLIO_OWNER)
        if hwm is not None and hwm > 0:
            floor = hwm * (1 - self.limits.portfolio_drawdown_pct / 100)
            if self.portfolio_equity() < floor:
                return DRAWDOWN_STOP
        return None

    # ------------------------------------------------ portfolio mark
    def portfolio_equity(self) -> Decimal:
        """Every bot's equity, marked at the snapshot mid of its own product.

        A bot whose product has no snapshot is valued at its quote balance only,
        which can only understate the portfolio: an unknown price never makes the
        drawdown stop looser.
        """
        total = D(0)
        for bot in self.store.list_bots():
            product = bot["product"]
            snap = self.snapshots.get(product)
            if snap is None:
                total += self.ledger.holding(bot["id"], product).quote
            else:
                mid = (snap.bid + snap.ask) / 2
                total += self.ledger.equity(bot["id"], {product: mid}, product)
        return total


# ---------------------------------------------------------------- defaults


def _never_halted() -> bool:
    """The halt flag when the caller wires none: never halted."""
    return False


def _always_dry(owner: str) -> str:
    """The route when the caller wires none: dry-run only."""
    return "dry"


def _params(bot: Optional[dict]) -> dict:
    """A bot row's params, or an empty mapping when there is no row."""
    return (bot or {}).get("params") or {}