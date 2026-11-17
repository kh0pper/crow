"""ledger.py: one owner's holdings, derived from order rows plus its capital."""

from decimal import Decimal as D

import pytest

from crow_coinbase.ledger import Holding, Ledger
from crow_coinbase.store import (
    CANCELLED,
    FILLED,
    OPEN,
    PENDING_SUBMIT,
    Store,
)

XRP = "XRP-USDC"
BTC = "BTC-USDC"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "s.db")
    yield s
    s.close()


def make_bot(store, bot_id="b1", product=XRP, quote="100", base="0"):
    store.create_bot(bot_id, product, "grid", {}, D(quote), D(base))


def place(store, cid, owner, side, price, size, product=XRP, level=0, status=OPEN):
    store.insert_order(
        cid, owner, "grid", product, side, level, D(price), D(size), status=status
    )


def fill(store, cid, trade_id, side, size, price, commission="0"):
    return store.apply_fill(
        {
            "trade_id": trade_id,
            "order_id": "oid-" + cid,
            "side": side,
            "size": D(size),
            "price": D(price),
            "commission": D(commission),
            "trade_time": "2026-01-01T00:00:00Z",
        },
        cid,
    )


def check(h, quote, base, reserved_quote="0", reserved_base="0"):
    assert h.quote == D(quote)
    assert h.base == D(base)
    assert h.reserved_quote == D(reserved_quote)
    assert h.reserved_base == D(reserved_base)
    assert h.available_quote == h.quote - h.reserved_quote
    assert h.available_base == h.base - h.reserved_base


def test_create_bot_starts_with_its_capital(store):
    make_bot(store, "b1", XRP, "100", "50")

    h = Ledger(store).holding("b1")

    assert h == Holding(D("100"), D("50"), D("0"), D("0"))
    assert h.available_quote == D("100")
    assert h.available_base == D("50")


def test_fill_moves_holding(store):
    make_bot(store, "b1", XRP, "100", "50")
    led = Ledger(store)

    place(store, "cid-buy", "b1", "BUY", "1", "10", level=-1)
    fill(store, "cid-buy", "t1", "BUY", "10", "1", "0.05")
    store.update_order("cid-buy", status=FILLED)

    check(led.holding("b1"), "89.95", "60")

    place(store, "cid-sell", "b1", "SELL", "2", "5", level=1)
    fill(store, "cid-sell", "t2", "SELL", "5", "2", "0.02")
    store.update_order("cid-sell", status=FILLED)

    # 89.95 + (5 * 2 - 0.02), base 60 - 5
    check(led.holding("b1"), "99.93", "55")


def test_open_order_reserves_and_cancel_releases(store):
    make_bot(store, "b1", XRP, "100", "50")
    led = Ledger(store, fee_rate=D("0.005"))

    place(store, "cid-buy", "b1", "BUY", "2", "10", level=-1)
    h = led.holding("b1")
    assert h.quote == D("100")  # a resting order moves nothing between totals
    assert h.reserved_quote == D("20.10")  # 10 * 2 * 1.005, fee included
    assert h.available_quote == D("79.90")

    place(store, "cid-sell", "b1", "SELL", "2", "4", level=1)
    h = led.holding("b1")
    assert h.reserved_quote == D("20.10")
    assert h.reserved_base == D("4")
    assert h.available_base == D("46")

    place(store, "cid-pending", "b1", "BUY", "3", "1", status=PENDING_SUBMIT)
    h = led.holding("b1")
    assert h.reserved_quote == D("20.10") + D("3.015")  # 1 * 3 * 1.005
    assert h.reserved_base == D("4")

    # A partially filled live buy reserves only the remaining size.
    place(store, "cid-part", "b1", "BUY", "1", "10", level=-2)
    fill(store, "cid-part", "t1", "BUY", "4", "1", "0.004")
    h = led.holding("b1")
    assert h.quote == D("100") - D("4") - D("0.004")
    assert h.base == D("54")
    assert h.reserved_quote == D("23.115") + D("6.03")  # 6 left at 1 * 1.005
    assert h.reserved_base == D("4")

    for cid in ("cid-buy", "cid-sell", "cid-pending", "cid-part"):
        store.update_order(cid, status=CANCELLED)

    h = led.holding("b1")
    check(h, "95.996", "54")  # the partial fill stays, every hold is released


def test_two_bots_same_product_isolated(store):
    make_bot(store, "b1", XRP, "100", "50")
    make_bot(store, "b2", XRP, "70", "20")

    place(store, "cid-b1", "b1", "BUY", "1", "10", level=-1)
    fill(store, "cid-b1", "t1", "BUY", "10", "1", "0.01")
    store.update_order("cid-b1", status=FILLED)

    led = Ledger(store)
    check(led.holding("b1"), "89.99", "60")
    check(led.holding("b2"), "70", "20")


def test_holding_filters_by_product_and_requires_it_without_a_bot(store):
    make_bot(store, "b1", XRP, "100", "50")
    led = Ledger(store)

    with pytest.raises(ValueError):
        led.holding("nobot")  # no bot row and no product to fall back on

    check(led.holding("nobot", XRP), "0", "0")
    check(led.holding("orphan", XRP), "0", "0")
    check(led.holding("ai", XRP), "0", "0")

    # A bot's own product is the default; another product's rows are not mixed in.
    place(store, "cid-btc", "b1", "BUY", "60000", "0.01", product=BTC, level=-1)
    fill(store, "cid-btc", "t-btc", "BUY", "0.01", "60000", "6")
    store.update_order("cid-btc", status=FILLED)

    check(led.holding("b1"), "100", "50")


def test_orphan_holding_comes_only_from_its_fills(store):
    place(store, "cid-o", "orphan", "BUY", "1", "10", level=-1)
    fill(store, "cid-o", "t1", "BUY", "10", "1", "0.05")
    store.update_order("cid-o", status=FILLED)

    h = Ledger(store).holding("orphan", XRP)

    assert h.quote == -(D("10") + D("0.05"))  # capital 0, only the fill's cost
    assert h.base == D("10")
    assert h.reserved_quote == D("0")
    assert h.reserved_base == D("0")

    assert store.get_bot("orphan") is None
    assert store.list_bots() == []
    with pytest.raises(ValueError):
        store.create_bot("orphan", XRP, "grid", {}, D("100"), D("50"))


def test_equity_uses_totals_and_prices(store):
    make_bot(store, "b1", XRP, "100", "50")
    led = Ledger(store, fee_rate=D("0.005"))

    assert led.equity("b1", {XRP: D("2")}) == D("200")  # 100 + 50 * 2

    # A resting order only reserves: totals (and so equity) are unchanged.
    place(store, "cid-rest", "b1", "BUY", "1", "10", level=-1)
    assert led.equity("b1", {XRP: D("2")}) == D("200")

    place(store, "cid-take", "b1", "BUY", "1", "10", level=-2)
    fill(store, "cid-take", "t1", "BUY", "10", "1", "0.05")
    store.update_order("cid-take", status=FILLED)

    # quote 89.95, base 60
    assert led.equity("b1", {XRP: D("2")}) == D("209.95")
    assert led.equity("b1", {XRP: D("1")}) == D("149.95")


def test_unallocated_zero_with_resting_order(store):
    make_bot(store, "b1", XRP, "100", "50")
    place(store, "cid-buy", "b1", "BUY", "1", "10", level=-1)
    place(store, "cid-sell", "b1", "SELL", "2", "4", level=1)

    out = Ledger(store).unallocated({"USDC": D("100"), "XRP": D("50")})

    assert out == {"USDC": D("0"), "XRP": D("0")}


def test_unallocated_per_currency_shared_usdc(store):
    make_bot(store, "x", XRP, "100", "0")
    make_bot(store, "y", BTC, "60", "0")
    led = Ledger(store)

    out = led.unallocated({"USDC": D("170"), "XRP": D("0"), "BTC": D("0")})
    assert out == {"USDC": D("10"), "XRP": D("0"), "BTC": D("0")}

    # A bot's base capital counts against the base currency too.
    make_bot(store, "z", XRP, "0", "50")
    out = led.unallocated({"USDC": D("170"), "XRP": D("50"), "BTC": D("0")})
    assert out == {"USDC": D("10"), "XRP": D("0"), "BTC": D("0")}


def test_unallocated_negative_when_exchange_short(store):
    make_bot(store, "b1", XRP, "100", "50")
    led = Ledger(store)

    out = led.unallocated({"USDC": D("80"), "XRP": D("40")})
    assert out["USDC"] == D("-20")
    assert out["XRP"] == D("-10")

    # A currency missing from totals counts as 0.
    out = led.unallocated({})
    assert out["USDC"] == D("-100")
    assert out["XRP"] == D("-50")

    out = led.unallocated({"USDC": D("100")})
    assert out["USDC"] == D("0")
    assert out["XRP"] == D("-50")


def test_unallocated_counts_orphan_owner(store):
    led = Ledger(store)
    totals = {"USDC": D("100"), "XRP": D("0")}
    before = led.unallocated(totals)
    assert before == {"USDC": D("100"), "XRP": D("0")}

    place(store, "cid-o", "orphan", "BUY", "1", "10", level=-1)
    fill(store, "cid-o", "t1", "BUY", "10", "1", "0.05")
    store.update_order("cid-o", status=FILLED)

    after = led.unallocated(totals)

    # The orphan's filled buy shifts unallocated by exactly its cost + fee and its
    # size, the same shift a bot owner's fill makes.
    assert after["USDC"] == before["USDC"] + D("10.05")
    assert after["XRP"] == before["XRP"] - D("10")