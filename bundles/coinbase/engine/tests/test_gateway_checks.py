"""gateway.py: the read-only check chain, the snapshot cache and cancel ownership.

Every test runs on the real wall clock: `store.insert_order` stamps `created_at`
with `time.time()`, so the `CapWindow` is built with the same clock and the
snapshots are stamped with it too.  Staleness gets an explicit older timestamp
instead of a fake clock.

The gateway holds an `exchange` for Task 3c; `check()` must never call it, so a
`RecordingExchange` records any attribute access and every refusal asserts the
list is still empty.
"""

import time
from decimal import Decimal as D

import pytest

from crow_coinbase.gateway import (
    BAD_INTENT,
    CLOCK_SKEW,
    DAILY_CAP,
    DRAWDOWN_STOP,
    HALTED,
    INSUFFICIENT_HOLDING,
    LIVE_DISABLED,
    NOT_OWNER,
    ORDER_TOO_LARGE,
    OWNER_PAUSED,
    PORTFOLIO_OWNER,
    PRODUCT_NOT_ALLOWED,
    RATE_CAP,
    STALE_MARKET,
    TOO_SMALL,
    UNALLOCATED_NEGATIVE,
    OrderGateway,
)
from crow_coinbase.ledger import Ledger
from crow_coinbase.limits import CapWindow, Limits
from crow_coinbase.money import ProductSpec
from crow_coinbase.snapshot import SnapshotCache
from crow_coinbase.store import ACTIVE, CANCELLED, OPEN, PAUSED, STOPPED, Store
from crow_coinbase.strategies.base import MarketSnapshot, OrderIntent

PRODUCT = "XRP-USDC"
QUOTE = "USDC"
BASE = "XRP"

SPEC = ProductSpec(
    PRODUCT,
    price_increment=D("0.0001"),
    base_increment=D("0.1"),
    quote_increment=D("0.01"),
    base_min_size=D("1"),
    quote_min_size=D("1"),
)

BID = D("0.99")
ASK = D("1.00")
MID = (BID + ASK) / 2
FEE_RATE = D("0.005")

# limits env names (values are the strings Limits.from_env parses)
POLL = "CROW_COINBASE_POLL_SECONDS"
PRODUCTS = "CROW_COINBASE_PRODUCTS"
DAILY = "CROW_COINBASE_DAILY_NOTIONAL_USD"
ORDERS_HOUR = "CROW_COINBASE_ORDERS_PER_HOUR"

POLL_SECONDS = 60  # the default, and what the staleness window below assumes


# ---------------------------------------------------------------- harness


class RecordingExchange:
    """Any attribute access records its name; check() must leave the list empty."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append(name)
            return None

        return record


def store_at(
    path,
    *,
    capital_quote=D("100"),
    capital_base=D("50"),
    params=None,
    bot_id="b1",
):
    """A store with one ACTIVE bot on XRP-USDC."""
    s = Store(path)
    s.create_bot(bot_id, PRODUCT, "grid", params or {}, D(capital_quote), D(capital_base))
    return s


@pytest.fixture
def store(tmp_path):
    s = store_at(tmp_path / "s.db")
    yield s
    s.close()


@pytest.fixture
def make_store(tmp_path):
    """Extra stores (other capital budgets) closed when the test ends."""
    created = []

    def build(name, **kwargs):
        s = store_at(tmp_path / name, **kwargs)
        created.append(s)
        return s

    yield build
    for s in created:
        s.close()


def default_totals():
    """Exchange totals that match b1's capital exactly (unallocated 0)."""
    return {QUOTE: D("100"), BASE: D("50")}


def snapshot(ts=None, *, bid=BID, ask=ASK, low=D("0.9"), high=D("1.1"), product=PRODUCT):
    return MarketSnapshot(
        product=product,
        bid=bid,
        ask=ask,
        low=low,
        high=high,
        ts=time.time() if ts is None else ts,
    )


def cache_with(*snaps, skew=0.0):
    """A cache holding *snaps*; skew=None leaves the clock unset (unknown)."""
    cache = SnapshotCache()
    for snap in snaps:
        cache.put(snap)
    if skew is not None:
        cache.set_clock(100.0 + skew, 100.0)  # server - local == skew
    return cache


def ready_cache(*, skew=0.0, ts=None):
    return cache_with(snapshot(ts), skew=skew)


def make_gateway(
    store,
    *,
    env=None,
    snapshots=None,
    caps=None,
    ledger=None,
    exchange=None,
    now=time.time,
    totals=None,
    **overrides,
):
    kwargs = dict(
        store=store,
        ledger=Ledger(store, fee_rate=FEE_RATE) if ledger is None else ledger,
        limits=Limits.from_env(env or {}),
        caps=CapWindow(store, time.time) if caps is None else caps,
        snapshots=ready_cache() if snapshots is None else snapshots,
        spec_for=lambda product: SPEC,
        fee_rate=FEE_RATE,
        totals=default_totals if totals is None else totals,
        exchange=exchange,
        now=now,
    )
    kwargs.update(overrides)
    return OrderGateway(**kwargs)


def intent(**overrides):
    fields = dict(
        action="place",
        side="BUY",
        size=D("10"),
        limit_price=D("0.95"),
        level=-1,
        cancel_cid=None,
        reason="test",
    )
    fields.update(overrides)
    return OrderIntent(**fields)


def place(side="BUY", size=D("10"), price=D("0.95"), level=-1):
    return intent(action="place", side=side, size=size, limit_price=price, level=level)


def cancel(cid):
    return intent(
        action="cancel",
        side=None,
        size=None,
        limit_price=None,
        level=None,
        cancel_cid=cid,
    )


def seed_order(
    store,
    owner="b1",
    source="bot",
    status=OPEN,
    price=D("0.95"),
    size=D("10"),
    cid_suffix=1,
    side="BUY",
    product=PRODUCT,
    level=-1,
):
    """Insert a local order row the engine's own way (`cb-<owner>-...` id)."""
    cid = f"cb-{owner}-B0-{cid_suffix:012x}"
    store.insert_order(
        cid,
        owner,
        source,
        product,
        side,
        level,
        price,
        size,
        status=status,
    )
    return cid


# ---------------------------------------------------------------- snapshot cache


def test_snapshot_cache_put_get_latest_wins():
    cache = SnapshotCache()
    first = snapshot()
    cache.put(first)
    assert cache.get(PRODUCT) == first

    later = snapshot(bid=D("0.98"), ask=D("0.995"))
    cache.put(later)

    assert cache.get(PRODUCT) == later
    assert cache.get(PRODUCT).bid == D("0.98")
    assert cache.get(PRODUCT).ask == D("0.995")
    assert cache.get(PRODUCT) != first

    other = snapshot(bid=D("10"), ask=D("11"), product="BTC-USDC")
    cache.put(other)
    assert cache.get("BTC-USDC") == other
    assert cache.get(PRODUCT) == later


def test_snapshot_cache_unknown_product_is_none():
    cache = SnapshotCache()
    cache.put(snapshot())

    assert cache.get("BTC-USDC") is None
    assert cache.get("") is None

    empty = SnapshotCache()
    assert empty.get(PRODUCT) is None


def test_snapshot_skew_none_until_clock_set():
    cache = SnapshotCache()
    cache.put(snapshot())

    assert cache.skew_s() is None

    cache.set_clock(105.0, 100.0)
    assert cache.skew_s() == 5.0


def test_snapshot_set_clock_skew_value():
    cache = SnapshotCache()

    cache.set_clock(105.0, 100.0)  # the server is 5 s ahead
    assert cache.skew_s() == 5.0

    cache.set_clock(100.0, 106.0)  # ... and 6 s behind
    assert cache.skew_s() == -6.0


# ---------------------------------------------------------------- place: the chain


def test_place_happy_path_returns_none(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    assert gw.check("bot", "b1", place()) is None
    assert exchange.calls == []


BAD_INTENTS = (
    ("missing_side", intent(side=None)),
    ("missing_size", intent(size=None)),
    ("missing_price", intent(limit_price=None)),
    ("zero_size", intent(size=D("0"))),
    ("negative_size", intent(size=D("-10"))),
    ("zero_price", intent(limit_price=D("0"))),
    ("unknown_action", intent(action="hold")),
)


@pytest.mark.parametrize("case,bad", BAD_INTENTS, ids=[c[0] for c in BAD_INTENTS])
def test_bad_intent(store, case, bad):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    assert gw.check("bot", "b1", bad) == BAD_INTENT
    assert exchange.calls == []
    assert store.orders() == []


def test_halted(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange, is_halted=lambda: True)

    assert gw.check("bot", "b1", place()) == HALTED
    assert exchange.calls == []
    assert store.orders() == []
    assert store.hwm("b1") is None


def test_live_disabled(store):
    exchange = RecordingExchange()

    live = make_gateway(
        store, exchange=exchange, route_for=lambda owner: "live", live_enabled=False
    )
    assert live.check("bot", "b1", place()) == LIVE_DISABLED
    assert exchange.calls == []

    # The same intent on the same live route passes that check once enabled.
    live_ok = make_gateway(
        store, exchange=exchange, route_for=lambda owner: "live", live_enabled=True
    )
    assert live_ok.check("bot", "b1", place()) is None

    dry = make_gateway(store, exchange=exchange, route_for=lambda owner: "dry")
    assert dry.check("bot", "b1", place()) is None

    # The default route is dry even with live disabled.
    default = make_gateway(store, exchange=exchange)
    assert default.check("bot", "b1", place()) is None
    assert exchange.calls == []


def test_product_not_allowed(store):
    exchange = RecordingExchange()

    not_listed = make_gateway(store, env={PRODUCTS: "BTC-USDC"}, exchange=exchange)
    assert not_listed.check("bot", "b1", place()) == PRODUCT_NOT_ALLOWED

    # A product given for a bot owner must match the bot row's own product.
    other = make_gateway(
        store, env={PRODUCTS: "XRP-USDC,ETH-USDC"}, exchange=exchange
    )
    assert (
        other.check("bot", "b1", place(), product="ETH-USDC") == PRODUCT_NOT_ALLOWED
    )

    # "ai" has no bot row, so the product has to be given; without one it cannot
    # be resolved at all.
    no_row = make_gateway(store, exchange=exchange)
    assert no_row.check("ai", "ai", place()) == PRODUCT_NOT_ALLOWED

    assert exchange.calls == []
    assert store.orders() == []


def test_owner_paused(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    store.set_bot_status("b1", PAUSED)
    assert gw.check("bot", "b1", place()) == OWNER_PAUSED

    store.set_bot_status("b1", STOPPED)
    assert gw.check("bot", "b1", place()) == OWNER_PAUSED

    store.set_bot_status("b1", ACTIVE)
    assert gw.check("bot", "b1", place()) is None

    # A bot source with no bot row at all is refused the same way.
    assert gw.check("bot", "ghost", place(), product=PRODUCT) == OWNER_PAUSED

    assert exchange.calls == []


def test_stale_market(store):
    exchange = RecordingExchange()

    env = {POLL: str(POLL_SECONDS)}
    window = 2 * POLL_SECONDS

    stale = make_gateway(
        store,
        env=env,
        snapshots=cache_with(snapshot(time.time() - window - 80)),
        exchange=exchange,
    )
    assert stale.check("bot", "b1", place()) == STALE_MARKET

    # The clock is set, the product has no snapshot at all.
    missing = make_gateway(
        store, env=env, snapshots=cache_with(skew=0.0), exchange=exchange
    )
    assert missing.check("bot", "b1", place()) == STALE_MARKET

    # Just inside 2 * poll_seconds.
    inside = make_gateway(
        store,
        env=env,
        snapshots=cache_with(snapshot(time.time() - window + 2)),
        exchange=exchange,
    )
    assert inside.check("bot", "b1", place()) is None

    assert exchange.calls == []
    assert store.orders() == []


def test_clock_skew(store):
    exchange = RecordingExchange()

    ahead = make_gateway(store, snapshots=ready_cache(skew=6.0), exchange=exchange)
    assert ahead.check("bot", "b1", place()) == CLOCK_SKEW

    behind = make_gateway(store, snapshots=ready_cache(skew=-6.0), exchange=exchange)
    assert behind.check("bot", "b1", place()) == CLOCK_SKEW

    edge = make_gateway(store, snapshots=ready_cache(skew=5.0), exchange=exchange)
    assert edge.check("bot", "b1", place()) is None

    unknown = make_gateway(store, snapshots=ready_cache(skew=None), exchange=exchange)
    assert unknown.check("bot", "b1", place()) == CLOCK_SKEW

    assert exchange.calls == []


def test_too_small(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # Below base_min_size (1 base unit).
    assert gw.check("bot", "b1", place(size=D("0.5"))) == TOO_SMALL
    # At base_min_size but 1 * 0.95 = 0.95 quote, under quote_min_size (1).
    assert gw.check("bot", "b1", place(size=D("1"))) == TOO_SMALL
    # 2 * 0.95 = 1.9 clears both minimums.
    assert gw.check("bot", "b1", place(size=D("2"))) is None

    assert exchange.calls == []


def test_order_too_large_bot(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # 60 * 0.95 = 57 > bot_max_order_usd (50).
    assert gw.check("bot", "b1", place(size=D("60"))) == ORDER_TOO_LARGE
    # 50 * 0.95 = 47.5 is inside it.
    assert gw.check("bot", "b1", place(size=D("50"))) is None

    assert exchange.calls == []


def test_daily_cap_global(store):
    exchange = RecordingExchange()
    seed_order(store, price=D("195"), size=D("1"), status=CANCELLED)  # 195 today

    caps = CapWindow(store, time.time)
    assert caps.daily_notional(None) == D("195")

    gw = make_gateway(store, caps=caps, exchange=exchange)
    # 195 + 10 * 0.95 = 204.5 > daily_notional_usd (200).
    assert gw.check("bot", "b1", place()) == DAILY_CAP

    assert exchange.calls == []


def test_daily_cap_boundary_is_exclusive_of_equal(store):
    exchange = RecordingExchange()
    seed_order(store, price=D("190.5"), size=D("1"), status=CANCELLED)  # 190.5 today

    caps = CapWindow(store, time.time)
    gw = make_gateway(store, caps=caps, exchange=exchange)

    # 190.5 + 9.5 == 200 exactly: the cap refuses only what is over it.
    assert caps.daily_notional(None) + D("9.5") == D("200")
    assert gw.check("bot", "b1", place()) is None

    seed_order(store, price=D("0.01"), size=D("1"), status=CANCELLED, cid_suffix=2)
    assert caps.daily_notional(None) == D("190.51")
    # 190.51 + 9.5 = 200.01, one cent over.
    assert gw.check("bot", "b1", place()) == DAILY_CAP

    assert exchange.calls == []


def test_rate_cap_global(store):
    exchange = RecordingExchange()
    for n in range(1, 4):  # three orders inside the rolling hour
        seed_order(store, price=D("0.01"), size=D("1"), cid_suffix=n)

    caps = CapWindow(store, time.time)
    assert caps.orders_last_hour(None) == 3

    # Lowered from the default 30 so the test stays small.
    gw = make_gateway(store, env={ORDERS_HOUR: "3"}, caps=caps, exchange=exchange)
    assert gw.check("bot", "b1", place()) == RATE_CAP

    assert exchange.calls == []


def test_insufficient_holding_buy_includes_fee(make_store):
    exchange = RecordingExchange()
    s = make_store("fee.db", capital_quote=D("10"), capital_base=D("0"))
    gw = make_gateway(
        s, exchange=exchange, totals=lambda: {QUOTE: D("10"), BASE: D("0")}
    )

    # 10.5 * 0.95 = 9.975 fits the 10 quote without the fee;
    # 9.975 * 1.005 = 10.024875 does not fit with it.
    assert gw.check("bot", "b1", place(size=D("10.5"))) == INSUFFICIENT_HOLDING
    # 10 * 0.95 * 1.005 = 9.5475 stays inside the same budget.
    assert gw.check("bot", "b1", place(size=D("10"))) is None

    assert exchange.calls == []
    assert s.orders() == []


def test_insufficient_holding_sell(make_store):
    exchange = RecordingExchange()
    s = make_store("sell.db", capital_quote=D("0"), capital_base=D("10"))
    gw = make_gateway(
        s, exchange=exchange, totals=lambda: {QUOTE: D("0"), BASE: D("10")}
    )

    # A sell rests at max(0.95, bid + tick) = 0.9901, so 20 base is 19.802 quote
    # (inside the 50 order cap) but 20 > the 10 base the owner holds.
    assert gw.check("bot", "b1", place(side="SELL", size=D("20"))) == (
        INSUFFICIENT_HOLDING
    )
    assert gw.check("bot", "b1", place(side="SELL", size=D("10"))) is None

    assert exchange.calls == []
    assert s.orders() == []


def test_unallocated_negative_refuses_buys_not_sells(store):
    exchange = RecordingExchange()

    def short():
        """10 quote less than b1 holds."""
        return {QUOTE: D("90"), BASE: D("50")}

    gw = make_gateway(store, exchange=exchange, totals=short)
    assert gw.check("bot", "b1", place()) == UNALLOCATED_NEGATIVE
    assert exchange.calls == []

    # The same short exchange does not stop a sell.
    assert gw.check("bot", "b1", place(side="SELL", size=D("10"))) is None

    # With matching totals the same buy is allowed.
    balanced = make_gateway(store, exchange=exchange)
    assert balanced.check("bot", "b1", place()) is None


def test_drawdown_stop_bot(make_store):
    exchange = RecordingExchange()
    params = {"drawdown_pct": 10}
    equity = D("100") + D("50") * MID  # quote + base at the mid price

    stopped = make_store("dd-bot.db", params=params)
    gw = make_gateway(stopped, exchange=exchange)
    stopped.update_hwm("b1", D("200"))  # 200 * (1 - 10/100) = 180 > equity
    assert gw.check("bot", "b1", place()) == DRAWDOWN_STOP
    assert stopped.hwm("b1") == D("200")  # the mark is read, never ratcheted
    assert exchange.calls == []

    # equity == hwm is above the threshold, so the same intent passes.
    running = make_store("dd-bot-ok.db", params=params)
    gw_ok = make_gateway(running, exchange=exchange)
    running.update_hwm("b1", equity)
    assert gw_ok.check("bot", "b1", place()) is None

    assert running.hwm("b1") == equity
    assert exchange.calls == []
    assert stopped.orders() == []
    assert running.orders() == []


def test_drawdown_stop_portfolio(make_store):
    exchange = RecordingExchange()
    s = make_store("dd-pf.db")
    gw = make_gateway(s, exchange=exchange)

    equity = D("100") + D("50") * MID
    assert gw.portfolio_equity() == equity

    # equity == the portfolio high-water mark is above the 20% threshold.
    s.update_hwm(PORTFOLIO_OWNER, equity)
    assert gw.check("bot", "b1", place()) is None

    # A mark of 200 puts the threshold at 160, above the 149.75 equity.
    s.update_hwm(PORTFOLIO_OWNER, D("200"))
    assert gw.check("bot", "b1", place()) == DRAWDOWN_STOP
    assert s.hwm(PORTFOLIO_OWNER) == D("200")

    assert exchange.calls == []
    assert s.orders() == []


def test_check_is_read_only(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)
    store.update_hwm("b1", D("150"))

    orders_before = store.orders()
    hwm_before = store.hwm("b1")
    count_before = store.conn().execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    assert store.hwm(PORTFOLIO_OWNER) is None

    assert gw.check("bot", "b1", place()) is None
    assert gw.check("bot", "b1", place(size=D("0.5"))) == TOO_SMALL
    assert gw.check("bot", "b1", place(size=D("60"))) == ORDER_TOO_LARGE

    assert store.orders() == orders_before
    assert store.hwm("b1") == hwm_before == D("150")
    assert store.hwm(PORTFOLIO_OWNER) is None
    assert store.conn().execute("SELECT COUNT(*) FROM orders").fetchone()[0] == (
        count_before
    )

    # A drawdown refusal writes nothing either.
    store.update_hwm("b1", D("1000"))
    orders_before = store.orders()
    assert gw.check("bot", "b1", place()) == DRAWDOWN_STOP
    assert store.orders() == orders_before
    assert store.hwm("b1") == D("1000")
    assert exchange.calls == []


# ---------------------------------------------------------------- cancel


def test_cancel_own_order_allowed(store):
    exchange = RecordingExchange()
    cid = seed_order(store, "b1", "bot", OPEN, D("0.95"), D("10"), 1)
    gw = make_gateway(store, exchange=exchange)

    assert gw.check("bot", "b1", cancel(cid)) is None
    # check() never cancels anything itself.
    assert store.order(cid)["status"] == OPEN
    assert exchange.calls == []


def test_cancel_other_bots_order_refused(store):
    exchange = RecordingExchange()
    store.create_bot("b2", PRODUCT, "grid", {}, D("100"), D("50"))
    cid = seed_order(store, "b2", "bot", OPEN, D("0.95"), D("10"), 1)
    gw = make_gateway(store, exchange=exchange)

    assert gw.check("bot", "b1", cancel(cid)) == NOT_OWNER
    assert gw.check("bot", "b2", cancel(cid)) is None
    assert exchange.calls == []


def test_cancel_non_cb_order_refused(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # A row that exists but carries no `cb-<owner>-` id: insert_order refuses
    # such an id, so the row goes in with raw SQL.
    now = time.time()
    store.conn().execute(
        "INSERT INTO orders(client_order_id,order_id,owner,source,product,side,"
        "level,price,size,status,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "api-1234",
            None,
            "b1",
            "bot",
            PRODUCT,
            "BUY",
            -1,
            "0.95",
            "10",
            OPEN,
            now,
            now,
        ),
    )
    assert store.order("api-1234")["owner"] == "b1"
    assert gw.check("bot", "b1", cancel("api-1234")) == NOT_OWNER

    # And one that is not in the store at all.
    assert gw.check("bot", "b1", cancel("made-up-order")) == NOT_OWNER

    assert exchange.calls == []


def test_cancel_unknown_order_refused(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # Right prefix for the owner, no such row.
    assert gw.check("bot", "b1", cancel("cb-b1-B0-ffffffffffff")) == NOT_OWNER
    assert store.orders() == []
    assert exchange.calls == []


def test_cancel_skips_halt_and_caps(store):
    exchange = RecordingExchange()
    cid = seed_order(store, "b1", "bot", OPEN, D("0.95"), D("10"), 1)
    for n in range(2, 5):
        seed_order(store, price=D("0.01"), size=D("1"), cid_suffix=n)

    halted = make_gateway(
        store,
        env={ORDERS_HOUR: "1"},
        exchange=exchange,
        is_halted=lambda: True,
        route_for=lambda owner: "live",
        live_enabled=False,
    )
    assert halted.check("bot", "b1", place()) == HALTED
    assert halted.check("bot", "b1", cancel(cid)) is None

    # Without the halt the place is over the rate cap, the cancel still is not.
    open_gate = make_gateway(store, env={ORDERS_HOUR: "1"}, exchange=exchange)
    assert open_gate.check("bot", "b1", place()) == RATE_CAP
    assert open_gate.check("bot", "b1", cancel(cid)) is None

    assert store.order(cid)["status"] == OPEN
    assert exchange.calls == []


# ---------------------------------------------------------------- ai caps


def test_ai_uses_ai_caps(store, make_store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # 40 * 0.95 = 38: over ai_max_order_usd (25), inside bot_max_order_usd (50).
    ai_big = place(size=D("40"))
    assert gw.check("ai", "ai", ai_big, product=PRODUCT) == ORDER_TOO_LARGE
    assert gw.check("bot", "b1", ai_big) is None
    assert exchange.calls == []

    # The ai daily cap (50) trips from ai orders while the global cap (200) is far.
    daily = make_store("ai-daily.db")
    seed_order(daily, "ai", "ai", OPEN, D("41"), D("1"), 1)  # 41 of ai notional
    daily_caps = CapWindow(daily, time.time)
    gw_daily = make_gateway(daily, caps=daily_caps, exchange=exchange)
    assert daily_caps.daily_notional(None) == D("41")
    assert daily_caps.daily_notional("ai") == D("41")
    # 41 + 9.5 = 50.5 > 50.
    assert gw_daily.check("ai", "ai", place(), product=PRODUCT) == DAILY_CAP

    # Bot-source orders spend the global budget but not the ai one.
    mixed = make_store("ai-mixed.db")
    seed_order(mixed, "b1", "bot", OPEN, D("60"), D("1"), 1)
    mixed_caps = CapWindow(mixed, time.time)
    gw_mixed = make_gateway(mixed, caps=mixed_caps, exchange=exchange)
    assert mixed_caps.daily_notional("ai") == D("0")
    assert mixed_caps.daily_notional(None) == D("60")
    # 60 + 9.5 = 69.5 is under the global cap, so the first refusal is the ai
    # owner's empty holding.
    assert gw_mixed.check("ai", "ai", place(), product=PRODUCT) == (
        INSUFFICIENT_HOLDING
    )

    # ... while a global cap spent by bots, at the edge, does stop an ai order.
    spent = make_store("ai-global.db")
    seed_order(spent, "b1", "bot", OPEN, D("195"), D("1"), 1)
    spent_caps = CapWindow(spent, time.time)
    gw_spent = make_gateway(spent, caps=spent_caps, exchange=exchange)
    assert spent_caps.daily_notional("ai") == D("0")
    # 195 + 9.5 = 204.5 > 200.
    assert gw_spent.check("ai", "ai", place(), product=PRODUCT) == DAILY_CAP

    # The ai orders-per-hour cap (10) trips on the 11th, with the global one (30)
    # nowhere near it.
    hourly = make_store("ai-hour.db")
    for n in range(1, 11):
        seed_order(hourly, "ai", "ai", OPEN, D("1"), D("1"), n)
    hourly_caps = CapWindow(hourly, time.time)
    gw_hourly = make_gateway(hourly, caps=hourly_caps, exchange=exchange)
    assert hourly_caps.orders_last_hour("ai") == 10
    assert hourly_caps.orders_last_hour(None) == 10
    assert hourly_caps.daily_notional(None) == D("10")
    assert gw_hourly.check("ai", "ai", place(), product=PRODUCT) == RATE_CAP

    assert exchange.calls == []


# ---------------------------------------------------------------- chain order


def _chain_halted_live(store, make_store):
    exchange = RecordingExchange()
    gw = make_gateway(
        store,
        exchange=exchange,
        is_halted=lambda: True,
        route_for=lambda owner: "live",
        live_enabled=False,
    )
    return gw, place(), None, exchange


def _chain_live_product(store, make_store):
    exchange = RecordingExchange()
    gw = make_gateway(
        store,
        env={PRODUCTS: "BTC-USDC"},
        exchange=exchange,
        route_for=lambda owner: "live",
        live_enabled=False,
    )
    return gw, place(), None, exchange


def _chain_product_paused(store, make_store):
    exchange = RecordingExchange()
    store.set_bot_status("b1", PAUSED)
    gw = make_gateway(store, env={PRODUCTS: "BTC-USDC"}, exchange=exchange)
    return gw, place(), None, exchange


def _chain_paused_stale(store, make_store):
    exchange = RecordingExchange()
    store.set_bot_status("b1", PAUSED)
    gw = make_gateway(
        store, snapshots=ready_cache(ts=time.time() - 10_000), exchange=exchange
    )
    return gw, place(), None, exchange


def _chain_stale_skew(store, make_store):
    exchange = RecordingExchange()
    cache = SnapshotCache()  # no set_clock(): the skew stays unknown
    cache.put(snapshot(time.time() - 10_000))
    gw = make_gateway(store, snapshots=cache, exchange=exchange)
    return gw, place(), None, exchange


def _chain_skew_too_small(store, make_store):
    exchange = RecordingExchange()
    gw = make_gateway(store, snapshots=ready_cache(skew=6.0), exchange=exchange)
    return gw, place(size=D("0.5")), None, exchange


def _chain_large_daily(store, make_store):
    exchange = RecordingExchange()
    seed_order(store, price=D("195"), size=D("1"), status=CANCELLED)
    gw = make_gateway(store, exchange=exchange)
    # 100 * 0.95 = 95: over the 50 order cap and over the 200 daily cap.
    return gw, place(size=D("100")), None, exchange


def _chain_daily_rate(store, make_store):
    exchange = RecordingExchange()
    seed_order(store, price=D("195"), size=D("1"), status=CANCELLED, cid_suffix=1)
    for n in range(2, 4):
        seed_order(store, price=D("0.01"), size=D("1"), cid_suffix=n)
    gw = make_gateway(store, env={ORDERS_HOUR: "1"}, exchange=exchange)
    # 195.02 + 9.5 = 204.52 over the daily cap, and 3 + 1 over the rate cap.
    return gw, place(), None, exchange


def _chain_rate_holding(store, make_store):
    exchange = RecordingExchange()
    s = make_store("chain-rate.db", capital_quote=D("10"), capital_base=D("0"))
    for n in range(1, 3):
        seed_order(s, price=D("0.01"), size=D("1"), cid_suffix=n)
    gw = make_gateway(
        s,
        env={ORDERS_HOUR: "2"},
        exchange=exchange,
        totals=lambda: {QUOTE: D("10"), BASE: D("0")},
    )
    # 10.5 * 0.95 * 1.005 = 10.024875 of a 10 quote budget, and 2 + 1 over the
    # rate cap.
    return gw, place(size=D("10.5")), None, exchange


def _chain_holding_unallocated(store, make_store):
    exchange = RecordingExchange()
    s = make_store("chain-hold.db", capital_quote=D("10"), capital_base=D("0"))
    gw = make_gateway(
        s, exchange=exchange, totals=lambda: {QUOTE: D("5"), BASE: D("0")}
    )
    # Cost with fee is 10.024875 against 10, and the exchange is 5 quote short.
    return gw, place(size=D("10.5")), None, exchange


def _chain_unallocated_drawdown(store, make_store):
    exchange = RecordingExchange()
    store.update_hwm("b1", D("1000"))  # equity 149.75 is deep under 900
    gw = make_gateway(
        store,
        exchange=exchange,
        totals=lambda: {QUOTE: D("90"), BASE: D("50")},  # 10 quote short
    )
    return gw, place(), None, exchange


CHAIN_CASES = (
    ("halted_before_live_disabled", _chain_halted_live, HALTED),
    ("live_disabled_before_product", _chain_live_product, LIVE_DISABLED),
    ("product_before_owner_paused", _chain_product_paused, PRODUCT_NOT_ALLOWED),
    ("owner_paused_before_stale", _chain_paused_stale, OWNER_PAUSED),
    ("stale_before_skew", _chain_stale_skew, STALE_MARKET),
    ("skew_before_too_small", _chain_skew_too_small, CLOCK_SKEW),
    ("too_large_before_daily", _chain_large_daily, ORDER_TOO_LARGE),
    ("daily_before_rate", _chain_daily_rate, DAILY_CAP),
    ("rate_before_holding", _chain_rate_holding, RATE_CAP),
    ("holding_before_unallocated", _chain_holding_unallocated, INSUFFICIENT_HOLDING),
    ("unallocated_before_drawdown", _chain_unallocated_drawdown, UNALLOCATED_NEGATIVE),
)


@pytest.mark.parametrize(
    "case,setup,expected", CHAIN_CASES, ids=[c[0] for c in CHAIN_CASES]
)
def test_chain_order_first_failure_wins(store, make_store, case, setup, expected):
    gw, intent_, product, exchange = setup(store, make_store)

    assert gw.check("bot", "b1", intent_, product=product) == expected
    assert exchange.calls == []


# ---------------------------------------------------------------- maker pricing


def test_caps_use_maker_price(store):
    exchange = RecordingExchange()
    gw = make_gateway(store, exchange=exchange)

    # (a) A buy at level 1.50 rests at min(1.50, ask - tick) = 0.9999, so 40 is
    # 39.996 of notional: inside the 50 bot cap, where a naive 1.50 * 40 = 60 is not.
    resting_buy = place(size=D("40"), price=D("1.50"))
    assert gw.check("bot", "b1", resting_buy) is None
    assert D("1.50") * D("40") > D("50")

    # (b) A sell at level 0.50 rests at max(0.50, bid + tick) = 0.9901, so 55 is
    # 54.4555: over the 50 cap, where a naive 0.50 * 55 = 27.5 is under it.
    resting_sell = place(side="SELL", size=D("55"), price=D("0.50"))
    assert gw.check("bot", "b1", resting_sell) == ORDER_TOO_LARGE
    assert D("0.50") * D("55") < D("50")

    # (c) A daily-cap boundary only the maker price decides: 160.004 of already
    # counted notional plus 39.996 lands exactly on the 200 cap.
    seed_order(store, price=D("160.004"), size=D("1"), status=CANCELLED, cid_suffix=9)
    caps = CapWindow(store, time.time)
    assert caps.daily_notional(None) == D("160.004")
    assert caps.daily_notional(None) + D("40") * D("0.9999") == D("200")
    assert caps.daily_notional(None) + D("40") * D("1.50") > D("200")

    capped = make_gateway(store, caps=caps, exchange=exchange)
    assert capped.check("bot", "b1", resting_buy) is None

    seed_order(store, price=D("0.01"), size=D("1"), status=CANCELLED, cid_suffix=10)
    assert caps.daily_notional(None) == D("160.014")
    assert capped.check("bot", "b1", resting_buy) == DAILY_CAP

    assert exchange.calls == []


def test_cap_window_sees_orders_stamped_by_insert_order(store):
    exchange = RecordingExchange()
    # insert_order stamps created_at itself, so these land in today's window and
    # in the rolling hour without any help from the test.
    seed_order(store, price=D("8"), size=D("1"), cid_suffix=1)
    seed_order(store, price=D("8"), size=D("1"), cid_suffix=2)

    caps = CapWindow(store, time.time)
    assert caps.daily_notional(None) == D("16")
    assert caps.orders_last_hour(None) == 2

    # 16 + 9.5 = 25.5 over a lowered 20 daily cap; the rate cap is far away.
    over_daily = make_gateway(
        store, env={DAILY: "20", ORDERS_HOUR: "30"}, caps=caps, exchange=exchange
    )
    assert over_daily.check("bot", "b1", place()) == DAILY_CAP

    # The same two rows count for the rolling hour: 2 + 1 over a cap of 2.
    over_rate = make_gateway(
        store, env={DAILY: "1000", ORDERS_HOUR: "2"}, exchange=exchange
    )
    assert over_rate.check("bot", "b1", place()) == RATE_CAP

    assert exchange.calls == []