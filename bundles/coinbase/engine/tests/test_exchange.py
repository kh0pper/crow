import ast
import pathlib
import sqlite3
from decimal import Decimal as D

import crow_coinbase.exchange as exchange_mod
import pytest
import requests

from crow_coinbase.exchange import (
    DryRunExchange,
    LiveExchange,
    PermanentError,
    TransientError,
    new_client_order_id,
    parse_client_order_id,
    with_retry,
)

FEE = D("0.005")
XRP = "XRP-USDC"
BTC = "BTC-USDC"


class Mkt:
    """Fake public market data: a fixed book plus a settable candle list."""

    def __init__(self, bid="0.9644", ask="0.9646"):
        self.bid, self.ask = D(bid), D(ask)
        self.cs = []

    def best_bid_ask(self):
        return self.bid, self.ask

    def candles(self, start, end):
        return self.cs


def new_db():
    return sqlite3.connect(":memory:", isolation_level=None)


def created_at(db, order_id):
    return db.execute(
        "SELECT created_at FROM sim_orders WHERE order_id=?", (order_id,)
    ).fetchone()[0]


def sim():
    db = new_db()
    markets = {XRP: Mkt()}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")
    ex.deposit("XRP", D("500"), "seed")
    return ex, markets[XRP], db


def test_sim_post_only_and_funds():
    ex, m, _ = sim()
    assert (
        ex.place_limit("grid-B-1-a", XRP, "BUY", D("10"), D("0.9646"))["reason"]
        == "INVALID_LIMIT_PRICE_POST_ONLY"
    )
    assert (
        ex.place_limit("grid-S+1-a", XRP, "SELL", D("10"), D("0.9644"))["reason"]
        == "INVALID_LIMIT_PRICE_POST_ONLY"
    )
    # 2000 XRP at 0.9 costs ~1809 USDC: more than the seeded 1000 USDC can buy
    assert (
        ex.place_limit("grid-B-1-b", XRP, "BUY", D("2000"), D("0.9"))["reason"]
        == "INSUFFICIENT_FUND"
    )
    r = ex.place_limit("grid-B-1-c", XRP, "BUY", D("10"), D("0.9"))
    assert r["ok"]
    # duplicate client_order_id returns the same order (Coinbase semantics)
    assert (
        ex.place_limit("grid-B-1-c", XRP, "BUY", D("10"), D("0.9"))["order_id"]
        == r["order_id"]
    )
    assert ex.balances()["USDC"] == D("1000") - D("10") * D("0.9") * (1 + FEE)


def test_sim_fills_only_when_later_candle_trades_through():
    ex, m, db = sim()
    oid = ex.place_limit("grid-B-1-c", XRP, "BUY", D("10"), D("0.9"))["order_id"]
    placed = created_at(db, oid)
    m.cs = [
        {"start": int(placed) - 30, "low": D("0.8"), "high": D("1")}
    ]  # before placement: ignored
    assert ex.advance(placed + 100) == []
    m.cs = [
        {"start": int(placed) + 60, "low": D("0.9"), "high": D("1")}
    ]  # touched, not through
    assert ex.advance(placed + 100) == []
    m.cs = [{"start": int(placed) + 60, "low": D("0.8999"), "high": D("1")}]
    assert ex.advance(placed + 200) == ["grid-B-1-c"]
    o = ex.get_order(oid)
    assert o["status"] == "FILLED" and o["filled_size"] == D("10")
    assert ex.totals()["XRP"] == D("500") + D("10")
    assert ex.totals()["USDC"] == D("1000") - D("9") - D("9") * FEE
    f = ex.fills(oid)
    assert len(f) == 1 and f[0]["commission"] == D("9") * FEE


def test_advance_uses_each_orders_own_product():
    db = new_db()
    markets = {XRP: Mkt("0.9644", "0.9646"), BTC: Mkt("60000", "60010")}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")

    xrp_order = ex.place_limit("grid-B-1-x", XRP, "BUY", D("10"), D("0.9"))
    btc_order = ex.place_limit("grid-B-1-b", BTC, "BUY", D("0.01"), D("59000"))
    assert xrp_order["ok"] and btc_order["ok"]

    placed_x = created_at(db, xrp_order["order_id"])
    placed_b = created_at(db, btc_order["order_id"])
    start = int(max(placed_x, placed_b)) + 60
    # XRP trading at ~0.85 trades through its own 0.9 buy...
    markets[XRP].cs = [{"start": start, "low": D("0.85"), "high": D("1.0")}]
    # ...while BTC never trades below 59500, so its 59000 buy stays open.
    markets[BTC].cs = [{"start": start, "low": D("59500"), "high": D("60500")}]

    assert ex.advance(start + 120) == ["grid-B-1-x"]
    assert ex.get_order(xrp_order["order_id"])["status"] == "FILLED"
    assert ex.get_order(btc_order["order_id"])["status"] == "OPEN"
    assert [o["client_order_id"] for o in ex.list_open_orders()] == ["grid-B-1-b"]


def test_totals_include_holds():
    ex, m, _ = sim()

    buy = ex.place_limit("grid-B-1-hold", XRP, "BUY", D("10"), D("0.9"))
    assert buy["ok"]
    assert ex.totals()["USDC"] == D("1000")
    assert ex.balances()["USDC"] == D("1000") - D("10") * D("0.9") * (1 + FEE)

    sell = ex.place_limit("grid-S+1-hold", XRP, "SELL", D("4"), D("1.05"))
    assert sell["ok"]
    assert ex.totals()["XRP"] == D("500")
    assert ex.balances()["XRP"] == D("500") - D("4")


def test_list_open_orders_unfiltered_returns_all_products():
    db = new_db()
    markets = {XRP: Mkt(), BTC: Mkt("60000", "60010")}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")
    ex.deposit("XRP", D("500"), "seed")

    assert ex.place_limit("grid-B-1-x", XRP, "BUY", D("10"), D("0.9"))["ok"]
    assert ex.place_limit("grid-B-1-b", BTC, "BUY", D("0.01"), D("59000"))["ok"]

    everywhere = sorted(o["client_order_id"] for o in ex.list_open_orders())
    assert everywhere == ["grid-B-1-b", "grid-B-1-x"]

    xrp_only = ex.list_open_orders(XRP)
    assert [o["client_order_id"] for o in xrp_only] == ["grid-B-1-x"]


def test_deposit_seeds_balances():
    db = new_db()
    markets = {XRP: Mkt()}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)

    assert ex.totals().get("USDC", D(0)) == D("0")
    assert (
        ex.place_limit("grid-B-1-broke", XRP, "BUY", D("10"), D("0.9"))["reason"]
        == "INSUFFICIENT_FUND"
    )

    ex.deposit("USDC", D("250"), "seed")
    ex.deposit("USDC", D("50"), "top up")
    assert ex.totals()["USDC"] == D("300")


WRITE_CAPABLE_SDK_METHODS = {
    "limit_order_gtc",
    "cancel_orders",
    "market_order",
    "market_order_buy",
    "market_order_sell",
    "limit_order_gtd",
    "limit_order_ioc",
    "limit_order_fok",
    "stop_limit_order_gtc",
    "stop_limit_order_gtd",
    "create_order",
    "edit_order",
    "close_position",
    "create_convert_quote",
    "commit_convert_trade",
    "allocate_portfolio",
    "move_portfolio_funds",
}

ALLOWED_WRITES = {"limit_order_gtc", "cancel_orders"}


def _client_calls(node):
    """`self.client.<attr>(...)` call nodes grouped by attribute name."""
    out = {}
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        fn = sub.func
        if not isinstance(fn, ast.Attribute):
            continue
        owner = fn.value
        if (
            isinstance(owner, ast.Attribute)
            and isinstance(owner.value, ast.Name)
            and owner.value.id == "self"
            and owner.attr == "client"
        ):
            out.setdefault(fn.attr, []).append(sub)
    return out


def test_exchange_sdk_calls_only_post_only_limit_and_cancel():
    src = pathlib.Path(exchange_mod.__file__).read_text()
    tree = ast.parse(src)
    calls = _client_calls(tree)

    called_writes = set(calls) & WRITE_CAPABLE_SDK_METHODS
    assert called_writes
    assert called_writes <= ALLOWED_WRITES

    limit_calls = calls.get("limit_order_gtc", [])
    assert limit_calls
    for call in limit_calls:
        kw = {k.arg: k.value for k in call.keywords if k.arg}
        assert "post_only" in kw
        node = kw["post_only"]
        assert isinstance(node, ast.Constant) and node.value is True


def test_with_retry_retries_transient_only():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise requests.exceptions.ConnectionError()
        return "ok"

    assert with_retry(flaky, "t", sleep=lambda s: None) == "ok" and calls["n"] == 3

    def bad():
        r = requests.Response()
        r.status_code = 400
        raise requests.exceptions.HTTPError("400", response=r)

    with pytest.raises(PermanentError):
        with_retry(bad, "t", sleep=lambda s: None)

    def down():
        raise requests.exceptions.Timeout()

    with pytest.raises(TransientError):
        with_retry(down, "t", attempts=3, sleep=lambda s: None)


def test_client_order_id_roundtrip():
    for side, lvl in (("BUY", -3), ("SELL", 0), ("SELL", 2)):
        cid = new_client_order_id("grid-", side, lvl)
        assert cid.startswith("grid-") and parse_client_order_id("grid-", cid) == (
            side,
            lvl,
        )
    assert parse_client_order_id("grid-", "manual-123") is None


def test_live_server_time_reads_epoch_seconds():
    class FakeTime:
        def to_dict(self):
            return {
                "iso": "2026-01-01T00:00:00Z",
                "epoch_seconds": "1767225600",
                "epoch_millis": "1767225600000",
            }

    class FakeClient:
        def get_unix_time(self):
            return FakeTime()

    ex = LiveExchange.__new__(LiveExchange)
    ex.sleep = lambda s: None
    ex.client = FakeClient()
    assert ex.server_time() == 1767225600.0
