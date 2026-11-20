"""runner.py: the cycle loop, driven against real objects and a scripted book.

Nothing here mocks the engine's own parts: a real `Store` on a temporary file, the
real `DryRunExchange` over that store's connection, the real `OrderGateway`, the
real `Limits`/`CapWindow`/`SnapshotCache` and the real `GridStrategy` /
`RebalanceStrategy`.  Only the outside world is faked: `FakeMarket` answers the
book, the poll range and the candle window the dry-run exchange fills from.

A fill is one appended candle whose low is below a resting buy's price (or whose
high is above a resting sell's) and which starts after that order was placed —
`DryRunExchange.advance` ignores a candle that began before the order did.
Nothing sleeps on the wall clock (`sleep` only records) and nothing opens a
socket.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from decimal import Decimal as D
from pathlib import Path

import pytest

from crow_coinbase import money, runner as runner_module
from crow_coinbase.benchmark import Benchmark
from crow_coinbase.exchange import DryRunExchange
from crow_coinbase.gateway import (
    CLOCK_SKEW,
    DAILY_CAP,
    DRAWDOWN_STOP,
    HALTED,
    INSUFFICIENT_HOLDING,
    PORTFOLIO_OWNER,
    RATE_CAP,
    STALE_MARKET,
    UNALLOCATED_NEGATIVE,
    GatewayResult,
    OrderGateway,
)
from crow_coinbase.ledger import Ledger
from crow_coinbase.limits import CapWindow, Limits
from crow_coinbase.money import ProductSpec
from crow_coinbase.reconcile import reconcile
from crow_coinbase.runner import (
    Runner,
    StartupRefused,
    build_snapshot_cache,
    check_key,
    live_fee_rate,
    realized_pnl,
)
from crow_coinbase.store import (
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
from crow_coinbase.strategies.base import Decision, MarketSnapshot, OrderIntent
from crow_coinbase.strategies.grid import GridStrategy
from crow_coinbase.strategies.rebalance import RebalanceStrategy

SRC = Path(__file__).resolve().parents[1] / "src" / "crow_coinbase"

BOT = "b1"
PRODUCT = "XRP-USDC"
QUOTE = "USDC"
SECOND_PRODUCT = "BTC-USDC"

SPEC = ProductSpec(
    PRODUCT,
    price_increment=D("0.0001"),
    base_increment=D("0.1"),
    quote_increment=D("0.01"),
    base_min_size=D("1"),
    quote_min_size=D("1"),
)

FEE_RATE = D("0.005")

BASE_ENV = {
    "CROW_COINBASE_MAKER_FEE_PCT": "0.5",
    "CROW_COINBASE_PRODUCTS": "XRP-USDC,BTC-USDC",
}

GRID_PARAMS = {
    "center": "1.0",
    "step_pct": "1.5",
    "levels_below": 3,
    "levels_above": 3,
    "quote_per_buy": "10",
    "rebuy_sizing": "proceeds",
}

REBALANCE_PARAMS = {
    "target_base_pct": 50,
    "band_pts": 7.5,
    "min_trade_quote": 2,
    "reprice_after_s": 600,
}

# Refusals that leave the first book unsettled, so the next cycle retries the
# levels they held back.  Every other refusal counts as answered-and-done.
TRANSIENT_REFUSALS = (
    HALTED,
    CLOCK_SKEW,
    STALE_MARKET,
    DRAWDOWN_STOP,
    DAILY_CAP,
    RATE_CAP,
    UNALLOCATED_NEGATIVE,
)

# The levels a recentered grid (center 1.1) puts down.
RECENTERED_LEVELS = {
    -3: D("1.0519"),
    -2: D("1.0677"),
    -1: D("1.0837"),
    1: D("1.1165"),
    2: D("1.1332"),
    3: D("1.1502"),
}

_OMIT = object()


# ---------------------------------------------------------------- the outside world


class FakeMarket:
    """A fixed book, a fixed poll range and a scripted candle list.

    `low`/`high` are the poll window's extremes (the second argument of
    `range_since`), `fail` makes `best_bid_ask` raise, and every call is counted
    so a test can tell whether a product was polled this cycle.
    """

    def __init__(self, bid=D("0.99"), ask=D("1.00")):
        self.bid, self.ask = D(bid), D(ask)
        self.low, self.high = self.bid, self.ask
        self.candle_rows = []
        self.best_bid_ask_calls = 0
        self.range_since_calls = 0
        self.since_values = []
        self.fail = False

    def set_book(self, bid, ask, low=None, high=None):
        self.bid, self.ask = D(bid), D(ask)
        self.low = self.bid if low is None else D(low)
        self.high = self.ask if high is None else D(high)

    def best_bid_ask(self):
        self.best_bid_ask_calls += 1
        if self.fail:
            raise RuntimeError("book unavailable")
        return self.bid, self.ask

    def range_since(self, since):
        self.range_since_calls += 1
        self.since_values.append(since)
        if self.fail:
            raise RuntimeError("range unavailable")
        return self.low, self.high

    def candles(self, start, end):
        return list(self.candle_rows)


def candle(market, *, low=None, high=None, start=None):
    """Append one candle that starts after every order already on the book."""
    market.candle_rows.append(
        {
            "start": time.time() + 1 if start is None else float(start),
            "low": market.low if low is None else D(low),
            "high": market.high if high is None else D(high),
        }
    )


def fill_a_buy(market):
    """A candle whose low trades through the level -1 buy (0.9852)."""
    candle(market, low=D("0.98"), high=D("1.0"))


def fill_a_sell(market, high=D("1.02")):
    """A candle whose high trades through the level 1 sell (1.0150)."""
    candle(market, low=D("1.0"), high=D(high))


# ---------------------------------------------------------------- the engine


class SpyStrategy:
    """A real strategy wrapped so a test can count calls and script the answers.

    `inner` supplies the real behaviour (when given); `decisions` is consumed one
    entry per `decide`, `init_decision` overrides the first book, and
    `raise_in_decide` makes the bot blow up mid-cycle.  Every `BotView` handed to
    `decide` is kept, so a test can read what the runner actually passed.
    """

    def __init__(
        self,
        inner=None,
        *,
        name=None,
        decisions=None,
        init_decision=None,
        raise_in_decide=False,
    ):
        self.inner = inner
        self.name = name or (inner.name if inner is not None else "grid")
        self.decisions = list(decisions or [])
        self.init_decision = init_decision
        self.raise_in_decide = raise_in_decide
        self.init_calls = 0
        self.decide_calls = 0
        self.views = []

    def validate(self, params, spec=None):
        if self.inner is not None:
            return self.inner.validate(params, spec)

    def fee_guard(self, params, maker_fee_pct):
        if self.inner is not None:
            return self.inner.fee_guard(params, maker_fee_pct)
        return None

    def init_intents(self, snap, view):
        self.init_calls += 1
        if self.init_decision is not None:
            return self.init_decision
        if self.inner is not None:
            return self.inner.init_intents(snap, view)
        return Decision([])

    def decide(self, snap, view):
        self.decide_calls += 1
        self.views.append(view)
        if self.raise_in_decide:
            raise RuntimeError(f"{self.name} exploded in decide")
        if self.decisions:
            return self.decisions.pop(0)
        if self.inner is not None:
            return self.inner.decide(snap, view)
        return Decision([])


def default_strategies():
    return {"grid": GridStrategy(), "rebalance": RebalanceStrategy()}


class Env:
    """One engine: a store, a dry-run exchange, a gateway, a runner and a book."""

    def __init__(
        self,
        root,
        *,
        params=None,
        env=None,
        strategies=None,
        market=None,
        bot_id=BOT,
        product=PRODUCT,
        strategy="grid",
        capital_quote=D("100"),
        capital_base=D("50"),
        heartbeat=None,
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.env = dict(BASE_ENV)
        if env:
            self.env.update(env)
        self.sleeps = []
        self.markets = {}
        self.failing = set()
        self.market_asks = []
        self.heartbeat = Path(heartbeat) if heartbeat else self.root / "hb.json"

        self.store = Store(self.root / "t.db")
        self.store.create_bot(
            bot_id,
            product,
            strategy,
            dict(GRID_PARAMS if params is None else params),
            D(capital_quote),
            D(capital_base),
        )
        self.market = FakeMarket() if market is None else market
        self.markets[product] = self.market

        self.exchange = DryRunExchange(self.store.conn, self.market_for, FEE_RATE)
        self.limits = Limits.from_env(self.env)
        self.snapshots = build_snapshot_cache(self.limits)
        self.gateway = self.build_gateway()
        if D(capital_quote) > 0 or D(capital_base) > 0:
            self.gateway.seed_dry(bot_id, D(capital_quote), D(capital_base))
        self.strategies = (
            dict(strategies) if strategies is not None else default_strategies()
        )
        self.runner = self.new_runner()

    # ------------------------------------------------ collaborators
    def market_for(self, product):
        self.market_asks.append(product)
        if product in self.failing:
            raise RuntimeError(f"no market data for {product}")
        if product not in self.markets:
            self.markets[product] = FakeMarket()
        return self.markets[product]

    def spec_for(self, product):
        return SPEC

    def build_gateway(self, *, env=None, limits=None, **overrides):
        if limits is None:
            limits = Limits.from_env(self.env if env is None else env)
        kwargs = dict(
            store=self.store,
            ledger=Ledger(self.store, fee_rate=FEE_RATE),
            limits=limits,
            caps=CapWindow(self.store, time.time),
            snapshots=self.snapshots,
            spec_for=self.spec_for,
            fee_rate=FEE_RATE,
            totals=self.exchange.totals,
            exchange=self.exchange,
            sleep=lambda seconds: None,
        )
        kwargs.update(overrides)
        return OrderGateway(**kwargs)

    def new_runner(
        self,
        *,
        strategies=None,
        env=None,
        gateway=None,
        snapshots=None,
        market_for=None,
        now=_OMIT,
        heartbeat_path=None,
    ):
        return Runner(
            store=self.store,
            gateway=self.gateway if gateway is None else gateway,
            exchange=self.exchange,
            snapshots=self.snapshots if snapshots is None else snapshots,
            strategies=self.strategies if strategies is None else strategies,
            env=self.env if env is None else env,
            market_for=self.market_for if market_for is None else market_for,
            spec_for=self.spec_for,
            **({} if now is _OMIT else {"now": now}),
            heartbeat_path=self.heartbeat
            if heartbeat_path is None
            else heartbeat_path,
            sleep=lambda seconds: self.sleeps.append(seconds),
        )

    # ------------------------------------------------ bots and orders
    def add_bot(
        self,
        bot_id,
        *,
        product=PRODUCT,
        strategy="grid",
        params=None,
        capital_quote=D("0"),
        capital_base=D("0"),
        status=ACTIVE,
        seed=False,
    ):
        self.store.create_bot(
            bot_id,
            product,
            strategy,
            dict(GRID_PARAMS if params is None else params),
            D(capital_quote),
            D(capital_base),
        )
        if status != ACTIVE:
            self.store.set_bot_status(bot_id, status)
        if seed:
            self.gateway.seed_dry(bot_id, D(capital_quote), D(capital_base))
        return self.store.get_bot(bot_id)

    def watch_exchange_writes(self):
        """Record every place/cancel the exchange is asked to make."""
        writes = []
        real_place, real_cancel = self.exchange.place_limit, self.exchange.cancel

        def place(cid, product, side, size, price):
            writes.append(("place", cid))
            return real_place(cid, product, side, size, price)

        def cancel(order_ids):
            writes.append(("cancel", tuple(order_ids)))
            return real_cancel(order_ids)

        self.exchange.place_limit = place
        self.exchange.cancel = cancel
        return writes


def make_env(root, **kwargs):
    return Env(root, **kwargs)


@pytest.fixture
def envs(tmp_path):
    """Build engines; each gets its own directory (the first one uses tmp_path)."""
    made = []
    count = {"n": 0}

    def build(**kwargs):
        index = count["n"]
        count["n"] += 1
        root = tmp_path if index == 0 else tmp_path / f"env{index}"
        env = make_env(root, **kwargs)
        made.append(env)
        return env

    yield build
    for env in made:
        env.store.close()


# ---------------------------------------------------------------- reading the store


def orders(store, owner, statuses=None):
    """The owner's order rows, optionally narrowed to some statuses."""
    if statuses is None:
        return store.orders(owner=owner)
    statuses = (statuses,) if isinstance(statuses, str) else tuple(statuses)
    return store.orders(owner=owner, statuses=statuses)


def events(store, level=None):
    rows = store.conn().execute("SELECT level, message FROM events").fetchall()
    found = [{"level": row["level"], "message": row["message"]} for row in rows]
    if level is None:
        return found
    return [event for event in found if event["level"] == level]


def messages(store, level=None):
    return [event["message"] for event in events(store, level)]


def bot_row(env, bot_id=BOT):
    return env.store.get_bot(bot_id)


def heartbeat(env):
    return json.loads(Path(env.heartbeat).read_text())


def set_updated_at(store, cid, ts):
    store.conn().execute(
        "UPDATE orders SET updated_at=? WHERE client_order_id=?", (ts, cid)
    )


def insert_order_row(
    store,
    *,
    owner=BOT,
    side="BUY",
    level=-1,
    price=D("0.9852"),
    size=D("10"),
    product=PRODUCT,
    status=PENDING_SUBMIT,
    order_id=None,
    basis=None,
    opposite=OPP_TODO,
    filled_size=None,
    filled_value=None,
    fees=D("0"),
):
    """Write one order row the engine's own way and settle it as asked."""
    cid = f"cb-{owner}-{side[0]}{level:+d}-{uuid.uuid4().hex[:12]}"
    store.insert_order(
        cid,
        owner,
        "bot",
        product,
        side,
        level,
        D(price),
        D(size),
        status=status,
        order_id=order_id,
        basis_per_base=None if basis is None else D(basis),
    )
    fields = {"opposite": opposite}
    if filled_size is not None:
        fields["filled_size"] = D(filled_size)
        fields["filled_value"] = (
            D(filled_value) if filled_value is not None else D(filled_size) * D(price)
        )
        fields["fees"] = D(fees)
    store.update_order(cid, **fields)
    return cid


def filled_row(store, **kwargs):
    """A stored FILLED row with a fill on it and no opposite order yet."""
    kwargs.setdefault("status", FILLED)
    return insert_order_row(store, **kwargs)


def place_intent(side="BUY", size=D("10"), price=D("0.99"), level=-1, consumes=None):
    return OrderIntent(
        action="place",
        side=side,
        size=D(size),
        limit_price=D(price),
        level=level,
        cancel_cid=None,
        reason="test",
        consumes_fill=consumes,
    )


def cancel_intent(cid):
    return OrderIntent(
        action="cancel",
        side=None,
        size=None,
        limit_price=None,
        level=None,
        cancel_cid=cid,
        reason="test",
    )


def prime_snapshots(env):
    """Put a fresh snapshot and a measured clock in the cache by hand."""
    market = env.market
    now = time.time()
    env.snapshots.put(
        MarketSnapshot(
            PRODUCT, market.bid, market.ask, market.low, market.high, now
        )
    )
    env.snapshots.set_clock(now, now)


def answered_buy(env, **kwargs):
    """A FILLED buy at level -1 whose opposite order was accepted, plus coverage.

    The fill is written straight to the store, so the simulated account has to be
    given the base it produced: the ledger counts the filled base as the owner's,
    and a short exchange would refuse the follow-up sell.
    """
    env.store.set_init_done(BOT)
    env.exchange.deposit("XRP", D("10"), "cover the synthetic fill")
    return filled_row(
        env.store,
        side="BUY",
        level=-1,
        price=D("0.9852"),
        size=D("10"),
        filled_size=D("10"),
        filled_value=D("9.852"),
        fees=D("0.04926"),
        opposite=OPP_PLACED,
        **kwargs,
    )


def children_of(env, parent_cid, *, live_only=False):
    """The rows that answer the fill *parent_cid*, optionally only the usable ones."""
    rows = [
        row
        for row in orders(env.store, BOT)
        if row["consumes_fill"] == parent_cid
    ]
    if live_only:
        rows = [row for row in rows if row["status"] not in (FAILED, REJECTED)]
    return rows


def rejected_follow_up(
    env, parent_cid, note, *, level=0, price=D("1.0"), size=D("10")
):
    """A follow-up row the exchange refused, answering the fill *parent_cid*.

    `note` is what the refusal left behind: a post-only reprice rejection is
    normal and its note says so, while any other refusal is one the runner counts
    against the fill.
    """
    cid = insert_order_row(
        env.store,
        side="SELL",
        level=level,
        price=D(price),
        size=D(size),
        status=REJECTED,
    )
    env.store.update_order(
        cid, consumes_fill=parent_cid, parent_cid=parent_cid, note=note
    )
    return cid


# ---------------------------------------------------------------- start-up


def test_startup_refuses_live_in_p1(envs):
    env = envs()
    for value in ("true", "1", "TRUE", "yes", "on"):
        runner = env.new_runner(env={**BASE_ENV, "CROW_COINBASE_LIVE": value})
        found = runner.startup_checks()
        assert any("live trading lands in P2" in problem for problem in found), value

    for value in ("false", "0", "no", "off", "FALSE", ""):
        assert env.new_runner(
            env={**BASE_ENV, "CROW_COINBASE_LIVE": value}
        ).startup_checks() == [], value

    assert env.new_runner(env=dict(BASE_ENV)).startup_checks() == []

    banana = env.new_runner(
        env={**BASE_ENV, "CROW_COINBASE_LIVE": "banana"}
    ).startup_checks()
    assert any("unrecognised CROW_COINBASE_LIVE value" in p for p in banana)

    live_gateway = env.build_gateway(live_enabled=True)
    assert any(
        "live trading lands in P2" in p
        for p in env.new_runner(gateway=live_gateway).startup_checks()
    )


def test_startup_checks_validate_and_fee_guard_per_bot(envs):
    env = envs()
    assert env.runner.startup_checks() == []

    env.add_bot(
        "b2", params={**GRID_PARAMS, "step_pct": "0.5"}, capital_quote=D("0")
    )
    problems = env.runner.startup_checks()
    assert any(
        problem.startswith("bot b2:") and "fee" in problem.lower()
        for problem in problems
    )

    # A step that collapses on the 0.0001 tick: only `validate(params, spec)` can
    # see that, so the refusal proves the book is built against the real tick.
    env.add_bot(
        "b3", params={**GRID_PARAMS, "step_pct": "0.001"}, capital_quote=D("0")
    )
    free_fees = env.new_runner(
        env={**env.env, "CROW_COINBASE_MAKER_FEE_PCT": "0"}
    )
    assert any(
        problem.startswith("bot b3:")
        and "XRP-USDC" in problem
        and "collapse" in problem
        for problem in free_fees.startup_checks()
    )

    env.add_bot("b4", strategy="nope", capital_quote=D("0"))
    env.add_bot("b5", strategy="nope", capital_quote=D("0"), status=STOPPED)

    problems = env.runner.startup_checks()
    assert any(
        problem.startswith("bot b4:") and "unknown strategy" in problem
        for problem in problems
    )
    assert not any(problem.startswith("bot b5:") for problem in problems)
    assert not any(problem.startswith("bot b1:") for problem in problems)


def test_check_key_refuses_transfer():
    scoped = {"can_transfer": False, "portfolio_uuid": "port-1"}
    assert check_key(dict(scoped), "port-1") is None
    with pytest.raises(StartupRefused):
        check_key({"can_transfer": True, "portfolio_uuid": "port-1"}, "port-1")


def test_check_key_refuses_unscoped():
    for perms in (
        {"can_transfer": False},
        {"can_transfer": False, "portfolio_uuid": ""},
        {"can_transfer": False, "portfolio_uuid": None},
    ):
        with pytest.raises(StartupRefused):
            check_key(dict(perms), "port-1")
    # A key that is scoped is still refused when the target portfolio is blank.
    for portfolio_id in ("", None):
        with pytest.raises(StartupRefused):
            check_key({"can_transfer": False, "portfolio_uuid": "port-1"}, portfolio_id)


def test_check_key_refuses_mismatch():
    with pytest.raises(StartupRefused):
        check_key({"can_transfer": False, "portfolio_uuid": "port-1"}, "port-2")


def test_check_key_accepts_scoped_key():
    perms = {"can_transfer": False, "portfolio_uuid": "port-1"}
    assert check_key(perms, "port-1") is None
    assert perms == {"can_transfer": False, "portfolio_uuid": "port-1"}


class FeeExchange:
    """The one read `live_fee_rate` makes of the exchange."""

    def __init__(self, rate):
        self.rate = None if rate is None else D(rate)
        self.calls = 0

    def maker_fee_rate(self):
        self.calls += 1
        return self.rate


def test_live_fee_rate_takes_max():
    higher = live_fee_rate(D("0.5"), FeeExchange(D("0.8")))
    assert higher == D("0.8")
    assert isinstance(higher, D)

    lower = live_fee_rate(D("0.5"), FeeExchange(D("0.2")))
    assert lower == D("0.5")
    assert isinstance(lower, D)

    unknown = FeeExchange(None)
    assert live_fee_rate(D("0.5"), unknown) == D("0.5")
    assert unknown.calls == 1


def test_snapshot_cache_built_with_poll_seconds():
    cache = build_snapshot_cache(Limits.from_env({"CROW_COINBASE_POLL_SECONDS": "120"}))
    assert cache.poll_seconds == 120
    assert cache.skew_s() is None
    cache.set_clock(time.time(), time.time())
    assert cache.skew_s() is not None
    assert abs(cache.skew_s()) < 1.0

    assert build_snapshot_cache(Limits.from_env({})).poll_seconds == 60


# ---------------------------------------------------------------- the first book


def test_grid_bot_places_init_through_gateway(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})

    assert env.runner.cycle()["cycle"] == 1

    rows = orders(env.store, BOT)
    assert len(rows) == 6
    assert {row["status"] for row in rows} == {OPEN}
    assert all(row["client_order_id"].startswith("cb-b1-") for row in rows)
    assert all(row["order_id"] for row in rows)
    assert sorted(row["level"] for row in rows if row["side"] == "BUY") == [-3, -2, -1]
    assert sorted(row["level"] for row in rows if row["side"] == "SELL") == [1, 2, 3]
    # Post-only: a resting buy is under the ask, a resting sell above the bid.
    for row in rows:
        if row["side"] == "BUY":
            assert row["price"] < env.market.ask
        else:
            assert row["price"] > env.market.bid
    assert spy.init_calls == 1
    assert spy.decide_calls == 0
    assert bot_row(env)["init_done"] is True
    assert events(env.store, "error") == []


def test_init_sells_carry_center_basis(envs):
    env = envs()
    env.runner.cycle()
    rows = orders(env.store, BOT)
    assert len(rows) == 6
    sells = [row for row in rows if row["side"] == "SELL"]
    buys = [row for row in rows if row["side"] == "BUY"]
    assert len(sells) == 3 and len(buys) == 3
    assert {row["basis_per_base"] for row in sells} == {D("1.0")}
    assert {row["basis_per_base"] for row in buys} == {None}


def test_init_not_repeated_after_restart(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})

    env.runner.cycle()
    assert spy.init_calls == 1
    first = len(orders(env.store, BOT))
    assert first == 6

    restarted = env.new_runner()
    restarted.cycle()
    assert spy.init_calls == 1
    assert spy.decide_calls == 1
    assert len(orders(env.store, BOT)) == first

    # A crash mid-init leaves rows behind but init_done 0: the levels already on
    # the book must not be placed a second time.
    crash = envs()
    prime_snapshots(crash)
    first_place = crash.gateway.submit(
        "bot", BOT, place_intent("BUY", D("10"), D("0.9852"), -1)
    )
    second_place = crash.gateway.submit(
        "bot", BOT, place_intent("SELL", D("16.6"), D("1.015"), 1)
    )
    assert first_place.ok is True and second_place.ok is True
    assert len(orders(crash.store, BOT)) == 2
    assert bot_row(crash)["init_done"] is False

    crash.runner.cycle()
    rows = orders(crash.store, BOT)
    assert len(rows) == 6
    assert len({(row["side"], row["level"]) for row in rows}) == 6
    assert bot_row(crash)["init_done"] is True


def test_init_done_only_after_every_intent_resolved(envs):
    # Refused and recorded: nothing was placed, but init is settled.
    refused = envs(env={"CROW_COINBASE_BOT_MAX_ORDER_USD": "5"})
    refused.runner.cycle()
    assert bot_row(refused)["init_done"] is True
    assert orders(refused.store, BOT) == []
    warnings = messages(refused.store, "warn")
    assert any("init refused" in message.lower() for message in warnings)
    assert any("ORDER_TOO_LARGE" in message for message in warnings)

    # A pause from the first book is not a settlement: the bot keeps init pending.
    outside = FakeMarket(bid=D("1.5"), ask=D("1.51"))
    paused_env = envs(market=outside)
    paused_env.runner.cycle()
    assert bot_row(paused_env)["init_done"] is False
    assert bot_row(paused_env)["status"] == PAUSED
    assert orders(paused_env.store, BOT) == []

    # A transient refusal is not a settlement either: the levels it held back are
    # placed by the next cycle, and only then is the first book done.
    for refusal in TRANSIENT_REFUSALS:
        retried = envs()
        real_submit = retried.gateway.submit

        def refusing(source, owner, intent, product=None, code=refusal):
            return GatewayResult(False, None, code)

        retried.gateway.submit = refusing
        retried.runner.cycle()

        assert bot_row(retried)["init_done"] is False, refusal
        assert orders(retried.store, BOT) == [], refusal
        assert any(
            refusal in message for message in messages(retried.store, "warn")
        ), refusal

        retried.gateway.submit = real_submit
        retried.runner.cycle()

        assert len(orders(retried.store, BOT)) == 6, refusal
        assert bot_row(retried)["init_done"] is True, refusal

    # Partly settled: the two places that went through stand, the four refused
    # ones are retried, and no level ends up on the book twice.
    mixed = envs()
    real_submit = mixed.gateway.submit
    placed = []

    def partly_refusing(source, owner, intent, product=None):
        if len(placed) < 2:
            placed.append(intent)
            return real_submit(source, owner, intent, product)
        return GatewayResult(False, None, DAILY_CAP)

    mixed.gateway.submit = partly_refusing
    mixed.runner.cycle()

    assert bot_row(mixed)["init_done"] is False
    assert len(orders(mixed.store, BOT)) == 2

    mixed.gateway.submit = real_submit
    mixed.runner.cycle()

    rows = orders(mixed.store, BOT)
    assert len(rows) == 6
    assert len({(row["side"], row["level"]) for row in rows}) == 6
    assert bot_row(mixed)["init_done"] is True


def test_init_retries_after_unallocated_negative_clears(envs):
    env = envs()
    real_submit = env.gateway.submit
    short = {"on": True}

    def refusing_while_short(source, owner, intent, product=None):
        if short["on"]:
            return GatewayResult(False, None, UNALLOCATED_NEGATIVE)
        return real_submit(source, owner, intent, product)

    env.gateway.submit = refusing_while_short
    env.runner.cycle()

    # The exchange is short of what its owners hold, so the first book is not
    # settled: every level is left open for a later cycle rather than recorded as
    # answered-and-done.
    assert bot_row(env)["init_done"] is False
    assert orders(env.store, BOT) == []
    assert any(
        UNALLOCATED_NEGATIVE in message for message in messages(env.store, "warn")
    )

    short["on"] = False
    env.runner.cycle()

    rows = orders(env.store, BOT)
    assert len(rows) == 6
    # Each level once: the retry lays the whole book and nothing twice.
    assert len({(row["side"], row["level"]) for row in rows}) == 6
    assert bot_row(env)["init_done"] is True


def test_kill_during_first_cycle_then_clear_halt_gives_full_init(envs):
    env = envs()
    real_submit = env.gateway.submit
    places = []

    def halting_submit(source, owner, intent, product=None):
        result = real_submit(source, owner, intent, product)
        if result.ok:
            places.append(intent)
            env.gateway.halt("kill during init")
        return result

    env.gateway.submit = halting_submit
    env.runner.cycle()

    assert env.gateway.is_halted() is True
    assert len(places) == 1
    assert len(orders(env.store, BOT)) == 1
    assert bot_row(env)["init_done"] is False
    assert any(HALTED in message for message in messages(env.store, "warn"))

    env.gateway.clear_halt()
    env.gateway.submit = real_submit
    env.runner.cycle()

    rows = orders(env.store, BOT)
    assert len(rows) == 6
    assert {(row["side"], row["level"]) for row in rows} == {
        ("BUY", -3),
        ("BUY", -2),
        ("BUY", -1),
        ("SELL", 1),
        ("SELL", 2),
        ("SELL", 3),
    }
    assert bot_row(env)["init_done"] is True


# ---------------------------------------------------------------- follow-ups


def test_refused_follow_up_retried_next_cycle_not_lost(envs):
    # The happy path first: the fill is answered once and the parent is retired.
    happy = envs()
    happy.runner.cycle()
    fill_a_buy(happy.market)
    happy.runner.cycle()
    buy = [
        row
        for row in orders(happy.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ][0]
    follow_ups = [row for row in orders(happy.store, BOT) if row["consumes_fill"]]
    assert len(follow_ups) == 1
    assert follow_ups[0]["side"] == "SELL"
    assert follow_ups[0]["level"] == 0
    assert follow_ups[0]["consumes_fill"] == buy["client_order_id"]
    assert happy.store.order(buy["client_order_id"])["opposite"] == OPP_PLACED

    # A refused follow-up is not lost: the fill stays TODO and is retried.
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    real_submit = env.gateway.submit
    refused_places = []

    def refusing_submit(source, owner, intent, product=None):
        if intent.action == "place":
            refused_places.append(intent)
            return GatewayResult(False, None, "RATE_CAP")
        return real_submit(source, owner, intent, product)

    env.gateway.submit = refusing_submit
    env.runner.cycle()
    filled = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ]
    assert len(filled) == 1
    parent_cid = filled[0]["client_order_id"]
    assert refused_places, "the follow-up was never offered to the gateway"
    assert env.store.order(parent_cid)["opposite"] == OPP_TODO
    assert [row for row in orders(env.store, BOT) if row["consumes_fill"]] == []
    assert any("RATE_CAP" in message for message in messages(env.store, "warn"))

    env.gateway.submit = real_submit
    env.runner.cycle()
    assert env.store.order(parent_cid)["opposite"] == OPP_PLACED
    follow_ups = [row for row in orders(env.store, BOT) if row["consumes_fill"]]
    assert len(follow_ups) == 1
    assert follow_ups[0]["consumes_fill"] == parent_cid

    # A crash between reconcile and the follow-up submit: the report is thrown
    # away and the next runner still answers the fill from the stored rows.
    crash = envs()
    crash.runner.cycle()
    fill_a_buy(crash.market)
    crash.exchange.advance(time.time())
    report = reconcile(crash.store, crash.exchange, now=time.time())
    assert report.new_fills, "the fill was not seen by the discarded reconcile"
    assert [row for row in orders(crash.store, BOT) if row["consumes_fill"]] == []
    crash_parent = [
        row
        for row in orders(crash.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ][0]["client_order_id"]

    restarted = crash.new_runner()
    restarted.cycle()
    assert crash.store.order(crash_parent)["opposite"] == OPP_PLACED
    follow_ups = [row for row in orders(crash.store, BOT) if row["consumes_fill"]]
    assert len(follow_ups) == 1
    assert follow_ups[0]["consumes_fill"] == crash_parent


def test_crash_after_follow_up_accepted_before_mark_is_healed(envs):
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    env.runner.cycle()

    parent = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ][0]["client_order_id"]
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    follow_ups = [row for row in orders(env.store, BOT) if row["consumes_fill"]]
    assert len(follow_ups) == 1
    rows_before = len(orders(env.store, BOT))

    # The crash: the follow-up was accepted but the marking never ran.
    env.store.update_order(parent, opposite=OPP_TODO)
    env.runner.cycle()

    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert len(orders(env.store, BOT)) == rows_before
    assert len([row for row in orders(env.store, BOT) if row["consumes_fill"]]) == 1


def test_heal_unmarks_parent_whose_follow_up_failed(envs):
    env = envs()
    parent = answered_buy(env)
    failed = insert_order_row(
        env.store,
        side="SELL",
        level=0,
        price=D("1.0"),
        size=D("10"),
        status=FAILED,
    )
    env.store.update_order(failed, consumes_fill=parent, parent_cid=parent)
    assert children_of(env, parent, live_only=True) == []

    env.runner.cycle()

    # The fill nobody answered was offered again, once, and answered this time.
    live = children_of(env, parent, live_only=True)
    assert len(live) == 1
    assert live[0]["client_order_id"] != failed
    assert live[0]["side"] == "SELL"
    assert live[0]["level"] == 0
    assert live[0]["status"] == OPEN
    assert live[0]["parent_cid"] == parent
    assert env.store.order(parent)["opposite"] == OPP_PLACED

    # The dead child is still there and still counts as a child of the parent, so
    # a second cycle neither re-places the level nor loses the answered mark.
    rows_after = len(orders(env.store, BOT))
    env.runner.cycle()

    assert children_of(env, parent, live_only=True) == live
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert len(orders(env.store, BOT)) == rows_after


def test_three_rejected_follow_ups_skip_the_fill_with_one_alert(envs):
    env = envs()
    parent = answered_buy(env)
    # Three attempts to answer the fill, three refusals.  They all carry the same
    # reason, so "the last rejection reason" in the alert is that text whichever
    # of the three the runner counts last.
    reason = "EXCHANGE_REJECTED: insufficient funds"
    refused = [rejected_follow_up(env, parent, reason) for _ in range(3)]
    assert len(children_of(env, parent)) == 3
    assert children_of(env, parent, live_only=True) == []

    env.runner.cycle()

    # A fourth attempt would be refused the same way, so the fill is given up on
    # instead of offered again, and it says so once.
    after = env.store.order(parent)
    assert after["opposite"] == OPP_SKIPPED
    assert after["note"] == "follow-up rejected x3"

    def follow_up_alerts():
        return [
            message for message in messages(env.store, "ALERT") if parent in message
        ]

    alerts = follow_up_alerts()
    assert len(alerts) == 1
    assert reason in alerts[0]

    # No new follow-up was offered: the three refused rows are the whole story.
    assert len(children_of(env, parent)) == 3
    assert children_of(env, parent, live_only=True) == []
    assert {row["client_order_id"] for row in children_of(env, parent)} == set(
        refused
    )

    # The skip is final: the next cycle neither alerts again nor offers the fill.
    rows_after = len(orders(env.store, BOT))
    env.runner.cycle()

    assert len(follow_up_alerts()) == 1
    assert len(orders(env.store, BOT)) == rows_after
    assert env.store.order(parent)["opposite"] == OPP_SKIPPED
    assert len(children_of(env, parent)) == 3


def test_post_only_rejections_do_not_count_toward_the_limit(envs):
    env = envs()
    parent = answered_buy(env)
    # A post-only order the exchange refused only needs a reprice: three of those
    # are normal traffic, not three answers that failed.
    for _ in range(3):
        rejected_follow_up(env, parent, "POST_ONLY_EXHAUSTED")

    env.runner.cycle()

    # The fill was offered again and answered this time.
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert env.store.order(parent)["note"] != "follow-up rejected x3"
    live = children_of(env, parent, live_only=True)
    assert len(live) == 1
    assert live[0]["consumes_fill"] == parent
    assert live[0]["side"] == "SELL"
    assert live[0]["status"] == OPEN
    assert len(children_of(env, parent)) == 4
    assert messages(env.store, "ALERT") == []


def test_two_rejected_follow_ups_still_retried(envs):
    env = envs()
    parent = answered_buy(env)
    for _ in range(2):
        rejected_follow_up(env, parent, "EXCHANGE_REJECTED: insufficient funds")

    env.runner.cycle()

    # Two refusals are under the limit: the fill is un-marked and offered again.
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert env.store.order(parent)["note"] != "follow-up rejected x3"
    live = children_of(env, parent, live_only=True)
    assert len(live) == 1
    assert live[0]["consumes_fill"] == parent
    assert live[0]["status"] == OPEN
    assert len(children_of(env, parent)) == 3
    assert messages(env.store, "ALERT") == []


def test_follow_up_stuck_pending_submit_expired_then_placed_again_once(envs):
    env = envs()
    parent = answered_buy(env)
    stuck = insert_order_row(
        env.store,
        side="SELL",
        level=0,
        price=D("1.0"),
        size=D("10"),
        status=PENDING_SUBMIT,
    )
    env.store.update_order(stuck, consumes_fill=parent, parent_cid=parent)
    # It never reached the exchange and nobody answers for it: age it past
    # reconcile's window so the next cycle has to give up on it.
    env.store.conn().execute(
        "UPDATE orders SET created_at=? WHERE client_order_id=?",
        (time.time() - 1000, stuck),
    )

    env.runner.cycle()

    assert env.store.order(stuck)["status"] == FAILED
    live = children_of(env, parent, live_only=True)
    assert len(live) == 1
    assert live[0]["client_order_id"] != stuck
    assert live[0]["status"] == OPEN
    assert env.store.order(parent)["opposite"] == OPP_PLACED

    rows_after = len(orders(env.store, BOT))
    env.runner.cycle()

    assert children_of(env, parent, live_only=True) == live
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert len(orders(env.store, BOT)) == rows_after


def test_heal_leaves_parent_with_live_child_alone(envs):
    env = envs()
    parent = answered_buy(env)
    failed = insert_order_row(
        env.store,
        side="SELL",
        level=0,
        price=D("1.0"),
        size=D("10"),
        status=FAILED,
    )
    env.store.update_order(failed, consumes_fill=parent, parent_cid=parent)
    open_child = insert_order_row(
        env.store,
        side="SELL",
        level=0,
        price=D("1.0"),
        size=D("10"),
        status=OPEN,
    )
    env.store.update_order(open_child, consumes_fill=parent, parent_cid=parent)
    rows_before = len(orders(env.store, BOT))

    env.runner.cycle()

    # One child is still usable, so the fill was answered: nothing is re-placed.
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert env.store.order(open_child)["status"] == OPEN
    assert len(orders(env.store, BOT)) == rows_before


def test_heal_repairs_init_sell_basis(envs):
    env = envs()
    env.store.set_init_done(BOT)
    sell = insert_order_row(
        env.store,
        side="SELL",
        level=1,
        price=D("1.015"),
        size=D("16.6"),
        status=OPEN,
    )
    buy = insert_order_row(
        env.store,
        side="BUY",
        level=-1,
        price=D("0.9852"),
        size=D("10"),
        status=OPEN,
    )
    assert env.store.order(sell)["basis_per_base"] is None

    env.runner.cycle()

    # An init sell starts its profit at the grid's center, a buy has no basis.
    assert env.store.order(sell)["basis_per_base"] == D("1.0")
    assert env.store.order(buy)["basis_per_base"] is None


def test_skipped_fill_not_retried_forever(envs):
    spy = SpyStrategy()
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    cid = filled_row(
        env.store,
        side="BUY",
        level=-1,
        filled_size=D("10"),
        filled_value=D("9.852"),
        fees=D("0.0493"),
    )
    assert env.store.order(cid)["opposite"] == OPP_TODO

    env.runner.cycle()  # init: the spy places nothing
    assert bot_row(env)["init_done"] is True
    spy.decisions.append(Decision([], skipped_fills=[cid]))
    env.runner.cycle()

    assert env.store.order(cid)["opposite"] == OPP_SKIPPED
    env.runner.cycle()
    pending = [row["client_order_id"] for row in spy.views[-1].pending_fills]
    assert pending == []
    assert env.store.order(cid)["status"] == FILLED


def test_fills_answered_by_updated_at(envs):
    spy = SpyStrategy()
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    first = filled_row(env.store, side="BUY", level=-1, filled_size=D("10"))
    second = filled_row(env.store, side="BUY", level=-2, filled_size=D("10"))
    now = time.time()
    set_updated_at(env.store, first, now - 10)  # settled last, written first
    set_updated_at(env.store, second, now - 100)  # settled first, written second

    env.runner.cycle()
    env.runner.cycle()

    pending = [row["client_order_id"] for row in spy.views[-1].pending_fills]
    assert pending == [second, first]


def test_warns_on_pending_fill_row_without_cid(envs):
    spy = SpyStrategy()
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.runner.cycle()

    fake = {
        "client_order_id": "",
        "order_id": None,
        "owner": BOT,
        "source": "bot",
        "product": PRODUCT,
        "side": "BUY",
        "level": -1,
        "price": D("0.9852"),
        "size": D("1"),
        "status": FILLED,
        "parent_cid": None,
        "consumes_fill": None,
        "basis_per_base": None,
        "filled_size": D("1"),
        "filled_value": D("0.9852"),
        "fees": D("0"),
        "opposite": OPP_TODO,
        "created_at": time.time() - 100,
        "updated_at": time.time() - 10,
    }
    real_orders = env.store.orders

    def patched(*args, **kwargs):
        owner = kwargs.get("owner", args[0] if args else None)
        statuses = kwargs.get("statuses", args[1] if len(args) > 1 else None)
        rows = list(real_orders(*args, **kwargs))
        if owner == BOT and statuses and FILLED in tuple(statuses):
            rows.append(dict(fake))
        return rows

    env.store.orders = patched
    env.runner.cycle()

    assert any("client_order_id" in message for message in messages(env.store, "warn"))
    handed = [row["client_order_id"] for row in spy.views[-1].pending_fills]
    assert "" in handed


@pytest.mark.parametrize("refusal", ["CANCEL_FAILED", "NOT_CANCELLABLE"])
def test_cancel_failure_skips_places_in_that_decision(envs, refusal):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.runner.cycle()

    live = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["level"] == -3
    ][0]
    # A sell fill waiting for its buy, whose ledger effect the simulated account
    # has to have taken too (the fill is written straight to the store here).
    parent = filled_row(
        env.store,
        side="SELL",
        level=1,
        price=D("1.015"),
        size=D("16.6"),
        filled_size=D("16.6"),
        filled_value=D("16.849"),
        fees=D("0.084245"),
        basis=D("1.0"),
    )
    env.exchange.deposit(QUOTE, D("20"), "cover the synthetic fill")

    rows_before = len(orders(env.store, BOT))
    decision = Decision(
        [
            cancel_intent(live["client_order_id"]),
            place_intent("BUY", D("16.9"), D("0.9852"), -1, consumes=parent),
        ]
    )
    spy.decisions.extend([decision, decision])

    real_submit = env.gateway.submit
    attempted_places = []

    def failing_cancel(source, owner, intent, product=None):
        if intent.action == "cancel":
            return GatewayResult(False, intent.cancel_cid, refusal)
        attempted_places.append(intent)
        return real_submit(source, owner, intent, product)

    env.gateway.submit = failing_cancel
    env.runner.cycle()

    assert attempted_places == []
    assert len(orders(env.store, BOT)) == rows_before
    assert env.store.order(parent)["opposite"] == OPP_TODO
    warned = [
        message
        for message in messages(env.store, "warn")
        if refusal in message or "cancel" in message.lower()
    ]
    assert warned, "a failed cancel in the decision was not recorded"

    env.gateway.submit = real_submit
    env.runner.cycle()

    assert env.store.order(parent)["opposite"] == OPP_PLACED
    placed = [row for row in orders(env.store, BOT) if row["consumes_fill"] == parent]
    assert len(placed) == 1
    assert len(orders(env.store, BOT)) == rows_before + 1


def test_sell_follow_up_carries_parent_basis(envs):
    # A filled BUY: its follow-up SELL carries the buy's own cost basis.
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    env.runner.cycle()

    buy = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ][0]
    follow_up = [row for row in orders(env.store, BOT) if row["consumes_fill"]][0]
    assert follow_up["side"] == "SELL"
    assert follow_up["parent_cid"] == buy["client_order_id"]
    assert follow_up["consumes_fill"] == buy["client_order_id"]
    basis = (buy["filled_value"] + buy["fees"]) / buy["filled_size"]
    assert follow_up["basis_per_base"] == basis

    # A filled SELL: its follow-up BUY names the parent and carries no basis.
    other = envs()
    other.runner.cycle()
    fill_a_sell(other.market)
    other.runner.cycle()

    sell = [
        row
        for row in orders(other.store, BOT)
        if row["side"] == "SELL" and row["status"] == FILLED
    ][0]
    buy_follow_up = [row for row in orders(other.store, BOT) if row["consumes_fill"]][0]
    assert buy_follow_up["side"] == "BUY"
    assert buy_follow_up["parent_cid"] == sell["client_order_id"]
    assert buy_follow_up["consumes_fill"] == sell["client_order_id"]
    assert buy_follow_up["basis_per_base"] is None


def test_realized_pnl_recorded_on_sell_fill(envs):
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    env.runner.cycle()
    candle(env.market, low=D("1.0"), high=D("1.01"))
    env.runner.cycle()

    sell = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "SELL" and row["status"] == FILLED
    ]
    assert len(sell) == 1
    sell = sell[0]
    assert sell["basis_per_base"] is not None

    expected = money.realized_on_sell(
        sell["filled_size"],
        sell["filled_value"] - sell["fees"],
        sell["basis_per_base"],
    )
    assert expected > 0  # a 1.5% step pays the round trip
    assert realized_pnl(env.store) == {BOT: expected}
    assert realized_pnl(env.store, BOT) == {BOT: expected}
    assert realized_pnl(env.store, "nobody") == {}

    # A sell with no basis is skipped, and owner filtering stays per owner.
    filled_row(
        env.store,
        owner="b2",
        side="SELL",
        level=2,
        price=D("1.015"),
        size=D("100"),
        filled_size=D("100"),
        filled_value=D("101.5"),
        fees=D("0.5"),
    )
    assert realized_pnl(env.store) == {BOT: expected}
    assert realized_pnl(env.store, "b2") == {}


def test_fill_recorded_once(envs):
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    env.runner.cycle()
    for _ in range(3):
        env.runner.cycle()

    rows = env.store.conn().execute(
        "SELECT trade_id, COUNT(*) AS n FROM fills GROUP BY trade_id"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["n"] == 1

    buy = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ][0]
    csv_path = Path(env.store.path).parent / "trades.csv"
    lines = [line for line in csv_path.read_text().splitlines() if line.strip()]
    assert len(lines) == 2  # the header and exactly one fill
    assert len([row for row in orders(env.store, BOT) if row["consumes_fill"]]) == 1
    assert len(orders(env.store, BOT)) == 7
    assert env.store.order(buy["client_order_id"])["opposite"] == OPP_PLACED


# ---------------------------------------------------------------- decisions


def test_pause_reason_pauses_bot(envs):
    spy = SpyStrategy(
        decisions=[Decision([], pause_reason="range exit")],
    )
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.runner.cycle()
    env.runner.cycle()

    assert bot_row(env)["status"] == PAUSED
    assert orders(env.store, BOT) == []
    assert any(
        "range exit" in message for message in messages(env.store, "warn")
    )

    # A real grid pausing on a poll window outside its band leaves the book alone.
    grid = envs()
    grid.runner.cycle()
    before = {row["client_order_id"] for row in orders(grid.store, BOT)}
    assert len(before) == 6
    writes = grid.watch_exchange_writes()
    grid.market.set_book(D("0.99"), D("1.00"), low=D("0.9"), high=D("1.0"))
    grid.runner.cycle()

    assert bot_row(grid)["status"] == PAUSED
    assert writes == []
    after = {row["client_order_id"]: row for row in orders(grid.store, BOT)}
    assert set(after) == before
    assert {row["status"] for row in after.values()} == {OPEN}


def test_state_update_merged(envs):
    spy = SpyStrategy(
        init_decision=Decision([], state_update={"k": 1}),
        decisions=[Decision([], state_update={"j": 2})],
    )
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.runner.cycle()
    assert bot_row(env)["state"] == {"k": 1}
    env.runner.cycle()
    assert bot_row(env)["state"] == {"k": 1, "j": 2}


def test_stopped_state_does_nothing(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.store.set_bot_status(BOT, STOPPED)
    writes = env.watch_exchange_writes()

    env.runner.cycle()

    assert spy.init_calls == 0
    assert spy.decide_calls == 0
    assert writes == []
    assert orders(env.store, BOT) == []
    # The product is still polled: the portfolio mark depends on it.
    assert env.market.best_bid_ask_calls >= 1
    assert env.snapshots.get(PRODUCT) is not None
    assert heartbeat(env)["cycle"] == 1
    assert bot_row(env)["status"] == STOPPED


def test_paused_bot_reconciled_no_new_orders(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.runner.cycle()
    env.store.set_bot_status(BOT, PAUSED)
    fill_a_buy(env.market)

    env.runner.cycle()

    filled = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ]
    assert len(filled) == 1
    assert filled[0]["filled_size"] > 0
    assert env.store.conn().execute("SELECT COUNT(*) AS n FROM fills").fetchone()[
        "n"
    ] == 1
    assert len(orders(env.store, BOT)) == 6
    assert spy.decide_calls == 0
    assert bot_row(env)["status"] == PAUSED


def test_halted_runner_polls_but_places_nothing(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    env.gateway.halt("test halt")
    writes = env.watch_exchange_writes()

    env.runner.cycle()

    assert env.gateway.is_halted() is True
    assert spy.init_calls == 0
    assert spy.decide_calls == 0
    assert writes == []
    assert orders(env.store, BOT) == []
    assert heartbeat(env)["cycle"] == 1
    assert env.snapshots.get(PRODUCT) is not None


def test_pending_submit_resolved_after_restart(envs):
    env = envs()
    cid = f"cb-{BOT}-B-1-{uuid.uuid4().hex[:12]}"
    landed = env.exchange.place_limit(cid, PRODUCT, "BUY", D("10"), D("0.98"))
    assert landed["ok"] is True
    env.store.insert_order(
        cid, BOT, "bot", PRODUCT, "BUY", -1, D("0.98"), D("10"),
        status=PENDING_SUBMIT,
    )
    env.store.set_init_done(BOT)

    restarted = env.new_runner()
    restarted.cycle()

    rows = [row for row in orders(env.store, BOT) if row["client_order_id"] == cid]
    assert len(rows) == 1
    assert rows[0]["status"] == OPEN
    assert rows[0]["order_id"] == landed["order_id"]


# ---------------------------------------------------------------- drawdown / marks


def test_unallocated_negative_alerts_and_blocks_buys(envs):
    env = envs(strategies={"grid": SpyStrategy(), "rebalance": RebalanceStrategy()})
    real_totals = env.exchange.totals
    short = {"on": True}

    def totals():
        out = dict(real_totals())
        if short["on"]:
            out[QUOTE] = out.get(QUOTE, D(0)) - D("20")
        return out

    env.exchange.totals = totals
    env.gateway.totals = totals

    def unallocated_alerts():
        return [
            message
            for message in messages(env.store, "ALERT")
            if "unallocated" in message.lower()
        ]

    env.runner.cycle()
    assert len(unallocated_alerts()) == 1
    env.runner.cycle()
    assert len(unallocated_alerts()) == 1  # one alert per episode

    refused = env.gateway.submit("bot", BOT, place_intent("BUY", D("10"), D("0.99"), -1))
    assert refused.ok is False
    assert refused.refusal == UNALLOCATED_NEGATIVE

    short["on"] = False
    env.runner.cycle()
    assert len(unallocated_alerts()) == 1
    assert env.store.get("runner:unallocated_alert") is None

    short["on"] = True
    env.runner.cycle()
    assert len(unallocated_alerts()) == 2


def test_portfolio_drawdown_halts_until_cleared(envs):
    spy = SpyStrategy(inner=GridStrategy())
    env = envs(strategies={"grid": spy, "rebalance": RebalanceStrategy()})
    # A stopped bot on another product carries most of the portfolio mark.  Its
    # price is what drops, so the grid's own product never leaves its band: the
    # halt is the portfolio's, and the grid has a book to lay once it is cleared.
    env.add_bot(
        "b2",
        product=SECOND_PRODUCT,
        capital_quote=D("0"),
        capital_base=D("100"),
        status=STOPPED,
        seed=True,
    )
    btc = FakeMarket()
    env.markets[SECOND_PRODUCT] = btc

    env.runner.cycle()
    env.runner.cycle()
    high = env.store.hwm(PORTFOLIO_OWNER)
    assert high == D("249.25")

    btc.set_book(D("0.30"), D("0.31"))
    env.runner.cycle()

    def portfolio_alerts():
        return [
            message
            for message in messages(env.store, "ALERT")
            if "portfolio" in message.lower()
        ]

    assert env.gateway.is_halted() is True
    assert len(portfolio_alerts()) == 1
    assert bot_row(env)["status"] == ACTIVE  # the grid is untouched by the halt

    calls_before = (spy.init_calls, spy.decide_calls)
    rows_before = len(orders(env.store, BOT))
    env.runner.cycle()

    assert (spy.init_calls, spy.decide_calls) == calls_before
    assert len(orders(env.store, BOT)) == rows_before
    assert len(portfolio_alerts()) == 1
    assert heartbeat(env)["cycle"] == 4
    assert len(orders(env.store, BOT, LIVE_STATUSES)) == 6

    low = env.gateway.portfolio_equity()
    assert low is not None and low < high
    assert env.store.hwm(PORTFOLIO_OWNER) == high
    assert env.store.get("runner:init_since:b1") is None

    # Clearing, through the path the API takes: every grid that is not stopped
    # re-initialises, then the portfolio mark is re-based to today's equity, then
    # the halt comes down.  The price never comes back.
    for bot in env.store.list_bots():
        if bot["status"] == STOPPED:
            continue
        env.runner.reinit_bot(bot["id"])
    env.runner.rebase_hwm(PORTFOLIO_OWNER, env.gateway.portfolio_equity())
    env.gateway.clear_halt()

    assert env.store.hwm(PORTFOLIO_OWNER) == low
    assert any("re-based" in message for message in messages(env.store, "info"))
    assert env.gateway.is_halted() is False
    assert any("re-initialised" in message for message in messages(env.store, "info"))
    assert bot_row(env)["init_done"] is False
    assert orders(env.store, BOT, LIVE_STATUSES) == []
    epoch = env.store.get("runner:init_since:b1")
    assert isinstance(epoch, (int, float))

    env.runner.cycle()

    # Still at the low price: the mark sits at the equity rather than above it,
    # so nothing halts again, and the grid lays its book from the re-init.
    assert env.gateway.is_halted() is False
    assert len(portfolio_alerts()) == 1
    assert env.store.hwm(PORTFOLIO_OWNER) == low
    assert spy.init_calls == calls_before[0] + 1
    assert env.store.get("runner:init_since:b1") == epoch
    assert len(orders(env.store, BOT, LIVE_STATUSES)) == 6
    assert bot_row(env)["init_done"] is True


def test_resume_rebases_bot_hwm(envs):
    env = envs(
        params={**GRID_PARAMS, "drawdown_pct": 1},
        env={"CROW_COINBASE_PORTFOLIO_DRAWDOWN_PCT": "90"},
    )
    env.runner.cycle()
    env.runner.cycle()
    assert env.store.hwm(BOT) == D("149.75")

    def pause_alerts():
        return [
            message
            for message in messages(env.store, "ALERT")
            if "paused" in message.lower()
        ]

    # Still inside the grid's band, but a little over 1% under the mark.
    env.market.set_book(D("0.959"), D("0.961"))
    env.runner.cycle()

    assert bot_row(env)["status"] == PAUSED
    assert len(pause_alerts()) == 1
    assert env.store.hwm(BOT) == D("149.75")
    assert env.gateway.is_halted() is False

    low = env.gateway.ledger.equity(BOT, {PRODUCT: D("0.96")}, PRODUCT)
    assert low == D("148")
    env.runner.rebase_hwm(BOT, low)
    env.store.set_bot_status(BOT, ACTIVE)
    assert env.store.hwm(BOT) == low

    env.runner.cycle()

    # The mark is the equity now, so the same price is no drawdown at all.
    assert bot_row(env)["status"] == ACTIVE
    assert len(pause_alerts()) == 1
    assert env.store.hwm(BOT) == low


def test_owner_drawdown_pauses_bot(envs):
    env = envs(
        params={**GRID_PARAMS, "drawdown_pct": 10},
        env={"CROW_COINBASE_PORTFOLIO_DRAWDOWN_PCT": "90"},
    )
    env.runner.cycle()
    env.runner.cycle()
    assert env.store.hwm(BOT) == D("149.75")

    env.market.set_book(D("0.55"), D("0.56"))  # about 15% down from the mark
    env.runner.cycle()

    assert bot_row(env)["status"] == PAUSED
    assert any(BOT in message for message in messages(env.store, "ALERT"))
    assert env.gateway.is_halted() is False


def test_none_portfolio_equity_neither_halts_nor_ratchets(envs):
    env = envs()
    env.add_bot("b2", product=SECOND_PRODUCT, capital_base=D("5"))
    env.failing.add(SECOND_PRODUCT)

    env.runner.cycle()
    assert env.gateway.portfolio_equity() is None
    assert env.store.hwm(PORTFOLIO_OWNER) is None
    assert env.gateway.is_halted() is False

    env.failing.discard(SECOND_PRODUCT)
    env.runner.cycle()
    assert env.gateway.portfolio_equity() is not None
    assert env.store.hwm(PORTFOLIO_OWNER) is not None
    assert env.store.hwm(PORTFOLIO_OWNER) > 0
    assert env.gateway.is_halted() is False


def test_mid_is_none_for_unusable_snapshots(envs):
    env = envs()
    now = time.time()
    poll = env.limits.poll_seconds

    def put(bid, ask, ts):
        env.snapshots.put(
            MarketSnapshot(PRODUCT, D(bid), D(ask), D(bid), D(ask), ts)
        )

    assert env.runner._mid(PRODUCT) is None  # no snapshot at all

    put("1.00", "0.99", now)  # crossed: the ask sits under the bid
    assert env.runner._mid(PRODUCT) is None

    put("0", "1.00", now)  # no bid to price from
    assert env.runner._mid(PRODUCT) is None

    put("0.99", "1.00", now - 10 * poll)  # older than the staleness window
    assert env.runner._mid(PRODUCT) is None

    put("0.99", "1.00", now + 10 * poll)  # stamped ahead of our clock
    assert env.runner._mid(PRODUCT) is None

    put("0.98", "1.00", now)
    assert env.runner._mid(PRODUCT) == D("0.99")


def test_unusable_snapshot_means_no_pause_ratchet_or_benchmark(envs):
    crossed = FakeMarket(bid=D("1.05"), ask=D("1.00"))
    env = envs(market=crossed)
    env.store.update_hwm(BOT, D("1000"))
    assert env.store.get("benchmark:b1") is None

    env.runner.cycle()

    # The cycle really did poll that crossed book, so nothing below is a missing
    # snapshot in disguise.
    snap = env.snapshots.get(PRODUCT)
    assert snap is not None and snap.bid > snap.ask
    assert bot_row(env)["status"] == ACTIVE
    assert env.store.hwm(BOT) == D("1000")
    assert env.store.get("benchmark:b1") is None
    assert not [
        message
        for message in messages(env.store, "ALERT")
        if "drawdown" in message.lower()
    ]


@pytest.mark.parametrize("capital_base", [D("5"), D("0")])
def test_held_but_stopped_product_still_polled(envs, capital_base):
    env = envs()
    env.add_bot(
        "b2",
        product=SECOND_PRODUCT,
        capital_base=capital_base,
        status=STOPPED,
    )
    btc = FakeMarket()
    env.markets[SECOND_PRODUCT] = btc

    env.runner.cycle()

    assert SECOND_PRODUCT in env.market_asks
    assert btc.best_bid_ask_calls == 1  # polled once, no orders to price on it
    assert env.snapshots.get(SECOND_PRODUCT) is not None
    assert env.gateway.portfolio_equity() is not None


def test_snapshot_put_only_under_gateway_lock(envs):
    env = envs()
    real_put = env.snapshots.put
    put_products = []

    def lock_held():
        lock = env.gateway.lock
        owned = getattr(lock, "_is_owned", None)
        if owned is not None:
            return bool(owned())
        acquired = lock.acquire(blocking=False)
        if acquired:
            lock.release()
        return not acquired

    def checked_put(snap):
        assert lock_held(), f"snapshots.put({snap.product}) ran outside gateway.lock"
        put_products.append(snap.product)
        real_put(snap)

    env.snapshots.put = checked_put
    env.runner.cycle()

    assert put_products == [PRODUCT]


def test_reconcile_called_with_epoch_now_and_no_transaction(envs, monkeypatch):
    env = envs()
    real_reconcile = runner_module.reconcile
    calls = []

    def wrapper(*args, **kwargs):
        bound = dict(kwargs)
        for name, value in zip(("store", "exchange", "now", "gateway"), args):
            bound[name] = value
        assert not env.store.conn().in_transaction, "reconcile ran inside a tx"
        calls.append(bound)
        return real_reconcile(*args, **kwargs)

    monkeypatch.setattr(runner_module, "reconcile", wrapper)

    t0 = time.time()
    env.runner.cycle()
    t1 = time.time()

    assert len(calls) == 1
    call = calls[0]
    assert call.get("store") is env.store
    assert call.get("exchange") is env.exchange
    assert call.get("gateway") is env.gateway
    now = call.get("now")
    assert now is not None
    assert now > 1e9  # epoch seconds, not a monotonic clock
    assert t0 - 1 <= now <= t1 + 1

    # The default clock is the store's own clock.
    default = Runner(
        store=env.store,
        gateway=env.gateway,
        exchange=env.exchange,
        snapshots=env.snapshots,
        strategies=env.strategies,
        env=env.env,
        market_for=env.market_for,
        spec_for=env.spec_for,
        heartbeat_path=env.root / "hb-default.json",
        sleep=lambda seconds: None,
    )
    assert default.now is time.time


def test_benchmark_started_on_first_cycle_before_orders(envs):
    env = envs()
    env.runner.cycle()

    mix = env.store.get("benchmark:b1")
    assert mix is not None
    assert D(mix["base"]) == D("50")
    assert D(mix["quote"]) == D("100")
    assert Benchmark(env.store).value(BOT, D("1.0")) == D("150")
    # The baseline was taken before the book went out: it is the capital, not the
    # holding after six resting orders.
    assert len(orders(env.store, BOT)) == 6

    env.runner.cycle()
    assert env.store.get("benchmark:b1") == mix

    env.runner.forget_benchmark(BOT)
    assert env.store.get("benchmark:b1") is None
    env.market.set_book(D("1.04"), D("1.05"))
    env.runner.cycle()
    restarted = env.store.get("benchmark:b1")
    assert restarted is not None
    assert D(restarted["price"]) == D("1.045")


def test_hwm_ratchets_for_bot_and_portfolio(envs):
    env = envs()
    env.runner.cycle()
    env.runner.cycle()

    assert env.store.hwm(BOT) == D("149.75")
    assert env.store.hwm(PORTFOLIO_OWNER) == D("149.75")

    env.market.set_book(D("0.97"), D("0.98"))  # a little lower, above the stops
    env.runner.cycle()

    assert env.store.hwm(BOT) == D("149.75")
    assert env.store.hwm(PORTFOLIO_OWNER) == D("149.75")
    assert env.gateway.is_halted() is False
    assert bot_row(env)["status"] == ACTIVE


def test_heartbeat_written_each_cycle(envs):
    env = envs()
    env.add_bot("b2")

    t0 = time.time()
    env.runner.cycle()
    t1 = time.time()
    first = heartbeat(env)
    assert set(first) == {"ts", "cycle", "bots_active", "errors"}
    assert first["cycle"] == 1
    assert first["bots_active"] == 2
    assert first["errors"] == []
    assert t0 - 1 <= first["ts"] <= t1 + 1

    env.runner.cycle()
    assert heartbeat(env)["cycle"] == 2
    assert heartbeat(env)["errors"] == []
    env.runner.cycle()
    assert heartbeat(env)["cycle"] == 3

    env.store.set_bot_status("b2", PAUSED)
    env.runner.cycle()
    assert heartbeat(env)["bots_active"] == 1
    assert heartbeat(env)["errors"] == []

    leftovers = [p.name for p in Path(env.root).iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []

    before = Path(env.heartbeat).read_text()

    def exploding_advance(now):
        raise RuntimeError("advance exploded")

    env.exchange.advance = exploding_advance
    with pytest.raises(RuntimeError):
        env.runner.cycle()
    assert Path(env.heartbeat).read_text() == before


def test_heartbeat_errors_lists_bots_that_raised(envs):
    boom = SpyStrategy(name="boom", init_decision=Decision([]), raise_in_decide=True)
    grid = SpyStrategy(inner=GridStrategy())
    env = envs(
        strategy="boom",
        strategies={"boom": boom, "grid": grid, "rebalance": RebalanceStrategy()},
    )
    env.add_bot(
        "b2",
        strategy="grid",
        capital_quote=D("100"),
        capital_base=D("50"),
        seed=True,
    )

    env.runner.cycle()  # b1 answers its first book without deciding
    assert heartbeat(env)["errors"] == []

    env.runner.cycle()  # b1 raises in decide, b2 gets its turn anyway

    payload = heartbeat(env)
    assert payload["errors"] == [BOT]
    assert payload["bots_active"] == 2
    assert grid.decide_calls == 1
    assert any(BOT in message for message in messages(env.store, "error"))

    boom.raise_in_decide = False
    env.runner.cycle()

    assert heartbeat(env)["errors"] == []


def test_poll_failure_keeps_other_products_and_warns(envs):
    env = envs()
    env.add_bot("b2", product=SECOND_PRODUCT)
    btc = FakeMarket()
    btc.fail = True
    env.markets[SECOND_PRODUCT] = btc

    env.runner.cycle()

    assert messages(env.store, "warn")
    assert SECOND_PRODUCT in env.market_asks
    assert PRODUCT in env.market_asks
    assert env.market.best_bid_ask_calls >= 1
    assert env.snapshots.get(PRODUCT) is not None
    assert env.snapshots.get(SECOND_PRODUCT) is None
    assert heartbeat(env)["cycle"] == 1


def test_one_bot_error_does_not_stop_others(envs):
    boom = SpyStrategy(name="boom", init_decision=Decision([]), raise_in_decide=True)
    grid = SpyStrategy(inner=GridStrategy())
    env = envs(
        strategy="boom",
        strategies={"boom": boom, "grid": grid, "rebalance": RebalanceStrategy()},
    )
    env.add_bot(
        "b2",
        strategy="grid",
        capital_quote=D("100"),
        capital_base=D("50"),
        seed=True,
    )

    env.runner.cycle()  # b1's boom init answers nothing, b2 lays its book
    assert len(orders(env.store, "b2")) == 6

    env.runner.cycle()

    errors = messages(env.store, "error")
    assert errors
    assert any(BOT in message or "exploded" in message for message in errors)
    assert grid.decide_calls == 1
    assert len(orders(env.store, "b2")) == 6


# ---------------------------------------------------------------- recenter


def test_recenter_retires_old_opp_todo_rows_and_reinits(envs):
    env = envs()
    env.runner.cycle()
    old_cids = {row["client_order_id"] for row in orders(env.store, BOT)}
    assert len(old_cids) == 6

    fill_a_buy(env.market)
    env.exchange.advance(time.time())
    reconcile(env.store, env.exchange, now=time.time())
    filled = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ]
    assert len(filled) == 1
    assert filled[0]["opposite"] == OPP_TODO

    env.runner.recenter(BOT, "1.1")

    init_since = env.store.get("runner:init_since:b1")
    assert isinstance(init_since, (int, float))

    old = [env.store.order(cid) for cid in old_cids]
    assert env.exchange.list_open_orders(None) == []
    assert not [row for row in old if row["status"] in LIVE_STATUSES]
    assert {row["opposite"] for row in old} == {OPP_SKIPPED}
    assert {row["note"] for row in old} == {"recentered"}

    after = bot_row(env)
    assert D(after["params"]["center"]) == D("1.1")
    assert after["init_done"] is False
    assert after["status"] == ACTIVE

    env.market.set_book(D("1.09"), D("1.10"))
    env.runner.cycle()

    new_rows = [
        row for row in orders(env.store, BOT) if row["client_order_id"] not in old_cids
    ]
    assert len(new_rows) == 6
    assert {row["level"] for row in new_rows} == {-3, -2, -1, 1, 2, 3}
    for row in new_rows:
        assert row["price"] >= RECENTERED_LEVELS[-3]
        assert row["price"] <= RECENTERED_LEVELS[3]
    assert bot_row(env)["init_done"] is True
    # Old fills must never be answered on the new grid.
    assert [
        row for row in orders(env.store, BOT) if row["consumes_fill"] in old_cids
    ] == []


def test_recenter_reinit_ignores_answered_fills_from_old_grid(envs):
    env = envs()
    env.runner.cycle()
    fill_a_buy(env.market)
    env.exchange.advance(time.time())
    reconcile(env.store, env.exchange, now=time.time())
    env.runner.cycle()

    filled = [
        row
        for row in orders(env.store, BOT)
        if row["side"] == "BUY" and row["status"] == FILLED
    ]
    assert len(filled) == 1
    parent = filled[0]["client_order_id"]
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    follow_ups = [row for row in orders(env.store, BOT) if row["consumes_fill"]]
    assert len(follow_ups) == 1
    assert follow_ups[0]["consumes_fill"] == parent

    before = {row["client_order_id"] for row in orders(env.store, BOT)}
    env.runner.recenter(BOT, "1.1")

    init_since = env.store.get("runner:init_since:b1")
    assert isinstance(init_since, (int, float))

    env.market.set_book(D("1.09"), D("1.10"))
    env.runner.cycle()

    # The answered fill belongs to the grid that was replaced, so every level of
    # the new one is laid down, level -1 included.
    new_rows = [
        row
        for row in orders(env.store, BOT)
        if row["client_order_id"] not in before
    ]
    assert len(new_rows) == 6
    assert {(row["side"], row["level"]) for row in new_rows} == {
        ("BUY", -3),
        ("BUY", -2),
        ("BUY", -1),
        ("SELL", 1),
        ("SELL", 2),
        ("SELL", 3),
    }
    assert {row["status"] for row in new_rows} == {OPEN}
    assert bot_row(env)["init_done"] is True


def test_recenter_settle_sweeps_again_each_pass(envs):
    env = envs()
    env.runner.cycle()
    assert len(orders(env.store, BOT, OPEN)) == 6

    real_cancel_all = env.gateway.cancel_all
    sweeps = []

    def first_sweep_misses(scope, owner=None):
        sweeps.append((scope, owner))
        if len(sweeps) == 1:
            return 0  # the first sweep cancels nothing at all
        return real_cancel_all(scope=scope, owner=owner)

    env.gateway.cancel_all = first_sweep_misses

    env.runner.recenter(BOT, "1.1")

    assert len(sweeps) >= 2
    assert all(scope == "owner" and owner == BOT for scope, owner in sweeps)
    assert env.exchange.list_open_orders(None) == []
    assert orders(env.store, BOT, LIVE_STATUSES) == []
    assert D(bot_row(env)["params"]["center"]) == D("1.1")


def test_recenter_restores_prior_status(envs):
    # A bot that was already paused is paused again afterwards, and stays paused
    # while its book is in pieces.
    paused_env = envs()
    paused_env.runner.cycle()
    paused_env.store.set_bot_status(BOT, PAUSED)
    real_cancel_all = paused_env.gateway.cancel_all
    seen = []

    def watching_cancel_all(scope, owner=None):
        seen.append(bot_row(paused_env)["status"])
        return real_cancel_all(scope=scope, owner=owner)

    paused_env.gateway.cancel_all = watching_cancel_all
    paused_env.runner.recenter(BOT, "1.1")

    assert seen
    assert set(seen) == {PAUSED}
    after = bot_row(paused_env)
    assert after["status"] == PAUSED
    assert after["init_done"] is False
    assert D(after["params"]["center"]) == D("1.1")

    # An active bot comes back active.
    active_env = envs()
    active_env.runner.cycle()
    active_env.runner.recenter(BOT, "1.1")
    active = bot_row(active_env)
    assert active["status"] == ACTIVE
    assert active["init_done"] is False
    assert D(active["params"]["center"]) == D("1.1")


def test_recenter_refuses_bad_input_and_changes_nothing(envs):
    env = envs()
    env.runner.cycle()
    env.add_bot("b2", strategy="rebalance", params=REBALANCE_PARAMS)
    before_rows = {
        row["client_order_id"]: (row["status"], row["opposite"])
        for row in orders(env.store, BOT)
    }
    assert len(before_rows) == 6

    with pytest.raises(ValueError):
        env.runner.recenter("nobody", "1.1")
    with pytest.raises(ValueError):
        env.runner.recenter("b2", "1.1")  # a rebalancer has no recenter
    for center in ("0", "-1", "abc", "0.0001"):
        with pytest.raises(ValueError):
            env.runner.recenter(BOT, center)

    env.store.set_bot_status(BOT, STOPPED)
    with pytest.raises(ValueError):
        env.runner.recenter(BOT, "1.1")

    after_rows = {
        row["client_order_id"]: (row["status"], row["opposite"])
        for row in orders(env.store, BOT)
    }
    assert after_rows == before_rows
    assert set(after_rows.values()) == {(OPEN, OPP_TODO)}
    assert D(bot_row(env)["params"]["center"]) == D("1.0")
    assert bot_row(env)["init_done"] is True
    assert bot_row(env)["status"] == STOPPED
    assert len(env.exchange.list_open_orders(None)) == 6
    assert bot_row(env, "b2")["params"]["target_base_pct"] == 50
    assert orders(env.store, "b2") == []


def test_recenter_aborts_when_orders_stay_live(envs):
    env = envs()
    env.runner.cycle()
    assert len(orders(env.store, BOT)) == 6
    sweeps = []

    def never_sweeps(scope, owner=None):
        sweeps.append((scope, owner))
        return 0

    env.gateway.cancel_all = never_sweeps

    with pytest.raises(RuntimeError) as abort:
        env.runner.recenter(BOT, "1.1")

    assert "retry" in str(abort.value).lower()
    assert len(sweeps) == runner_module.RECENTER_SETTLE_TRIES
    assert bot_row(env)["status"] == PAUSED
    assert D(bot_row(env)["params"]["center"]) == D("1.0")
    assert bot_row(env)["init_done"] is True
    assert env.sleeps  # the settle loop waited between tries
    assert len(orders(env.store, BOT)) == 6


def test_recenter_never_wraps_reconcile_in_tx(envs, monkeypatch):
    env = envs()
    env.runner.cycle()
    real_reconcile = runner_module.reconcile
    calls = []

    def wrapper(*args, **kwargs):
        assert not env.store.conn().in_transaction, "reconcile ran inside a tx"
        calls.append(time.time())
        return real_reconcile(*args, **kwargs)

    monkeypatch.setattr(runner_module, "reconcile", wrapper)
    env.runner.recenter(BOT, "1.1")

    assert calls
    assert D(bot_row(env)["params"]["center"]) == D("1.1")


def test_recenter_epoch_uses_wall_clock_not_injected_now(envs):
    env = envs()
    env.runner.cycle()
    assert len(orders(env.store, BOT, OPEN)) == 6

    # The epoch is compared with a row's `created_at`, which the store stamps
    # with the wall clock, so it has to be written on that same clock.  This
    # runner's injected clock says 5000.0 (its settle reconcile is handed that
    # value too), and the epoch must still be the real time.
    on_another_clock = env.new_runner(now=lambda: 5000.0)
    on_another_clock.recenter(BOT, "1.1")

    assert D(bot_row(env)["params"]["center"]) == D("1.1")
    epoch = env.store.get("runner:init_since:b1")
    assert isinstance(epoch, (int, float))
    assert float(epoch) != 5000.0
    assert abs(float(epoch) - time.time()) < 5


# ---------------------------------------------------------------- an idle book


def empty_book(env, owner=BOT):
    """Take every one of this owner's orders off the exchange, and reconcile."""
    order_ids = [
        order["order_id"]
        for order in env.exchange.list_open_orders(None)
        if str(order.get("client_order_id") or "").startswith(f"cb-{owner}-")
    ]
    env.exchange.cancel(order_ids)
    reconcile(env.store, env.exchange, now=time.time())
    assert orders(env.store, owner, LIVE_STATUSES) == []


def idle_alerts(env):
    return [
        message
        for message in messages(env.store, "ALERT")
        if "no live orders" in message
    ]


def test_idle_grid_alerts_once_per_episode(envs):
    env = envs()
    env.runner.cycle()
    assert len(orders(env.store, BOT, LIVE_STATUSES)) == 6
    empty_book(env)

    for _ in range(3):
        env.runner.cycle()

    # One episode, one alert, however many cycles it lasts.
    assert len(idle_alerts(env)) == 1
    assert BOT in idle_alerts(env)[0]
    assert env.store.get(f"runner:idle_book:{BOT}") is True
    # The check reads the stored rows itself: it adds no warning of its own.
    assert [m for m in messages(env.store, "warn") if "client_order_id" in m] == []

    # The book comes back, so the episode is over and the key is cleared.
    env.runner.reinit_bot(BOT)
    env.runner.cycle()
    assert len(orders(env.store, BOT, LIVE_STATUSES)) == 6
    assert env.store.get(f"runner:idle_book:{BOT}") is None
    assert len(idle_alerts(env)) == 1

    # A later emptying is a new episode, and says so once.
    empty_book(env)
    env.runner.cycle()
    env.runner.cycle()
    assert len(idle_alerts(env)) == 2
    assert env.store.get(f"runner:idle_book:{BOT}") is True


def test_idle_alert_skips_a_paused_bot_and_a_rebalancer(envs):
    env = envs()
    env.add_bot("r1", strategy="rebalance", params=REBALANCE_PARAMS)
    env.runner.cycle()
    assert orders(env.store, "r1") == []
    assert bot_row(env, "r1")["status"] == ACTIVE
    assert bot_row(env, "r1")["init_done"] is True

    empty_book(env)
    env.store.set_bot_status(BOT, PAUSED)

    for _ in range(3):
        env.runner.cycle()

    # Neither the paused grid nor the rebalancer (which rests no book at all) is
    # an idle grid, so neither ever alerts.
    assert idle_alerts(env) == []
    assert env.store.get(f"runner:idle_book:{BOT}") is None
    assert env.store.get("runner:idle_book:r1") is None


# ---------------------------------------------------------------- refused follow-ups


def test_refused_follow_up_warns_once_per_fill_and_code(envs):
    env = envs()
    env.runner.cycle()
    parent = answered_buy(env)
    env.store.update_order(parent, opposite=OPP_TODO)

    real_submit = env.gateway.submit
    code = {"value": RATE_CAP}

    def refusing_submit(source, owner, intent, product=None):
        if intent.action == "place" and intent.consumes_fill:
            return GatewayResult(False, None, code["value"])
        return real_submit(source, owner, intent, product)

    env.gateway.submit = refusing_submit

    def refusals():
        return [
            message
            for message in messages(env.store, "warn")
            if "place refused" in message
        ]

    for _ in range(3):
        env.runner.cycle()

    # One fill refused for the same reason three cycles running: said once.
    assert len(refusals()) == 1
    assert RATE_CAP in refusals()[0]
    assert parent in refusals()[0]
    assert env.store.get(f"runner:refused:{parent}") == RATE_CAP
    assert env.store.order(parent)["opposite"] == OPP_TODO
    assert children_of(env, parent) == []

    # A different code is news again, and then silent in its turn.
    code["value"] = STALE_MARKET
    env.runner.cycle()
    assert len(refusals()) == 2
    assert STALE_MARKET in refusals()[1]
    assert env.store.get(f"runner:refused:{parent}") == STALE_MARKET
    env.runner.cycle()
    assert len(refusals()) == 2

    # An acceptance ends the episode and clears the record.
    env.gateway.submit = real_submit
    env.runner.cycle()
    assert env.store.order(parent)["opposite"] == OPP_PLACED
    assert env.store.get(f"runner:refused:{parent}") is None
    assert len(children_of(env, parent, live_only=True)) == 1
    assert len(refusals()) == 2


def test_rebuy_refused_when_only_the_other_bot_has_quote(envs):
    env = envs(
        params={**GRID_PARAMS, "rebuy_sizing": "fixed", "quote_per_buy": "10"},
        capital_quote=D("0"),
        capital_base=D("50"),
    )
    # A second bot on another product holds far more quote than the rebuy below
    # costs, so the exchange is not short of it and an exchange-wide or
    # portfolio-wide funds check would let that order through.
    env.add_bot(
        "b2",
        product=SECOND_PRODUCT,
        capital_quote=D("5000"),
        capital_base=D("0"),
        seed=True,
    )
    env.markets[SECOND_PRODUCT] = FakeMarket()

    env.runner.cycle()
    sells = [row for row in orders(env.store, BOT, OPEN) if row["side"] == "SELL"]
    assert sorted(row["level"] for row in sells) == [1, 2, 3]

    # The level-1 sell partly filled and the rest of it was taken off the book.
    sell = [row for row in sells if row["level"] == 1][0]
    sell_cid = sell["client_order_id"]
    env.exchange.cancel([sell["order_id"]])
    reconcile(env.store, env.exchange, now=time.time())
    assert env.store.order(sell_cid)["status"] == CANCELLED

    filled_size = D("2")
    filled_value = filled_size * sell["price"]
    fees = filled_value * FEE_RATE
    env.store.update_order(
        sell_cid,
        filled_size=filled_size,
        filled_value=filled_value,
        fees=fees,
        opposite=OPP_TODO,
    )
    # The simulated account is credited with the quote the fill produced, so the
    # order answering it is refused for this owner's funds rather than for a
    # short exchange.  The base side is left in that account: the follow-up
    # spends quote, and only a negative unallocated refuses an order.
    env.exchange.deposit(QUOTE, filled_value - fees, "cover the partial fill")

    levels = money.build_levels(D("1"), D("1.5"), 3, 3, SPEC)
    plan, why = money.opposite_order(
        money.SELL,
        1,
        filled_size,
        filled_value - fees,
        levels,
        FEE_RATE,
        SPEC,
        "fixed",
        D("10"),
    )
    assert why is None and plan is not None
    assert (plan.side, plan.level) == (money.BUY, 0)
    placed_price = money.maker_price(
        plan.side, plan.price, env.market.bid, env.market.ask, SPEC.price_increment
    )
    cost = money.buy_cost(plan.size, placed_price, FEE_RATE)
    own = env.gateway.ledger.holding(BOT, PRODUCT)
    other = env.gateway.ledger.holding("b2", SECOND_PRODUCT)
    assert cost > own.available_quote
    assert cost < other.available_quote

    rows_before = {
        row["client_order_id"]: (row["status"], row["opposite"], row["consumes_fill"])
        for row in orders(env.store, BOT)
    }

    env.runner.cycle()
    env.runner.cycle()

    # The fixed rebuy is too big for this bot's own free quote: no order row was
    # written, the fill is still waiting for its opposite order, and the refusal
    # says which bot it was.
    assert {
        row["client_order_id"]: (row["status"], row["opposite"], row["consumes_fill"])
        for row in orders(env.store, BOT)
    } == rows_before
    assert env.store.order(sell_cid)["opposite"] == OPP_TODO
    assert children_of(env, sell_cid) == []

    refusals = [
        message
        for message in messages(env.store, "warn")
        if "place refused" in message
    ]
    assert len(refusals) == 1
    assert refusals[0].startswith(f"bot {BOT}: ")
    assert INSUFFICIENT_HOLDING in refusals[0]
    assert sell_cid in refusals[0]

    # The other bot never paid for any of it.
    assert env.gateway.ledger.holding("b2", SECOND_PRODUCT) == other

    # The rest of the sell fills, so this bot now holds the quote the rebuy asks
    # for: the same order goes out on the next cycle and the fill is retired.
    full_size = sell["size"]
    full_value = full_size * sell["price"]
    full_fees = full_value * FEE_RATE
    env.store.update_order(
        sell_cid,
        filled_size=full_size,
        filled_value=full_value,
        fees=full_fees,
    )
    env.exchange.deposit(
        QUOTE,
        (full_value - full_fees) - (filled_value - fees),
        "cover the rest of the fill",
    )
    assert env.gateway.ledger.holding(BOT, PRODUCT).available_quote > cost

    env.runner.cycle()

    children = children_of(env, sell_cid)
    assert len(children) == 1
    assert (children[0]["side"], children[0]["level"]) == (money.BUY, 0)
    assert children[0]["status"] == OPEN
    assert env.store.order(sell_cid)["opposite"] == OPP_PLACED
    assert env.store.get(f"runner:refused:{sell_cid}") is None
    assert len(orders(env.store, BOT)) == len(rows_before) + 1


# ---------------------------------------------------------------- the loop


def test_run_forever_survives_cycle_errors_and_stops(envs):
    env = envs()
    stop = threading.Event()
    calls = []

    def flaky_cycle():
        calls.append(1)
        if len(calls) <= 4 or 5 < len(calls) <= 9:
            raise RuntimeError(f"cycle {len(calls)} exploded")
        if len(calls) == 10:
            stop.set()
        return {"cycle": 99, "bots_active": 0}

    env.runner.cycle = flaky_cycle
    # The good cycle at call 5 resets the running count, so the four failures
    # after it are not a fifth consecutive one.
    env.runner.run_forever(poll_seconds=0, stop=stop)

    assert len(calls) == 10
    errors = messages(env.store, "error")
    assert len(errors) == 8
    assert all("exploded" in message for message in errors)

    already = threading.Event()
    already.set()
    calls.clear()
    env.runner.run_forever(poll_seconds=0, stop=already)
    assert calls == []


def test_run_forever_raises_after_five_consecutive_failures(envs):
    class CycleBoom(RuntimeError):
        """What one failing cycle raises here."""

    env = envs()
    stop = threading.Event()
    calls = []

    def always_failing():
        calls.append(1)
        # A runner without the failure limit would loop here for ever; setting
        # stop lets it leave the loop so the raises assertion below fails.
        if len(calls) >= 50:
            stop.set()
        raise CycleBoom(f"cycle {len(calls)} exploded")

    env.runner.cycle = always_failing

    with pytest.raises(CycleBoom):
        env.runner.run_forever(poll_seconds=0, stop=stop)

    assert len(calls) == 5
    # Every failure is recorded, the fifth one included, before the raise.
    errors = messages(env.store, "error")
    assert len(errors) == 5
    assert any("cycle 5 exploded" in message for message in errors)


# ---------------------------------------------------------------- static guard


def test_runner_module_has_no_exchange_writes():
    source = (SRC / "runner.py").read_text(encoding="utf-8")
    assert "place_limit" not in source
    assert "limit_order_gtc" not in source