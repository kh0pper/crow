"""limits.py: env-configured limits and the rolling/daily cap windows."""

import dataclasses
from datetime import datetime, timezone
from decimal import Decimal as D

import pytest

from crow_coinbase.limits import CapWindow, Limits
from crow_coinbase.store import (
    CANCELLED,
    FAILED,
    FILLED,
    OPEN,
    PENDING_SUBMIT,
    REJECTED,
    Store,
)

PRODUCT = "XRP-USDC"

POLL = "CROW_COINBASE_POLL_SECONDS"
FEE = "CROW_COINBASE_MAKER_FEE_PCT"
PRODUCTS = "CROW_COINBASE_PRODUCTS"
DAILY = "CROW_COINBASE_DAILY_NOTIONAL_USD"
ORDERS_HOUR = "CROW_COINBASE_ORDERS_PER_HOUR"
DRAWDOWN = "CROW_COINBASE_PORTFOLIO_DRAWDOWN_PCT"
BOT_MAX_ORDER = "CROW_COINBASE_BOT_MAX_ORDER_USD"
MAX_BOT_CAPITAL = "CROW_COINBASE_MAX_BOT_CAPITAL_USD"
AI_MAX_ORDER = "CROW_COINBASE_AI_MAX_ORDER_USD"
AI_DAILY = "CROW_COINBASE_AI_DAILY_NOTIONAL_USD"
AI_ORDERS_HOUR = "CROW_COINBASE_AI_ORDERS_PER_HOUR"
WATCHDOG = "CROW_COINBASE_WATCHDOG_POLICY"

ENV_NAMES = (
    POLL,
    FEE,
    PRODUCTS,
    DAILY,
    ORDERS_HOUR,
    DRAWDOWN,
    BOT_MAX_ORDER,
    MAX_BOT_CAPITAL,
    AI_MAX_ORDER,
    AI_DAILY,
    AI_ORDERS_HOUR,
    WATCHDOG,
)


@pytest.fixture
def store(tmp_path):
    """A fresh store with the one bot every order row needs."""
    s = Store(tmp_path / "s.db")
    s.create_bot("b1", PRODUCT, "grid", {}, D("100"), D("50"))
    yield s
    s.close()


def utc(y, mo, d, h=0, mi=0, s=0, us=0):
    """Epoch seconds for a UTC wall clock reading; the tests never use the real one."""
    return datetime(y, mo, d, h, mi, s, us, tzinfo=timezone.utc).timestamp()


def cid_of(owner, n):
    """A client order id in the engine's `cb-<owner>-...` form (hex tail)."""
    return f"cb-{owner}-B0-{n:012x}"


def window_at(store, now):
    """A CapWindow plus the one-cell clock it reads, so a test can move time."""
    clock = [now]
    return CapWindow(store, lambda: clock[0]), clock


def add(
    store,
    n,
    created_at,
    *,
    price,
    size,
    side="BUY",
    status=OPEN,
    source="bot",
    owner="b1",
):
    """Insert one order row and pin its created_at to *created_at*.

    insert_order stamps the wall clock, so the timestamp is overwritten
    afterwards; the connection is autocommit, so the row is durable at once.
    """
    cid = cid_of(owner, n)
    store.insert_order(
        cid,
        owner,
        source,
        PRODUCT,
        side,
        level=0,
        price=price,
        size=size,
        status=status,
    )
    store.conn().execute(
        "UPDATE orders SET created_at=? WHERE client_order_id=?", (created_at, cid)
    )
    return cid


def test_defaults_from_env():
    limits = Limits.from_env({})

    assert limits.poll_seconds == 60
    assert isinstance(limits.poll_seconds, int)

    assert limits.maker_fee_pct == D("0.5")
    assert isinstance(limits.maker_fee_pct, D)

    assert limits.products == ("BTC-USDC", "ETH-USDC", "XRP-USDC")
    assert isinstance(limits.products, tuple)
    assert len(limits.products) == 3

    assert limits.daily_notional_usd == D("200")
    assert isinstance(limits.daily_notional_usd, D)

    assert limits.orders_per_hour == 30
    assert isinstance(limits.orders_per_hour, int)

    assert limits.portfolio_drawdown_pct == D("20")
    assert isinstance(limits.portfolio_drawdown_pct, D)

    assert limits.bot_max_order_usd == D("50")
    assert isinstance(limits.bot_max_order_usd, D)

    assert limits.max_bot_capital_usd == D("100")
    assert isinstance(limits.max_bot_capital_usd, D)

    assert limits.ai_max_order_usd == D("25")
    assert isinstance(limits.ai_max_order_usd, D)

    assert limits.ai_daily_notional_usd == D("50")
    assert isinstance(limits.ai_daily_notional_usd, D)

    assert limits.ai_orders_per_hour == 10
    assert isinstance(limits.ai_orders_per_hour, int)

    assert limits.watchdog_policy == "leave"
    assert isinstance(limits.watchdog_policy, str)

    # A missing key and an empty / whitespace-only value both mean "the default".
    assert Limits.from_env({name: "" for name in ENV_NAMES}) == limits
    assert Limits.from_env({name: "   " for name in ENV_NAMES}) == limits
    assert Limits.from_env({name: "\t \n" for name in ENV_NAMES}) == limits

    # Frozen: the parsed limits are not editable after they are read.
    with pytest.raises(dataclasses.FrozenInstanceError):
        limits.poll_seconds = 5


def test_env_overrides_parse():
    limits = Limits.from_env(
        {
            POLL: "30",
            FEE: "0.25",
            PRODUCTS: " XRP-USDC , BTC-USDC ",
            DAILY: "150",
            ORDERS_HOUR: "45",
            DRAWDOWN: "35",
            BOT_MAX_ORDER: "20",
            MAX_BOT_CAPITAL: "10",
            AI_MAX_ORDER: "5",
            AI_DAILY: "12",
            AI_ORDERS_HOUR: "4",
            WATCHDOG: "cancel",
        }
    )

    assert limits.poll_seconds == 30
    assert isinstance(limits.poll_seconds, int)

    assert limits.maker_fee_pct == D("0.25")
    assert isinstance(limits.maker_fee_pct, D)
    assert not isinstance(limits.maker_fee_pct, float)

    assert limits.products == ("XRP-USDC", "BTC-USDC")  # order kept, padding stripped
    assert isinstance(limits.products, tuple)

    assert limits.daily_notional_usd == D("150")
    assert isinstance(limits.daily_notional_usd, D)

    assert limits.orders_per_hour == 45
    assert isinstance(limits.orders_per_hour, int)

    assert limits.portfolio_drawdown_pct == D("35")
    assert isinstance(limits.portfolio_drawdown_pct, D)

    assert limits.bot_max_order_usd == D("20")
    assert isinstance(limits.bot_max_order_usd, D)

    assert limits.max_bot_capital_usd == D("10")
    assert isinstance(limits.max_bot_capital_usd, D)

    assert limits.ai_max_order_usd == D("5")
    assert isinstance(limits.ai_max_order_usd, D)

    assert limits.ai_daily_notional_usd == D("12")
    assert isinstance(limits.ai_daily_notional_usd, D)

    assert limits.ai_orders_per_hour == 4
    assert isinstance(limits.ai_orders_per_hour, int)

    assert limits.watchdog_policy == "cancel"

    # One product is a one-element tuple, not a string.
    single = Limits.from_env({PRODUCTS: "ETH-USDC"})
    assert single.products == ("ETH-USDC",)
    assert isinstance(single.products, tuple)

    # An override mapping differs from the all-defaults one.
    assert limits != Limits.from_env({})


def test_from_env_reads_only_the_mapping_given(monkeypatch):
    monkeypatch.setenv(POLL, "5")
    monkeypatch.setenv(FEE, "9.5")
    monkeypatch.setenv(WATCHDOG, "cancel")

    # os.environ says one thing, the mapping says nothing: the defaults stand.
    assert Limits.from_env({}).poll_seconds == 60
    assert Limits.from_env({}).maker_fee_pct == D("0.5")
    assert Limits.from_env({}).watchdog_policy == "leave"

    # And the mapping it is given is the one that decides.
    assert Limits.from_env({POLL: "7"}).poll_seconds == 7
    assert Limits.from_env({WATCHDOG: "cancel"}).watchdog_policy == "cancel"


BAD_VALUES = (
    (POLL, "0"),
    (POLL, "-5"),
    (POLL, "abc"),
    (POLL, "1.5"),
    (FEE, "-0.1"),
    (FEE, "100"),
    (FEE, "x"),
    (FEE, "NaN"),
    (FEE, "Infinity"),
    (PRODUCTS, ","),
    (PRODUCTS, "xrp-usdc"),
    (PRODUCTS, "XRPUSDC"),
    (PRODUCTS, "BTC-USDC,BTC-USDC"),
    (DAILY, "0"),
    (DAILY, "-1"),
    (DAILY, "Infinity"),
    (ORDERS_HOUR, "0"),
    (ORDERS_HOUR, "2.5"),
    (DRAWDOWN, "0"),
    (DRAWDOWN, "101"),
    (BOT_MAX_ORDER, "0"),
    (BOT_MAX_ORDER, "NaN"),
    (MAX_BOT_CAPITAL, "-3"),
    (AI_MAX_ORDER, "abc"),
    (AI_DAILY, "0"),
    (AI_ORDERS_HOUR, "0"),
    (WATCHDOG, "kill"),
)


@pytest.mark.parametrize("name,bad", BAD_VALUES)
def test_invalid_env_values_name_the_variable(name, bad):
    with pytest.raises(ValueError) as err:
        Limits.from_env({name: bad})

    assert name in str(err.value)

    # The edges of the same ranges are valid, not errors.
    assert Limits.from_env({DRAWDOWN: "100"}).portfolio_drawdown_pct == D("100")
    assert Limits.from_env({FEE: "0"}).maker_fee_pct == D("0")


def test_daily_resets_at_utc_midnight(store):
    add(store, 1, utc(2026, 3, 10, 23, 59, 59), price=D("2"), size=D("10"))  # 20
    add(store, 2, utc(2026, 3, 11, 0, 0, 1), price=D("3"), size=D("10"))  # 30

    late, _ = window_at(store, utc(2026, 3, 10, 23, 59, 59, us=500000))
    assert late.daily_notional(None) == D("20")

    new_day, _ = window_at(store, utc(2026, 3, 11, 0, 0, 2))
    assert new_day.daily_notional(None) == D("30")
    assert isinstance(new_day.daily_notional(None), D)

    # Exactly midnight belongs to the new day (the lower bound is inclusive).
    add(store, 3, utc(2026, 3, 11, 0, 0, 0), price=D("1"), size=D("5"))  # 5
    same_window, _ = window_at(store, utc(2026, 3, 11, 0, 0, 2))
    assert same_window.daily_notional(None) == D("35")
    assert same_window.orders_last_hour(None) == 3


def test_rolling_hour_crosses_clock_hour(store, tmp_path):
    base = utc(2026, 3, 10, 10, 50, 0)
    for i in range(30):  # 10:50:00 ... 10:59:40, one every 20 s
        add(store, i + 1, base + 20 * i, price=D("1"), size=D("1"))
    add(store, 40, utc(2026, 3, 10, 11, 4, 59), price=D("1"), size=D("1"))

    # 11:05 is a new clock hour, but nothing has rolled out of the window yet.
    at_1105, _ = window_at(store, utc(2026, 3, 10, 11, 5, 0))
    assert at_1105.orders_last_hour(None) == 31

    # 11:50:30 cuts at 10:50:30: the 10:50:00 and 10:50:20 rows are gone,
    # the other 28 spread rows plus the 11:04:59 one remain.
    later, _ = window_at(store, utc(2026, 3, 10, 11, 50, 30))
    assert later.orders_last_hour(None) == 29

    # The edges of the rolling hour: strictly newer than now() - 3600.
    boundary_path = tmp_path / "boundary.db"
    edge = Store(boundary_path)
    try:
        edge.create_bot("b1", PRODUCT, "grid", {}, D("100"), D("50"))
        now = utc(2026, 3, 10, 12, 0, 0)
        add(edge, 1, now - 3600, price=D("1"), size=D("1"))  # exactly 3600 s old
        add(edge, 2, now - 3599, price=D("1"), size=D("1"))  # one second inside
        edge_window, _ = window_at(edge, now)
        assert edge_window.orders_last_hour(None) == 1
    finally:
        edge.close()


def test_post_only_rejections_not_counted(store):
    t = utc(2026, 3, 10, 12, 0, 0)
    add(store, 1, t, price=D("2"), size=D("1"), status=REJECTED)
    add(store, 2, t, price=D("3"), size=D("1"), status=FAILED)

    window, _ = window_at(store, t)
    assert window.daily_notional(None) == D("0")
    assert window.orders_last_hour(None) == 0

    add(store, 3, t, price=D("4"), size=D("1"), status=OPEN)
    add(store, 4, t, price=D("5"), size=D("1"), status=FILLED)
    add(store, 5, t, price=D("6"), size=D("1"), status=CANCELLED)

    assert window.daily_notional(None) == D("15")
    assert window.orders_last_hour(None) == 3

    # The cancelled row keeps counting even after a rejection lands beside it.
    add(store, 6, t, price=D("100"), size=D("1"), status=REJECTED)
    assert window.daily_notional(None) == D("15")
    assert window.orders_last_hour(None) == 3


def test_pending_submit_counted(store):
    t = utc(2026, 3, 10, 12, 0, 0)
    add(store, 1, t, price=D("1.5"), size=D("4"), status=PENDING_SUBMIT)

    window, _ = window_at(store, t)
    assert window.daily_notional(None) == D("6")
    assert window.daily_notional(None) != D("0")
    assert window.orders_last_hour(None) == 1


def test_buy_and_sell_both_count_at_stored_price(store):
    t = utc(2026, 3, 10, 12, 0, 0)
    buy = add(store, 1, t, side="BUY", price=D("1.25"), size=D("8"))
    sell = add(store, 2, t, side="SELL", price=D("0.5"), size=D("3"))

    window, _ = window_at(store, t)
    assert window.daily_notional(None) == D("11.5")  # 1.25*8 + 0.5*3
    assert isinstance(window.daily_notional(None), D)
    assert window.orders_last_hour(None) == 2

    # The stored price is the final submitted one, so a reprice moves the notional.
    store.update_order(buy, price=D("1.5"))
    assert window.daily_notional(None) == D("13.5")  # 1.5*8 + 0.5*3
    assert window.orders_last_hour(None) == 2

    store.update_order(sell, price=D("1"))
    assert window.daily_notional(None) == D("15")  # 1.5*8 + 1*3


def test_source_filtering_separates_bot_from_ai(store):
    t = utc(2026, 3, 10, 12, 0, 0)
    add(store, 1, t, price=D("2"), size=D("5"), source="bot")  # 10
    add(store, 2, t, side="SELL", price=D("1"), size=D("5"), source="bot")  # 5
    add(store, 3, t, price=D("3"), size=D("2"), source="ai", owner="ai")  # 6

    window, _ = window_at(store, t)

    assert window.daily_notional("bot") == D("15")
    assert window.daily_notional("ai") == D("6")
    assert window.daily_notional(None) == D("21")

    assert window.orders_last_hour("bot") == 2
    assert window.orders_last_hour("ai") == 1
    assert window.orders_last_hour(None) == 3

    # A source nobody used is an empty read, still typed.
    assert window.daily_notional("nobody") == D("0")
    assert isinstance(window.daily_notional("nobody"), D)
    assert window.orders_last_hour("nobody") == 0
    assert isinstance(window.orders_last_hour("nobody"), int)


def test_caps_survive_restart(tmp_path):
    path = tmp_path / "caps.db"
    t = utc(2026, 3, 10, 12, 0, 0)

    first = Store(path)
    try:
        first.create_bot("b1", PRODUCT, "grid", {}, D("100"), D("50"))
        add(first, 1, t, price=D("2"), size=D("3"))  # 6, inside the hour
        add(first, 2, t - 1800, price=D("1.5"), size=D("2"), status=FILLED)  # 3
        add(first, 3, t - 7200, price=D("9"), size=D("9"), status=OPEN)  # day, no hour

        before, _ = window_at(first, t)
        assert before.daily_notional(None) == D("90")  # 6 + 3 + 81
        assert before.orders_last_hour(None) == 2
    finally:
        first.close()

    second = Store(path)
    try:
        after, _ = window_at(second, t)
        assert after.daily_notional(None) == before.daily_notional(None)
        assert after.daily_notional(None) == D("90")
        assert after.orders_last_hour(None) == before.orders_last_hour(None)
        assert after.orders_last_hour(None) == 2
    finally:
        second.close()


def test_empty_table_is_zero(store):
    window, _ = window_at(store, utc(2026, 3, 10, 12, 0, 0))

    assert window.daily_notional(None) == D("0")
    assert window.daily_notional(None) == 0
    assert isinstance(window.daily_notional(None), D)

    assert window.daily_notional("bot") == D("0")
    assert isinstance(window.daily_notional("bot"), D)

    assert window.orders_last_hour(None) == 0
    assert isinstance(window.orders_last_hour(None), int)
    assert not isinstance(window.orders_last_hour(None), D)

    assert window.orders_last_hour("ai") == 0
    assert isinstance(window.orders_last_hour("ai"), int)