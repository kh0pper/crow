"""The runner: one cycle of the engine, and the loop that repeats it.

`cycle()` runs the whole engine in the order the parked rules require, one
method per step, so the body reads as that order:

    1. poll every product any bot row names (under the gateway's cycle lock)
    2. step the dry-run exchange
    3. reconcile the store against the exchange
    4. re-check the portfolio and the per-bot drawdown stops
    5. one decision per ACTIVE bot, its orders through the gateway
    6. ratchet the high-water marks
    7. alert while the exchange is short of what its owners hold
    8. write the heartbeat, and return it

Reads the store, the snapshots and the strategy; writes only through the store
and the gateway.  It never calls an exchange write method: every order goes out
through `gateway.submit("bot", owner, intent)`, and the only kill paths it uses
are `gateway.cancel_all` and `gateway.halt`.  `snapshots.put` happens in step 1
alone, under `gateway.lock`, because the gateway's staleness and skew reads
assume no snapshot is written outside that lock.

Follow-ups are derived from the STORED rows and never from a reconcile report: a
terminal row that carries a fill and still says `opposite == OPP_TODO` is a fill
nobody answered, so a crash between the reconcile and the submit loses nothing.
`reconcile()` is always called outside a transaction of ours, with `now` on the
clock the rows were stamped with (epoch seconds), so a rollback can never reach
the trades file the reconcile wrote first.

A poll covers every product ANY bot row names, whatever that bot's status: the
gateway's `portfolio_equity()` marks all of them and answers None as soon as one
product cannot be priced, which would stop every order with DRAWDOWN_STOP.  While
that mark is unknown the portfolio neither halts nor ratchets.

Money and size are `Decimal`; the only floats are clocks and timestamps.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from . import money
from .benchmark import Benchmark
from .gateway import PORTFOLIO_OWNER, _bot_drawdown_pct
from .limits import Limits
from .money import ProductSpec
from .reconcile import reconcile
from .snapshot import SnapshotCache
from .store import (
    ACTIVE,
    CANCELLED,
    FAILED,
    FILLED,
    LIVE_STATUSES,
    OPEN,
    OPP_PLACED,
    OPP_SKIPPED,
    OPP_TODO,
    PAUSED,
    PENDING_SUBMIT,
    REJECTED,
    STOPPED,
    Store,
)
from .strategies.base import (
    BotView,
    Decision,
    MarketSnapshot,
    OrderIntent,
    Strategy,
)

D = Decimal
log = logging.getLogger("crow_coinbase.runner")

# ---------------------------------------------------------------- configuration
# The switch that would route orders to the real account: P1 refuses it.
ENV_LIVE = "CROW_COINBASE_LIVE"
LIVE_ON = ("true", "1", "yes", "on")
LIVE_OFF = ("false", "0", "no", "off", "")
LIVE_IN_P1 = "live trading lands in P2"

# One alert per negative-unallocated episode: the key holds the currency list.
UNALLOCATED_KEY = "runner:unallocated_alert"
UNALLOCATED_PREFIX = "unallocated negative: "

# A recenter settles the cancelled rows before it reinstates the grid.
RECENTER_SETTLE_TRIES = 10
RECENTER_SETTLE_WAIT_S = 1.0
RECENTER_NOTE = "recentered"

HEARTBEAT_TMP_SUFFIX = ".tmp"


class StartupRefused(ValueError):
    """An engine configuration that may not be started at all.

    Raised for a live key or a live mode in P1, and for an API key that could
    move funds or is not scoped to the one portfolio the engine trades.
    """


# ---------------------------------------------------------------- start-up checks


def check_key(perms: dict, portfolio_id: Optional[str]) -> None:
    """Refuse a live API key that could transfer out, or is not portfolio-scoped.

    A key that may transfer can move funds off the account, so nothing else it
    is allowed to do matters.  The engine also needs the key to belong to exactly
    one portfolio: an unscoped key, a blank target, or a mismatch between the two
    is refused rather than traded on.  Returns None for an acceptable key.
    """
    if perms.get("can_transfer"):
        raise StartupRefused(
            "API key has can_transfer permission; the engine never moves funds"
        )
    scoped = perms.get("portfolio_uuid")
    if not scoped:
        raise StartupRefused(
            "key is not scoped to a portfolio; create a portfolio-scoped key"
        )
    if not portfolio_id or not str(portfolio_id).strip():
        raise StartupRefused(
            f"no portfolio configured for a key scoped to {scoped}"
        )
    if scoped != portfolio_id:
        raise StartupRefused(
            f"key is scoped to portfolio {scoped}, not to {portfolio_id}"
        )


def live_fee_rate(env_fee_rate: Decimal, exchange: Any) -> Decimal:
    """The maker fee to use: the account's own rate when it is higher than ours.

    An exchange that cannot report a rate (dry run, or no fee tier yet) leaves
    the configured rate in place.  Never below the configured rate: a step sized
    against a too-cheap fee would trade at a loss.
    """
    configured = D(env_fee_rate)
    reported = exchange.maker_fee_rate()
    if reported is None:
        return configured
    return max(configured, D(reported))


def build_snapshot_cache(limits: Limits) -> SnapshotCache:
    """A cache whose staleness window matches the poll interval we actually run.

    The default 60-second poll would expire the measured skew between polls
    whenever an install polls slower than that, so the interval is passed in.
    """
    return SnapshotCache(poll_seconds=limits.poll_seconds, now=time.time)


def realized_pnl(store: Store, owner: Optional[str] = None) -> dict[str, Decimal]:
    """Realized profit per owner, derived from the order rows already stored.

    A sell contributes once its fill is settled: a FILLED row, or a CANCELLED one
    that still carries a filled part.  Its basis is the cost of the base it sold,
    so a row without one (an adopted order, a sell placed on no known basis) is
    skipped rather than counted at zero cost.  Only owners with such a row
    appear in the result; no table is written.
    """
    totals: dict[str, Decimal] = {}
    for row in store.orders(owner=owner):
        if row["side"] != money.SELL:
            continue
        basis = row["basis_per_base"]
        if basis is None:
            continue
        filled = row["filled_size"]
        if filled <= 0:
            continue
        settled = row["status"] == FILLED or (
            row["status"] == CANCELLED and filled > 0
        )
        if not settled:
            continue
        gain = money.realized_on_sell(
            filled, row["filled_value"] - row["fees"], basis
        )
        totals[row["owner"]] = totals.get(row["owner"], D(0)) + gain
    return totals


# ---------------------------------------------------------------- the runner


class Runner:
    """The cycle loop: poll, reconcile, decide, mark, and write the heartbeat.

    Every collaborator is injected — the store, the gateway, the exchange, the
    snapshot cache, the strategies and the clocks — so a cycle can be driven
    against a scripted book with nothing mocked inside the engine.  `now` is an
    epoch-seconds clock (the one `created_at` is stamped with), `market_for` gives
    a product's book and poll range, and `spec_for` its `ProductSpec`.
    """

    def __init__(
        self,
        *,
        store: Store,
        gateway: Any,
        exchange: Any,
        snapshots: SnapshotCache,
        strategies: Mapping[str, Strategy],
        env: Mapping[str, str],
        market_for: Callable[[str], Any],
        spec_for: Callable[[str], ProductSpec],
        now: Callable[[], float] = time.time,
        heartbeat_path: Path | str = "/data/heartbeat",
        benchmark: Optional[Benchmark] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.store = store
        self.gateway = gateway
        self.exchange = exchange
        self.snapshots = snapshots
        self.strategies = strategies
        self.env = env
        self.market_for = market_for
        self.spec_for = spec_for
        self.now = now
        self.heartbeat_path = Path(heartbeat_path)
        self.sleep = sleep
        self.benchmark = benchmark if benchmark is not None else Benchmark(store)

        self.limits = Limits.from_env(env)
        self.fee_rate = self.limits.maker_fee_pct / 100
        self.ledger = gateway.ledger

        self.cycle_count = 0
        # The last successful poll per product: the start of the next range read.
        self._last_poll: dict[str, float] = {}

    # ------------------------------------------------ start-up
    def startup_checks(self) -> list[str]:
        """Every configuration problem that blocks a start; an empty list is fine.

        Two families: a live route (which P1 refuses outright, in the environment
        and in the gateway), and one pass per bot over its strategy — its name,
        then `validate` against the product's real `ProductSpec`, then the fee
        guard.  Passing the spec to `validate` is what refuses a step that
        collapses on the product's price tick before a single order is built, and
        a STOPPED bot is left alone: it places nothing.
        """
        problems = self._live_problems()
        for bot in self.store.list_bots():
            if bot["status"] == STOPPED:
                continue
            problems.extend(self._bot_problems(bot))
        return problems

    def _live_problems(self) -> list[str]:
        """A problem for a live switch this build cannot honour, in either place."""
        problems: list[str] = []
        value = str(self.env.get(ENV_LIVE) or "").strip().lower()
        if value in LIVE_ON:
            problems.append(f"{ENV_LIVE}={value}: {LIVE_IN_P1}")
        elif value not in LIVE_OFF:
            problems.append(f"unrecognised {ENV_LIVE} value {value!r}")
        if self.gateway.live_enabled:
            problems.append(f"{LIVE_IN_P1}; the gateway was built live-enabled")
        return problems

    def _bot_problems(self, bot: dict) -> list[str]:
        """Every problem with one bot's strategy, each prefixed with the bot id."""
        prefix = f"bot {bot['id']}: "
        strategy = self.strategies.get(bot["strategy"])
        if strategy is None:
            return [prefix + f"unknown strategy {bot['strategy']!r}"]
        try:
            spec = self.spec_for(bot["product"])
        except Exception as error:  # noqa: BLE001 - any failure means no spec
            return [prefix + f"no product spec: {error}"]
        try:
            strategy.validate(bot["params"], spec)
            why = strategy.fee_guard(bot["params"], self.limits.maker_fee_pct)
        except ValueError as error:
            return [prefix + str(error)]
        return [prefix + why] if why else []

    # ------------------------------------------------ one cycle
    def cycle(self) -> dict:
        """Run every step once, under the gateway's cycle lock, and heartbeat."""
        with self.gateway.lock:
            self.cycle_count += 1
            self._poll_markets()  # 1
            self.exchange.advance(self.now())  # 2
            reconcile(  # 3
                self.store,
                self.exchange,
                now=self.now(),
                gateway=self.gateway,
            )
            self._check_drawdowns()  # 4
            if not self.gateway.is_halted():  # 5
                self._run_bots()
            self._ratchet_marks()  # 6
            self._check_unallocated()  # 7
            return self._heartbeat()  # 8

    # ------------------------------------------------ step 1: the book
    def _poll_markets(self) -> None:
        """Poll every product a bot row names, then measure the clock skew.

        A product is polled once however many bots share it, and a failing poll
        keeps that product's previous snapshot: an unpriceable product is
        reported, never filled in with an invented book.
        """
        for product in self._polled_products():
            self._poll_product(product)
        self._measure_clock()

    def _polled_products(self) -> list[str]:
        """Each distinct product of every bot row, whatever that bot's status."""
        products: list[str] = []
        for bot in self.store.list_bots():
            if bot["product"] not in products:
                products.append(bot["product"])
        return products

    def _poll_product(self, product: str) -> None:
        """Read one product's top of book and poll range into the snapshot cache.

        The range starts at this product's own last successful read, so a window
        is never counted twice; the first read looks back one full poll interval.
        """
        now = self.now()
        since = self._last_poll.get(product, now - self.limits.poll_seconds)
        try:
            market = self.market_for(product)
            bid, ask = market.best_bid_ask()
            low, high = market.range_since(since)
        except Exception as error:  # noqa: BLE001 - one product may not stop the rest
            log.warning("poll %s: %s", product, error)
            self.store.event("warn", f"poll {product} failed: {error}")
            return
        self.snapshots.put(
            MarketSnapshot(product, bid, ask, low, high, self.now())
        )
        self._last_poll[product] = self.now()

    def _measure_clock(self) -> None:
        """Store the skew between the exchange's clock and ours."""
        try:
            server = self.exchange.server_time()
        except Exception as error:  # noqa: BLE001 - the skew stays unknown
            log.warning("server time: %s", error)
            self.store.event("warn", f"server time unavailable: {error}")
            return
        self.snapshots.set_clock(server, self.now())

    # ------------------------------------------------ step 4: drawdown stops
    def _check_drawdowns(self) -> None:
        """The portfolio stop first, then each ACTIVE bot's own stop.

        An unknown portfolio mark (None: a product that cannot be priced) moves
        nothing: it neither halts nor ratchets, so a missing snapshot can never
        look like a drawdown.  A stop that has already fired does not fire again,
        which keeps one episode to one alert.
        """
        self._check_portfolio_drawdown()
        self._check_bot_drawdowns()

    def _check_portfolio_drawdown(self) -> None:
        """Halt the whole engine when the portfolio mark is below its stop."""
        equity = self.gateway.portfolio_equity()
        if equity is None:
            return
        hwm = self.store.hwm(PORTFOLIO_OWNER)
        if hwm is None or hwm <= 0:
            return
        pct = self.limits.portfolio_drawdown_pct
        floor = hwm * (1 - pct / 100)
        if equity >= floor or self.gateway.is_halted():
            return
        message = (
            f"portfolio drawdown: equity {equity} below {floor} "
            f"({pct}% of high-water mark {hwm})"
        )
        log.error(message)
        self.gateway.halt(message)
        self.store.event("ALERT", message)

    def _check_bot_drawdowns(self) -> None:
        """Pause each ACTIVE bot whose equity is below its own drawdown stop."""
        for bot in self.store.list_bots():
            if bot["status"] != ACTIVE:
                continue
            mid = self._mid(bot["product"])
            if mid is None:
                continue
            hwm = self.store.hwm(bot["id"])
            if hwm is None or hwm <= 0:
                continue
            product = bot["product"]
            equity = self.ledger.equity(bot["id"], {product: mid}, product)
            pct = _bot_drawdown_pct(bot)
            floor = hwm * (1 - pct / 100)
            if equity >= floor:
                continue
            self.store.set_bot_status(bot["id"], PAUSED)
            message = (
                f"bot {bot['id']} paused: drawdown equity {equity} below "
                f"{floor} ({pct}% of high-water mark {hwm})"
            )
            log.error(message)
            self.store.event("ALERT", message)

    def _mid(self, product: str) -> Optional[D]:
        """The product's mid price from its snapshot, or None with no snapshot."""
        snap = self.snapshots.get(product)
        if snap is None:
            return None
        return (snap.bid + snap.ask) / 2

    # ------------------------------------------------ step 5: the bots
    def _run_bots(self) -> None:
        """Give each bot its turn, so one bot's failure cannot stop the others."""
        for row in self.store.list_bots():
            try:
                self._process_bot(row["id"])
            except Exception as error:  # noqa: BLE001 - isolate one bot's failure
                log.exception("bot %s failed in cycle %s", row["id"], self.cycle_count)
                self.store.event(
                    "error", f"bot {row['id']}: cycle failed: {error}"
                )

    def _process_bot(self, bot_id: str) -> None:
        """One bot's turn: heal, read, decide, send, then record what it decided.

        The row is read again here, because step 4 may have paused it since the
        list was taken: a PAUSED or STOPPED bot gets no strategy call and no
        order, while the reconcile, the poll and the marks still cover it.
        """
        bot = self.store.get_bot(bot_id)
        if bot is None or bot["status"] != ACTIVE:
            return
        product = bot["product"]
        strategy = self.strategies.get(bot["strategy"])
        if strategy is None:
            self.store.event(
                "warn", f"bot {bot_id}: unknown strategy {bot['strategy']!r}"
            )
            return
        snap = self.snapshots.get(product)
        if snap is None:
            self.store.event("warn", f"bot {bot_id}: no snapshot for {product}")
            return

        self._heal(bot_id)
        holding = self.ledger.holding(bot_id, product)
        view = BotView(
            bot_id=bot_id,
            product=product,
            params=bot["params"],
            state=bot["state"],
            holding=holding,
            open_orders=self.store.orders(owner=bot_id, statuses=LIVE_STATUSES),
            pending_fills=self._pending_fills(bot_id),
            fee_rate=self.fee_rate,
            spec=self.spec_for(product),
            now=self.now(),
        )
        self.benchmark.start(
            bot_id,
            base=holding.base,
            quote=holding.quote,
            price=(snap.bid + snap.ask) / 2,
        )

        init = not bot["init_done"]
        decision = self._decision(bot, strategy, snap, view, init=init)
        self._submit_decision(bot, decision, product, init=init)
        if init and decision.pause_reason is None:
            self.store.set_init_done(bot_id)
        self._merge_state(bot, decision.state_update)
        if decision.pause_reason:
            self.store.set_bot_status(bot_id, PAUSED)
            self.store.event(
                "warn", f"bot {bot_id} paused: {decision.pause_reason}"
            )

    def _decision(
        self,
        bot: dict,
        strategy: Strategy,
        snap: MarketSnapshot,
        view: BotView,
        *,
        init: bool,
    ) -> Decision:
        """The first book once per bot, otherwise one tick's answer.

        While `init_done` is 0 the first book may already be partly on the book
        (a crash mid-init), so a place intent for a (side, level) that has a
        pending, resting or filled row is dropped: re-placing it would double a
        level.  Rows retired by a recenter are ignored: they belong to the old
        grid, whose levels say nothing about the new one.
        """
        if not init:
            return strategy.decide(snap, view)
        decision = strategy.init_intents(snap, view)
        return replace(
            decision,
            intents=self._without_placed_levels(bot["id"], decision.intents),
        )

    def _without_placed_levels(
        self, bot_id: str, intents: list[OrderIntent]
    ) -> list[OrderIntent]:
        """*intents* without a place whose level this bot already holds.

        A row retired by a recenter (`note` `recentered`) is left out: it
        belongs to the grid that was replaced, so its level is free again on
        the new one.
        """
        taken = {
            (row["side"], row["level"])
            for row in self.store.orders(
                owner=bot_id, statuses=(PENDING_SUBMIT, OPEN, FILLED)
            )
            if row.get("note") != RECENTER_NOTE
        }
        kept: list[OrderIntent] = []
        for intent in intents:
            if intent.action == "place" and (intent.side, intent.level) in taken:
                log.warning(
                    "bot %s: init level %s %s is already on the book; not placed "
                    "twice",
                    bot_id,
                    intent.side,
                    intent.level,
                )
                continue
            kept.append(intent)
        return kept

    def _merge_state(self, bot: dict, state_update: Optional[dict]) -> None:
        """Fold a decision's state into the bot's own, key by key."""
        if state_update is None:
            return
        self.store.set_bot_state(
            bot["id"], {**(bot["state"] or {}), **state_update}
        )

    # ------------------------------------------------ step 5a: repairs
    def _heal(self, bot_id: str) -> None:
        """Repair the bookkeeping a crash between an accepted order and its mark left.

        A row that names the fill it answers is the record of an accepted
        follow-up, so the fill's own annotations (parent id, cost basis) are
        written from it and the fill is retired when it is still pending.  This
        runs before the view is built, so the next decision cannot place the
        same follow-up a second time.
        """
        for row in self.store.orders(owner=bot_id):
            fill_cid = row["consumes_fill"]
            if not fill_cid:
                continue
            parent = self.store.order(fill_cid)
            fields: dict[str, Any] = {}
            if row["parent_cid"] is None:
                fields["parent_cid"] = fill_cid
            if (
                parent is not None
                and row["side"] == money.SELL
                and row["basis_per_base"] is None
            ):
                basis = self._basis_of(parent)
                if basis is not None:
                    fields["basis_per_base"] = basis
            if fields:
                self.store.update_order(row["client_order_id"], **fields)
            if parent is None:
                continue
            if parent["opposite"] == OPP_TODO and row["status"] not in (
                REJECTED,
                FAILED,
            ):
                self._retire_fill(fill_cid)

    # ------------------------------------------------ step 5b: pending fills
    def _pending_fills(self, bot_id: str) -> list[dict]:
        """The fills still waiting for their opposite order, oldest first.

        Read from the stored rows, not from a reconcile report: a fill that was
        settled by a cycle which then died is still here.  The order is the
        legacy one — by `updated_at`, which is when the row settled, not when it
        was written — and a row with no client order id is warned about and
        passed on anyway (a strategy can only ignore it).
        """
        rows = [
            row
            for row in self.store.orders(
                owner=bot_id, statuses=(FILLED, CANCELLED)
            )
            if row["filled_size"] > 0 and row["opposite"] == OPP_TODO
        ]
        rows.sort(
            key=lambda row: (
                _stamp(row["updated_at"]),
                row["client_order_id"] or "",
            )
        )
        for row in rows:
            if not row["client_order_id"]:
                message = (
                    f"bot {bot_id}: pending fill row with no client_order_id "
                    f"(order_id {row.get('order_id')}); it cannot be answered"
                )
                log.warning(message)
                self.store.event("warn", message)
        return rows

    # ------------------------------------------------ step 5f: sending
    def _submit_decision(
        self, bot: dict, decision: Decision, product: str, *, init: bool
    ) -> None:
        """Send one decision: the cancels first, then the places.

        A cancel that does not go through holds back every place in the same
        decision (the order it names may have just filled, and a follow-up
        placed on that guess would double the position).  Held-back fills stay
        `OPP_TODO` and are retried on a later cycle; fills the strategy itself
        skipped are retired either way.
        """
        bot_id = bot["id"]
        cancels = [i for i in decision.intents if i.action == "cancel"]
        places = [i for i in decision.intents if i.action != "cancel"]
        cancel_failed = False
        for intent in cancels:
            result = self.gateway.submit("bot", bot_id, intent, product)
            if result.ok:
                continue
            cancel_failed = True
            message = (
                f"bot {bot_id}: cancel {intent.cancel_cid} failed: "
                f"{result.refusal}; held back {len(places)} place intent(s)"
            )
            log.warning(message)
            self.store.event("warn", message)
        if not cancel_failed:
            for intent in places:
                self._place(bot, intent, product, init=init)
        self._skip_fills(decision.skipped_fills)

    def _place(
        self, bot: dict, intent: OrderIntent, product: str, *, init: bool
    ) -> None:
        """Send one place intent through the gateway and record the answer.

        A refusal is a warning and nothing else: the fill it would have answered
        stays pending, so the order is retried rather than lost.  An acceptance
        retires the fill it consumes and takes the annotations the gateway has no
        parameter for.
        """
        bot_id = bot["id"]
        result = self.gateway.submit("bot", bot_id, intent, product)
        if not result.ok:
            if init:
                message = (
                    f"bot {bot_id}: init refused {result.refusal} "
                    f"for level {intent.level}"
                )
            else:
                message = (
                    f"bot {bot_id}: place refused {result.refusal} "
                    f"(level {intent.level}, fill {intent.consumes_fill or '-'}); "
                    "the fill stays pending"
                )
            log.warning(message)
            self.store.event("warn", message)
            return
        if result.cid:
            self._annotate(bot, intent, result.cid)
        if intent.consumes_fill:
            self._retire_fill(intent.consumes_fill)

    def _annotate(self, bot: dict, intent: OrderIntent, cid: str) -> None:
        """Write the parent id and the cost basis the gateway cannot take.

        A follow-up names the fill it answers, and a follow-up sell carries that
        fill's own cost per unit, so its profit is measurable once it trades.  An
        initial sell is marked at the grid's center, which is where its own
        profit starts; a buy has no basis to mark at all.
        """
        if intent.consumes_fill:
            self.store.update_order(
                cid,
                parent_cid=intent.consumes_fill,
                basis_per_base=self._parent_basis(intent),
            )
            return
        self.store.update_order(cid, basis_per_base=self._init_basis(bot, intent))

    def _parent_basis(self, intent: OrderIntent) -> Optional[D]:
        """The cost per unit of the parent fill, for a follow-up sell."""
        if intent.side != money.SELL or not intent.consumes_fill:
            return None
        parent = self.store.order(intent.consumes_fill)
        if parent is None:
            return None
        return self._basis_of(parent)

    def _basis_of(self, parent: dict) -> Optional[D]:
        """What one unit of a filled buy cost, its fee included."""
        if parent["filled_size"] <= 0:
            return None
        return (parent["filled_value"] + parent["fees"]) / parent["filled_size"]

    def _init_basis(self, bot: dict, intent: OrderIntent) -> Optional[D]:
        """An initial sell's basis: the configured center, when it has one."""
        if intent.side != money.SELL:
            return None
        try:
            return D(str((bot["params"] or {}).get("center")))
        except (ArithmeticError, ValueError, TypeError):
            return None

    def _retire_fill(self, cid: str) -> None:
        """Mark a fill answered, once, by whatever answered it."""
        row = self.store.order(cid)
        if row is None or row["opposite"] != OPP_TODO:
            return
        self.store.update_order(cid, opposite=OPP_PLACED)

    def _skip_fills(self, cids: list[str]) -> None:
        """Retire the fills the strategy itself decided to leave unanswered."""
        for cid in cids:
            if not isinstance(cid, str) or not cid:
                continue
            row = self.store.order(cid)
            if row is None or row["opposite"] != OPP_TODO:
                continue
            self.store.update_order(cid, opposite=OPP_SKIPPED)

    # ------------------------------------------------ step 6: marks
    def _ratchet_marks(self) -> None:
        """Move each bot's and the portfolio's high-water mark up to today's value.

        Only upwards: `update_hwm` keeps the larger of the two.  A STOPPED bot
        keeps its mark as it is, and an unknown portfolio mark is skipped rather
        than ratcheted from a partial sum.
        """
        for bot in self.store.list_bots():
            if bot["status"] == STOPPED:
                continue
            mid = self._mid(bot["product"])
            if mid is None:
                continue
            product = bot["product"]
            self.store.update_hwm(
                bot["id"], self.ledger.equity(bot["id"], {product: mid}, product)
            )
        equity = self.gateway.portfolio_equity()
        if equity is not None:
            self.store.update_hwm(PORTFOLIO_OWNER, equity)

    # ------------------------------------------------ step 7: the exchange total
    def _check_unallocated(self) -> None:
        """Alert while the exchange holds less than its owners are owed.

        Nothing here is traded away: a buy is already refused by the gateway with
        UNALLOCATED_NEGATIVE while a currency is short, and selling to rebalance
        the shortfall would spend one owner's money on another's.  One alert per
        episode: the kv key holds the sorted list of short currencies, so a new
        alert is written only when that list changes, and the key is cleared when
        nothing is short.
        """
        short = sorted(
            currency
            for currency, value in self.ledger.unallocated(
                self.exchange.totals()
            ).items()
            if value < 0
        )
        if not short:
            if self.store.get(UNALLOCATED_KEY) is not None:
                self.store.put(UNALLOCATED_KEY, None)
            return
        if self.store.get(UNALLOCATED_KEY) == short:
            return
        message = UNALLOCATED_PREFIX + ", ".join(short)
        log.error(message)
        self.store.event("ALERT", message)
        self.store.put(UNALLOCATED_KEY, short)

    # ------------------------------------------------ step 8: heartbeat
    def _heartbeat(self) -> dict:
        """Write the heartbeat atomically and return the same payload.

        Written only by a cycle that reached this step: an exception earlier
        leaves the previous file in place, so the heartbeat's age is the honest
        measure of how long the engine has been failing.
        """
        payload = {
            "ts": self.now(),
            "cycle": self.cycle_count,
            "bots_active": sum(
                1
                for bot in self.store.list_bots()
                if bot["status"] == ACTIVE
            ),
        }
        path = self.heartbeat_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + HEARTBEAT_TMP_SUFFIX)
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, path)
        return payload

    # ------------------------------------------------ recenter
    def recenter(self, bot_id: str, new_center: Any) -> None:
        """Move a grid bot's center, then reinstate its book around the new one.

        The new params are built and put through the strategy's own checks BEFORE
        anything is touched, so a center that cannot build a grid changes nothing
        at all.  Then, in order:
        the bot is paused (no cycle may place while the book is in pieces), its
        orders are swept off the exchange, reconcile is run until none of its
        rows is live, every fill still pending is retired as `recentered` (an old
        fill must never be answered on the new grid), and the params, `init_done`
        and status are written together so the next cycle lays the new book.
        """
        with self.gateway.lock:
            bot = self.store.get_bot(bot_id)
            if bot is None:
                raise ValueError(f"no bot {bot_id!r}")
            strategy = self.strategies.get(bot["strategy"])
            if strategy is None:
                raise ValueError(
                    f"bot {bot_id}: unknown strategy {bot['strategy']!r}"
                )
            if bot["status"] == STOPPED:
                raise ValueError(f"bot {bot_id} is stopped; start it to recenter")
            recenter = _recenter_of(strategy, bot)
            new_params = self._recentered_params(
                bot, strategy, recenter, new_center
            )

            self.store.set_bot_status(bot_id, PAUSED)
            self.gateway.cancel_all(scope="owner", owner=bot_id)
            self._settle_recenter(bot_id)
            self._retire_pending_fills(bot_id)
            self._write_recentered(bot_id, new_params, new_center)

    def _recentered_params(
        self,
        bot: dict,
        strategy: Strategy,
        recenter: Callable[[dict, D], dict],
        new_center: Any,
    ) -> dict:
        """The params centered on *new_center*, validated against the product.

        Both the parse and the strategy's own checks raise `ValueError`, so a
        caller sees one error type for "that center cannot drive this grid".
        """
        try:
            center = D(str(new_center))
        except (ArithmeticError, ValueError, TypeError):
            raise ValueError(
                f"center must be a number, got {new_center!r}"
            ) from None
        if not center.is_finite():
            raise ValueError(
                f"center must be a finite number, got {new_center!r}"
            )
        try:
            new_params = recenter(bot["params"], center)
            strategy.validate(new_params, self.spec_for(bot["product"]))
        except (ArithmeticError, ValueError, TypeError) as error:
            raise ValueError(str(error)) from None
        return new_params

    def _settle_recenter(self, bot_id: str) -> None:
        """Reconcile until none of the bot's rows is live, or give up.

        The cancelled rows settle from the exchange on a later reconcile, so the
        loop reads the book back instead of assuming the sweep took effect.
        """
        for attempt in range(RECENTER_SETTLE_TRIES):
            reconcile(
                self.store,
                self.exchange,
                now=self.now(),
                gateway=self.gateway,
            )
            if not self.store.orders(owner=bot_id, statuses=LIVE_STATUSES):
                return
            if attempt < RECENTER_SETTLE_TRIES - 1:
                self.sleep(RECENTER_SETTLE_WAIT_S)
        raise RuntimeError("recenter aborted: orders still live")

    def _retire_pending_fills(self, bot_id: str) -> None:
        """Retire every fill still waiting for an opposite, as `recentered`."""
        for row in self.store.orders(owner=bot_id):
            if row["opposite"] != OPP_TODO:
                continue
            self.store.update_order(
                row["client_order_id"],
                opposite=OPP_SKIPPED,
                note=RECENTER_NOTE,
            )

    def _write_recentered(
        self, bot_id: str, new_params: dict, new_center: Any
    ) -> None:
        """Write the new params and re-arm the first book, in one transaction."""
        with self.store.tx() as db:
            db.execute(
                "UPDATE bots SET params_json=?, init_done=0, status=? WHERE id=?",
                (json.dumps(new_params), ACTIVE, bot_id),
            )
        message = f"bot {bot_id}: recentered on {new_center}; the book re-inits"
        log.info(message)
        self.store.event("info", message)

    # ------------------------------------------------ benchmark bookkeeping
    def forget_benchmark(self, bot_id: str) -> None:
        """Drop a bot's benchmark baseline so a later start takes a fresh one.

        Needed when a bot is deleted: the kv key outlives the bot row, and a new
        bot reusing the id would otherwise inherit the old shadow.
        """
        self.store.put(f"benchmark:{bot_id}", None)

    # ------------------------------------------------ the loop
    def run_forever(
        self,
        poll_seconds: Optional[float] = None,
        stop: Optional[threading.Event] = None,
    ) -> None:
        """Cycle until *stop* is set, surviving any single cycle's failure.

        A failed cycle is logged and recorded, then the loop waits and tries
        again: the heartbeat it did not write is what tells the watchdog (and the
        healthcheck) that the engine is not getting through.
        """
        poll = self.limits.poll_seconds if poll_seconds is None else poll_seconds
        event = stop if stop is not None else threading.Event()
        while not event.is_set():
            try:
                self.cycle()
            except Exception as error:  # noqa: BLE001 - the loop must survive
                log.exception("cycle %s failed", self.cycle_count)
                self.store.event(
                    "error", f"cycle {self.cycle_count} failed: {error}"
                )
            event.wait(poll)


# ---------------------------------------------------------------- helpers


def _recenter_of(strategy: Strategy, bot: dict) -> Callable[[dict, D], dict]:
    """A strategy's recenter step, or `ValueError` when it has none.

    Only a level grid has a center to move, so a rebalancer is refused here
    rather than half-recentered.
    """
    try:
        return strategy.recenter
    except AttributeError:
        raise ValueError(
            f"bot {bot['id']}: strategy {bot['strategy']!r} has no center"
        ) from None


def _stamp(value: Any) -> float:
    """A stored timestamp as a float; an absent or unusable one is zero."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0