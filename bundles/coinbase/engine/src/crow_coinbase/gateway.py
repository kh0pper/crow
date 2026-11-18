"""The order gateway: the read-only check chain, then the execution after it.

`OrderGateway.check()` answers one question — may this intent go out? — and stops
at the first refusal.  For a place intent the order is fixed:

    BAD_INTENT -> WRONG_OWNER -> HALTED -> LIVE_DISABLED -> PRODUCT_NOT_ALLOWED
    -> OWNER_PAUSED -> STALE_MARKET -> CLOCK_SKEW -> TOO_SMALL -> ORDER_TOO_LARGE
    -> DAILY_CAP -> RATE_CAP -> INSUFFICIENT_HOLDING -> UNALLOCATED_NEGATIVE
    -> DRAWDOWN_STOP

A cancel intent is answered by its shape (BAD_INTENT) and then by ownership
alone (NOT_OWNER): it skips every other check, so a halt or a spent budget never
blocks taking an order off the book.

`check()` is read-only: it writes no order row and never moves a high-water mark,
and it never calls the exchange.  Money and size are `Decimal` throughout (the
rounding, the fee-inclusive buy cost, the maker pricing and the minimums all come
from `money.py`); the only floats are a snapshot's timestamp and the measured
clock skew.  P1 is dry-run only, so a route that is not "dry" is refused while
`live_enabled` is false.

Execution sits beside the chain and runs under the cycle lock.  `submit()` runs
the same chain first (`_evaluate_place`) and refuses without touching the
exchange; past that it writes the order row BEFORE the exchange call, so a lost
answer can never leave an order the engine has no name for, and the row and the
send both carry the price that very chain measured.  A post-only rejection is
repriced one tick further from the market and retried under a fresh client order
id, up to `max_post_only_retries` times; each retry re-runs the whole chain on
its own read of the book and sends the price that read produced.  A transient
failure is looked up by client order id and re-sent under the same id only when
it did not land; a lookup that cannot answer leaves the row PENDING_SUBMIT,
which is also where three lost answers leave it, for the reconcile loop.  `cancel_all()` is the kill path:
it sweeps the open `cb-` orders off the exchange without going through `check()`,
so it works while halted.  `halt()` sets the in-memory flag before persisting it
and never waits for the cycle lock; `is_halted()` reads that flag, the persisted
marker (a restarted gateway on the same store is still halted) and the injected
callable.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Literal, Optional

from . import money
from .exchange import PermanentError, TransientError, new_client_order_id
from .ledger import Ledger
from .limits import CapWindow, Limits
from .money import ProductSpec
from .snapshot import SnapshotCache
from .store import (
    ACTIVE,
    OPEN,
    PENDING_SUBMIT,
    REJECTED,
    RESERVED_OWNERS,
    Store,
)
from .strategies.base import MarketSnapshot, OrderIntent

D = Decimal
log = logging.getLogger(__name__)

# ---------------------------------------------------------------- refusal codes
BAD_INTENT = "BAD_INTENT"  # malformed: wrong shape, missing or unusable numbers
WRONG_OWNER = "WRONG_OWNER"  # a source acting as an owner it cannot be
HALTED = "HALTED"  # the halt flag is set
LIVE_DISABLED = "LIVE_DISABLED"  # a live route while live trading is off
PRODUCT_NOT_ALLOWED = "PRODUCT_NOT_ALLOWED"  # unresolved, or outside the allow-list
OWNER_PAUSED = "OWNER_PAUSED"  # a bot source whose bot is not ACTIVE
STALE_MARKET = "STALE_MARKET"  # no snapshot, or an unusable or old one
CLOCK_SKEW = "CLOCK_SKEW"  # the skew is unknown or beyond the tolerance
TOO_SMALL = "TOO_SMALL"  # below the product's base or quote minimum
ORDER_TOO_LARGE = "ORDER_TOO_LARGE"  # over the per-source single-order cap
DAILY_CAP = "DAILY_CAP"  # over the global or the ai daily notional cap
RATE_CAP = "RATE_CAP"  # over the global or the ai rolling-hour order count
INSUFFICIENT_HOLDING = "INSUFFICIENT_HOLDING"  # the owner cannot fund the order
UNALLOCATED_NEGATIVE = "UNALLOCATED_NEGATIVE"  # the exchange is short of the owners
DRAWDOWN_STOP = "DRAWDOWN_STOP"  # the owner's or the portfolio's drawdown stop
NOT_OWNER = "NOT_OWNER"  # a cancel of an order this owner does not own

# ---------------------------------------------------------------- cancel/exec codes
NOT_CANCELLABLE = "NOT_CANCELLABLE"  # no live row to cancel yet, or one already done
CANCEL_FAILED = "CANCEL_FAILED"  # the exchange did not take the cancellation
EXCHANGE_REJECTED = "EXCHANGE_REJECTED"  # the exchange refused the order itself
POST_ONLY_EXHAUSTED = "POST_ONLY_EXHAUSTED"  # every post-only retry was refused

# The high-water mark key the portfolio drawdown stop reads and the runner
# ratchets with `portfolio_equity()`.  The leading underscore puts it outside the
# bot id grammar (`[a-z0-9]{1,16}`), so it can never name a bot.
PORTFOLIO_OWNER = "_portfolio"

# Owners a "bot" source may never act as: the reserved non-bot owners and the
# portfolio's own mark key.
NOT_BOT_OWNERS = frozenset(RESERVED_OWNERS) | {PORTFOLIO_OWNER}

# A snapshot is stale once it is older than this many poll windows.
STALE_WINDOWS = 2
# The most clock skew tolerated, in seconds (either direction).
MAX_CLOCK_SKEW_S = 5.0
# How far a snapshot's timestamp may run ahead of our clock, in seconds.
MAX_FUTURE_S = 5.0
# A bot's own drawdown stop when its params do not name a usable one (percent).
DEFAULT_DRAWDOWN_PCT = 20

# The one exchange status an adopted order may carry into the row: OPEN.
# Every other status (FILLED, CANCELLED, FAILED, anything unknown) records the
# order id alone and leaves the row PENDING_SUBMIT, so reconcile's pending path
# finds it and applies the fills; a terminal status written here would skip that.
ADOPTED_STATUSES = frozenset({OPEN})


@dataclass(frozen=True)
class GatewayResult:
    """The outcome of one submit: did it go out, as which cid, or why it did not."""

    ok: bool
    cid: Optional[str]
    refusal: Optional[str]


class OrderGateway:
    """The single gate every intent passes before it may reach the exchange.

    Constructed with its collaborators rather than reaching for them, so the
    check chain can be exercised against any store, clock and snapshot cache.
    `totals()` is the caller's cached exchange totals per currency.  The
    `CapWindow` is built by the caller on the same clock that stamps order rows;
    `now` here is only for snapshot staleness.  `self.lock` is the cycle lock:
    submit, cancel_all and seed_dry hold it, halt and clear_halt never do.
    `sleep` is the retry backoff, injectable so a caller need not wait.
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
        max_post_only_retries: int = 5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.store = store
        self.ledger = ledger
        self.limits = limits
        self.caps = caps
        self.snapshots = snapshots
        self.spec_for = spec_for
        self.fee_rate = D(fee_rate)
        self.totals = totals
        self.exchange = exchange  # submit/cancel_all/seed_dry only; check() never
        self._injected_halt = is_halted if is_halted is not None else _never_halted
        self.route_for = route_for if route_for is not None else _always_dry
        self.live_enabled = live_enabled
        self.now = now
        self.max_post_only_retries = int(max_post_only_retries)
        self.sleep = sleep
        self.lock = threading.RLock()
        self._halt_event = threading.Event()

    # ------------------------------------------------ the chain
    def check(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str] = None,
    ) -> Optional[str]:
        """Return the first refusal for *intent*, or None when it may go out.

        A place intent is answered by `_evaluate_place` and only its refusal is
        kept: the chain runs in the module docstring's order.  A cancel intent
        runs the shape check and then the ownership check alone.  `source` is
        "bot" or "ai", and it has to match the owner: "ai" only ever acts as the
        `ai` owner, "bot" only as a real bot.  `product` defaults to the owner's
        bot row product and must be given when the owner has no bot row ("ai").
        Reads store, caps, ledger and snapshots; calls no exchange method and
        writes nothing.
        """
        if intent.action == "cancel":
            if self._is_bad_cancel(intent):
                return BAD_INTENT
            return self._check_cancel(owner, intent)
        return self._evaluate_place(source, owner, intent, product)[0]

    def _evaluate_place(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str],
    ) -> tuple[
        Optional[str],
        Optional[str],
        Optional[MarketSnapshot],
        Optional[ProductSpec],
        Optional[Decimal],
    ]:
        """Run the whole place chain once and report what it measured.

        Returns `(refusal, product, snap, spec, price)`.  On a refusal only the
        first item is set and the rest are None.  On success `product` is the
        resolved product, `snap` the single snapshot the chain read, `spec` its
        spec and `price` the maker price every minimum, cap, funds and drawdown
        step was measured against: the caller sends that price rather than
        reading a fresher book of its own.  Read-only and exchange-free, exactly
        like `check()`.
        """
        if self._is_bad_place(intent):
            return BAD_INTENT, None, None, None, None
        bot = self.store.get_bot(owner)
        if not self._is_bound(source, owner, bot):
            return WRONG_OWNER, None, None, None, None
        if self.is_halted():
            return HALTED, None, None, None, None
        if self.route_for(owner) != "dry" and not self.live_enabled:
            return LIVE_DISABLED, None, None, None, None

        resolved = self._resolve_product(bot, product)
        if resolved is None:
            return PRODUCT_NOT_ALLOWED, None, None, None, None
        if source == "bot" and bot["status"] != ACTIVE:
            return OWNER_PAUSED, None, None, None, None

        snap = self.snapshots.get(resolved)
        if snap is None or self._is_unusable(snap):
            return STALE_MARKET, None, None, None, None
        skew = self.snapshots.skew_s()
        if skew is None or abs(skew) > MAX_CLOCK_SKEW_S:
            return CLOCK_SKEW, None, None, None, None

        spec = self.spec_for(resolved)
        price = money.maker_price(
            intent.side, intent.limit_price, snap.bid, snap.ask, spec.price_increment
        )
        refusal = self._check_size_and_caps(source, intent, price, spec)
        if refusal is not None:
            return refusal, None, None, None, None
        refusal = self._check_funds(owner, resolved, intent, price)
        if refusal is not None:
            return refusal, None, None, None, None
        refusal = self._check_drawdown(source, owner, resolved, snap, bot)
        if refusal is not None:
            return refusal, None, None, None, None
        return None, resolved, snap, spec, price

    # ------------------------------------------------ cancel
    def _check_cancel(self, owner: str, intent: OrderIntent) -> Optional[str]:
        """NOT_OWNER unless the id is shaped for *owner* and the row says so."""
        cid = intent.cancel_cid
        if not cid.startswith(f"cb-{owner}-"):
            return NOT_OWNER
        row = self.store.order(cid)
        if row is None or row["owner"] != owner:
            return NOT_OWNER
        return None

    # ------------------------------------------------ step helpers
    @staticmethod
    def _is_bad_place(intent: OrderIntent) -> bool:
        """True when the intent is not a well-formed place.

        A place needs a known side and a strictly positive, finite `Decimal` size
        and limit price, and it carries no cancellation id: a float, an int or a
        string is refused rather than coerced, because a price that quietly lost
        precision would slip past every cap and minimum downstream.
        """
        if intent.action != "place":
            return True
        if intent.side not in (money.BUY, money.SELL):
            return True
        if intent.cancel_cid is not None:
            return True
        if not _is_positive_decimal(intent.size):
            return True
        return not _is_positive_decimal(intent.limit_price)

    @staticmethod
    def _is_bad_cancel(intent: OrderIntent) -> bool:
        """True when the intent is not a bare cancellation.

        A cancel names one order id and nothing else: a side, a size or a price on
        it means the caller built a place intent by mistake, and an empty id could
        never match a row.
        """
        if intent.side is not None or intent.size is not None:
            return True
        if intent.limit_price is not None:
            return True
        cid = intent.cancel_cid
        return not isinstance(cid, str) or not cid

    @staticmethod
    def _is_bound(source: str, owner: str, bot: Optional[dict]) -> bool:
        """True when *source* and *owner* belong together.

        "ai" acts only as the `ai` owner.  "bot" acts only as a real bot: not one
        of the reserved non-bot owners, not the portfolio's own mark key, and the
        bot row has to exist.  An unknown source binds to nothing.
        """
        if source == "ai":
            return owner == "ai"
        if source == "bot":
            return bot is not None and owner not in NOT_BOT_OWNERS
        return False

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

    def _is_unusable(self, snap: MarketSnapshot) -> bool:
        """True when the snapshot cannot price an order.

        Unusable is: a bid at or below zero, an ask at or below the bid (an empty
        or crossed book, from which neither side of the spread can be trusted), a
        timestamp ahead of our clock by more than the tolerance, or one older than
        twice the poll interval.
        """
        now = self.now()
        if snap.bid <= 0 or snap.ask <= snap.bid:
            return True
        if snap.ts > now + MAX_FUTURE_S:
            return True
        return now - snap.ts > STALE_WINDOWS * self.limits.poll_seconds

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
        """INSUFFICIENT_HOLDING, then UNALLOCATED_NEGATIVE for the spent currency.

        A buy spends the product's quote currency and a sell spends its base, so
        the unallocated check looks at whichever of the two this order draws on: a
        short exchange is exactly the case where one owner's order would spend
        another owner's money.
        """
        base, quote = product.split("-", 1)
        holding = self.ledger.holding(owner, product)
        if intent.side == money.BUY:
            cost = money.buy_cost(intent.size, price, self.fee_rate)
            if cost > holding.available_quote:
                return INSUFFICIENT_HOLDING
            spent = quote
        else:
            if intent.size > holding.available_base:
                return INSUFFICIENT_HOLDING
            spent = base
        if self.ledger.unallocated(self.totals()).get(spent, D(0)) < 0:
            return UNALLOCATED_NEGATIVE
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
        moves it.  The portfolio half only runs when a portfolio mark exists, and
        an unknown portfolio valuation there refuses: a stop that cannot be
        measured must never step out of the way.
        """
        mid = (snap.bid + snap.ask) / 2
        if source == "bot":
            hwm = self.store.hwm(owner)
            if hwm is not None and hwm > 0:
                pct = _bot_drawdown_pct(bot)
                equity = self.ledger.equity(owner, {product: mid}, product)
                if equity < hwm * (1 - pct / 100):
                    return DRAWDOWN_STOP
        hwm = self.store.hwm(PORTFOLIO_OWNER)
        if hwm is not None and hwm > 0:
            equity = self.portfolio_equity()
            floor = hwm * (1 - self.limits.portfolio_drawdown_pct / 100)
            if equity is None or equity < floor:
                return DRAWDOWN_STOP
        return None

    # ------------------------------------------------ halt
    def halt(self, reason: str) -> None:
        """Stop the engine: set the flag first, then persist it; never wait for a cycle.

        The flag is set before the write so a submit that is already queued is
        refused even if persisting fails.  `self.lock` is deliberately not taken:
        a kill must never queue behind a cycle that is holding it.
        """
        self._halt_event.set()
        try:
            self.store.put("halted", {"reason": reason, "ts": time.time()})
        except Exception as error:  # noqa: BLE001 - the flag is already set
            log.error("halt: could not persist the flag: %s", error, exc_info=True)
            raise

    def clear_halt(self) -> None:
        """Lower the halt, in memory and in the store.  Takes no lock."""
        self._halt_event.clear()
        self.store.put("halted", None)

    def is_halted(self) -> bool:
        """True when the flag is set here, persisted by an earlier run, or injected."""
        if self._halt_event.is_set():
            return True
        if self.store.get("halted"):
            return True
        return bool(self._injected_halt())

    # ------------------------------------------------ execution
    def submit(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str] = None,
    ) -> GatewayResult:
        """Run one intent under the cycle lock: refuse it, or put it on the exchange."""
        with self.lock:
            if intent.action == "cancel":
                return self._submit_cancel(source, owner, intent, product)
            return self._submit_place(source, owner, intent, product)

    def _submit_place(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str],
    ) -> GatewayResult:
        """Place one post-only order, repricing and retrying a post-only refusal.

        Every attempt runs the whole chain through `_evaluate_place` and sends
        exactly the price that call returned, so one attempt reads the book once:
        the priced book is always the checked one.  The row is written with that
        price before every send, so the engine always has a name for an order
        whose answer was lost.  An unknown outcome (None from `_send`) leaves the
        row PENDING_SUBMIT and counts as accepted: the reconcile loop resolves it.
        An adopted order's row is settled by `_adopt` (OPEN only when the exchange
        says OPEN), so it is left as it is.  Each retry re-runs the chain at its own price, because
        a reprice moves a sell UP and can push the notional over a cap.
        """
        level = intent.level if intent.level is not None else 0
        attempt_intent = intent
        cid: Optional[str] = None
        for _attempt in range(self.max_post_only_retries + 1):
            refusal, resolved, _snap, spec, price = self._evaluate_place(
                source, owner, attempt_intent, product
            )
            if refusal is not None:
                return GatewayResult(False, None, refusal)
            cid = new_client_order_id(f"cb-{owner}-", intent.side, level)
            self.store.insert_order(
                cid,
                owner,
                source,
                resolved,
                intent.side,
                level,
                price,
                intent.size,
                consumes_fill=intent.consumes_fill,
            )
            res = self._send(cid, resolved, intent.side, intent.size, price)
            if res is None:
                return GatewayResult(True, cid, None)
            if res["ok"]:
                if not res.get("adopted"):
                    self.store.update_order(
                        cid, status=OPEN, order_id=res["order_id"]
                    )
                return GatewayResult(True, cid, None)
            reason = str(res.get("reason") or "")
            self.store.update_order(cid, status=REJECTED, note=reason)
            if "POST_ONLY" not in reason:
                return GatewayResult(False, cid, EXCHANGE_REJECTED)
            attempt_intent = replace(
                intent,
                limit_price=money.reprice_away(
                    intent.side, price, spec.price_increment
                ),
            )
        return GatewayResult(False, cid, POST_ONLY_EXHAUSTED)

    def _submit_cancel(
        self,
        source: str,
        owner: str,
        intent: OrderIntent,
        product: Optional[str],
    ) -> GatewayResult:
        """Cancel one order this owner holds; reconcile moves the row to CANCELLED."""
        cid = intent.cancel_cid
        refusal = self.check(source, owner, intent, product)
        if refusal is not None:
            return GatewayResult(False, None, refusal)
        row = self.store.order(cid)
        if (
            row is None
            or row["status"] not in (PENDING_SUBMIT, OPEN)
            or row["order_id"] is None
        ):
            return GatewayResult(False, cid, NOT_CANCELLABLE)
        order_id = row["order_id"]
        try:
            res = self.exchange.cancel([order_id])
        except (TransientError, PermanentError) as error:
            log.warning("cancel %s: %s", cid, error)
            return GatewayResult(False, cid, CANCEL_FAILED)
        if not (res or {}).get(order_id):
            return GatewayResult(False, cid, CANCEL_FAILED)
        self.store.update_order(cid, note="cancel requested")
        return GatewayResult(True, cid, None)

    def _send(
        self,
        cid: str,
        product: str,
        side: str,
        size: Decimal,
        price: Decimal,
    ) -> Optional[dict]:
        """Place ONE order, adopting it rather than re-placing it after a timeout.

        At most three place calls per cid.  A `PermanentError` from `place_limit`
        is the exchange refusing the order, so it is reported as a not-ok result
        (the caller records REJECTED).  After a transient failure the order is
        looked up by client order id: found means it landed (adopt its id and
        status, never send again); not found means the same cid is re-sent.  A
        lookup that fails transiently also counts as not found.  A lookup that
        fails permanently says nothing about the order — the answer was lost, so
        this returns None and the row stays PENDING_SUBMIT for reconcile.  Three
        lost answers return None too, an outcome nobody knows.
        """
        created = self.now()
        for attempt in range(3):
            try:
                return self.exchange.place_limit(cid, product, side, size, price)
            except PermanentError as error:
                log.warning("place %s refused: %s", cid, error)
                return {"ok": False, "order_id": None, "reason": str(error)}
            except TransientError as error:
                log.warning("place %s: %s; looking it up", cid, error)
                self.sleep(min(2**attempt, 10))
                try:
                    found = self._lookup(cid, created, product)
                except PermanentError as lookup_error:
                    log.warning(
                        "lookup %s failed (%s); the outcome is unknown",
                        cid,
                        lookup_error,
                    )
                    return None
                if found is not None:
                    return self._adopt(cid, found)
        return None

    def _lookup(self, cid: str, created: float, product: str) -> Optional[dict]:
        """The order the exchange holds for *cid*; a transient lookup counts as none."""
        try:
            return self.exchange.find_by_client_id(cid, created, product)
        except TransientError as error:
            log.warning("lookup %s: %s", cid, error)
            return None

    def _adopt(self, cid: str, found: dict) -> dict:
        """Record a found order: always its id, and its status only when it is OPEN.

        An OPEN order is written as OPEN.  Any other status the exchange reports
        (FILLED, CANCELLED, FAILED, unknown) records the order id alone and leaves
        the row PENDING_SUBMIT, because reconcile's pending path looks the row up
        and applies the fills: a terminal status written here would skip that.
        The result carries `adopted`, so the caller does not write the row again.
        """
        fields = {"order_id": found["order_id"]}
        if found.get("status") in ADOPTED_STATUSES:
            fields["status"] = found["status"]
        self.store.update_order(cid, **fields)
        return {
            "ok": True,
            "order_id": found["order_id"],
            "reason": None,
            "adopted": True,
        }

    # ------------------------------------------------ kill path
    def cancel_all(
        self, scope: Literal["owner", "all"], owner: Optional[str] = None
    ) -> int:
        """Sweep our open orders off the book; returns how many the exchange took.

        No `check()`: this is the kill path, so it works while halted and skips
        every cap, and it never touches an order whose id is not ours.  For
        scope "owner" the prefix ends at the dash, so "b1" does not sweep "cb-b10-".
        A failing list or cancel propagates; the caller decides what to do.
        """
        if scope not in ("owner", "all"):
            raise ValueError(f"unknown cancel scope: {scope!r}")
        if scope == "owner" and owner is None:
            raise ValueError("the owner scope needs an owner")
        prefix = "cb-" if scope == "all" else f"cb-{owner}-"
        with self.lock:
            open_orders = self.exchange.list_open_orders(None)
            selected = [
                order
                for order in open_orders
                if str(order.get("client_order_id") or "").startswith(prefix)
            ]
            if not selected:
                return 0
            order_ids = [order["order_id"] for order in selected]
            res = self.exchange.cancel(order_ids) or {}
            for order in selected:
                cid = order.get("client_order_id")
                if cid and self.store.order(cid) is not None:
                    self.store.update_order(cid, note="cancel requested")
            return sum(1 for order_id in order_ids if res.get(order_id))

    # ------------------------------------------------ dry seeding
    def seed_dry(self, owner: str, quote: Decimal, base: Decimal) -> None:
        """Fund a dry-run owner: the package's only `deposit` caller.

        Both deposits share one BEGIN IMMEDIATE transaction, and neither is made
        for an owner that is not on a dry route (or has no bot row to name the
        product), so a live account can never be funded from here.  A zero amount
        is skipped: the deposit itself refuses anything at or below zero.
        """
        with self.lock:
            if self.exchange is None:
                raise ValueError("no exchange to seed")
            if self.route_for(owner) != "dry":
                raise ValueError(f"owner {owner!r} is not on a dry route")
            bot = self.store.get_bot(owner)
            if bot is None:
                raise ValueError(f"no bot row for owner {owner!r}")
            quote_amt, base_amt = D(quote), D(base)
            if quote_amt < 0 or base_amt < 0:
                raise ValueError(f"a seed amount must not be negative: {owner!r}")
            base_cur, quote_cur = bot["product"].split("-", 1)
            note = f"seed {owner}"
            with self.store.tx():
                if quote_amt > 0:
                    self.exchange.deposit(quote_cur, quote_amt, note)
                if base_amt > 0:
                    self.exchange.deposit(base_cur, base_amt, note)

    # ------------------------------------------------ portfolio mark
    def portfolio_equity(self) -> Optional[Decimal]:
        """Every bot's equity at the snapshot mid of its own product, or None.

        None means at least one bot's product has no snapshot, or only an unusable
        one (stale, crossed, empty or stamped ahead of our clock): part of the
        portfolio is then unpriced, and a partial sum would let the drawdown stop
        read low enough to pass.  The caller treats None as unknown, not as zero.
        """
        total = D(0)
        for bot in self.store.list_bots():
            product = bot["product"]
            snap = self.snapshots.get(product)
            if snap is None or self._is_unusable(snap):
                return None
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


def _is_positive_decimal(value) -> bool:
    """True for a strictly positive, finite `Decimal` (and nothing else).

    Floats, ints and strings are refused rather than converted: a money value
    that arrives as a float has already lost precision, and `NaN` compares false
    against every bound, so it has to be excluded before any comparison.
    """
    if not isinstance(value, Decimal) or not value.is_finite():
        return False
    return value > 0


def _bot_drawdown_pct(bot: Optional[dict]) -> Decimal:
    """A bot's own drawdown stop, or the default when its params are unusable.

    The stored value has to be a finite `Decimal` strictly between 0 and 100: a
    stop of 0 would refuse every order and a stop over 100 could never trip, so
    both fall back to the default instead of silently changing the bot's risk.
    """
    raw = _params(bot).get("drawdown_pct", DEFAULT_DRAWDOWN_PCT)
    try:
        pct = D(str(raw))
    except (ArithmeticError, ValueError, TypeError):
        pct = None
    if pct is None or not pct.is_finite() or pct <= 0 or pct > 100:
        log.warning(
            "bot %s: unusable drawdown_pct %r, using the default %s%%",
            (bot or {}).get("id"),
            raw,
            DEFAULT_DRAWDOWN_PCT,
        )
        return D(DEFAULT_DRAWDOWN_PCT)
    return pct