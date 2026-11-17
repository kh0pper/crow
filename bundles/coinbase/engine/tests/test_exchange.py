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

    everywhere = ex.list_open_orders()
    assert sorted(o["client_order_id"] for o in everywhere) == [
        "grid-B-1-b",
        "grid-B-1-x",
    ]
    assert {o["client_order_id"]: o["product"] for o in everywhere} == {
        "grid-B-1-x": XRP,
        "grid-B-1-b": BTC,
    }

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


def test_deposit_rejects_non_positive():
    db = new_db()
    ex = DryRunExchange(lambda: db, lambda p: Mkt(), FEE)

    for bad in (D("0"), D("-5")):
        with pytest.raises(ValueError):
            ex.deposit("USDC", bad, "bad")
    assert ex.totals() == {}


def test_deposit_visible_across_connections_default_isolation(tmp_path):
    path = tmp_path / "sim.db"
    c1 = sqlite3.connect(path)  # default isolation level, not autocommit
    c2 = sqlite3.connect(path)
    markets = {XRP: Mkt()}
    first = DryRunExchange(lambda: c1, lambda p: markets[p], FEE)
    second = DryRunExchange(lambda: c2, lambda p: markets[p], FEE)

    first.deposit("USDC", D("125.5"), "seed")

    assert second.totals()["USDC"] == D("125.5")


def test_cancel_between_advance_read_and_write_is_not_filled(tmp_path):
    path = tmp_path / "sim.db"
    c1 = sqlite3.connect(path)
    c2 = sqlite3.connect(path)
    state = {}

    class CancelThenTradeThrough(Mkt):
        def candles(self, start, end):
            other.cancel([state["order_id"]])
            return [{"start": state["start"], "low": D("0.8"), "high": D("1")}]

    markets = {XRP: CancelThenTradeThrough()}
    ex_a = DryRunExchange(lambda: c1, lambda p: markets[p], FEE)
    other = DryRunExchange(lambda: c2, lambda p: markets[p], FEE)
    ex_a.deposit("USDC", D("1000"), "seed")
    placed = ex_a.place_limit("grid-B-1-c", XRP, "BUY", D("10"), D("0.9"))
    assert placed["ok"]
    state["order_id"] = placed["order_id"]
    state["start"] = int(created_at(c1, placed["order_id"])) + 60
    before = ex_a.totals()

    assert ex_a.advance(state["start"] + 120) == []
    assert ex_a.get_order(placed["order_id"])["status"] == "CANCELLED"
    assert ex_a.totals() == before


def test_fills_carry_product():
    ex, m, db = sim()
    oid = ex.place_limit("grid-B-1-p", XRP, "BUY", D("10"), D("0.9"))["order_id"]
    placed = created_at(db, oid)
    m.cs = [{"start": int(placed) + 60, "low": D("0.8999"), "high": D("1")}]

    assert ex.advance(placed + 200) == ["grid-B-1-p"]
    assert ex.fills(oid)[0]["product"] == XRP


def test_norm_order_and_fill_carry_product():
    order = exchange_mod._norm_order({"order_id": "o", "product_id": BTC, "side": "BUY"})
    assert order["product"] == BTC

    fill = exchange_mod._norm_fill(
        {
            "product_id": BTC,
            "trade_id": "t",
            "order_id": "o",
            "side": "BUY",
            "size": "1",
            "price": "2",
            "trade_time": "x",
        }
    )
    assert fill["product"] == BTC


def test_dry_find_by_client_id_product_filter():
    db = new_db()
    markets = {XRP: Mkt(), BTC: Mkt("60000", "60010")}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")
    placed = ex.place_limit("grid-B-1-f", XRP, "BUY", D("10"), D("0.9"))
    assert placed["ok"]

    assert ex.find_by_client_id("grid-B-1-f", 0)["order_id"] == placed["order_id"]
    assert (
        ex.find_by_client_id("grid-B-1-f", 0, XRP)["order_id"] == placed["order_id"]
    )
    assert ex.find_by_client_id("grid-B-1-f", 0, BTC) is None
    assert ex.find_by_client_id("grid-B-1-missing", 0) is None


def test_advance_continues_after_one_products_candles_error():
    class BrokenMkt(Mkt):
        def candles(self, start, end):
            raise TransientError("candles down")

    db = new_db()
    markets = {XRP: BrokenMkt(), BTC: Mkt("60000", "60010")}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")
    xrp = ex.place_limit("grid-B-1-x", XRP, "BUY", D("10"), D("0.9"))
    btc = ex.place_limit("grid-B-1-b", BTC, "BUY", D("0.01"), D("59000"))
    assert xrp["ok"] and btc["ok"]

    start = int(max(created_at(db, xrp["order_id"]), created_at(db, btc["order_id"])))
    markets[BTC].cs = [{"start": start + 60, "low": D("58000"), "high": D("60000")}]

    assert ex.advance(start + 120) == ["grid-B-1-b"]
    assert ex.get_order(btc["order_id"])["status"] == "FILLED"
    assert ex.get_order(xrp["order_id"])["status"] == "OPEN"


def test_totals_and_balances_per_currency_after_cross_product_fill():
    db = new_db()
    markets = {XRP: Mkt("0.9644", "0.9646"), BTC: Mkt("60000", "60010")}
    ex = DryRunExchange(lambda: db, lambda p: markets[p], FEE)
    ex.deposit("USDC", D("1000"), "seed")

    btc = ex.place_limit("grid-B-1-b", BTC, "BUY", D("0.01"), D("59000"))
    xrp = ex.place_limit("grid-B-1-x", XRP, "BUY", D("10"), D("0.9"))
    assert btc["ok"] and xrp["ok"]

    start = int(max(created_at(db, btc["order_id"]), created_at(db, xrp["order_id"])))
    markets[BTC].cs = [{"start": start + 60, "low": D("58000"), "high": D("60000")}]
    assert ex.advance(start + 120) == ["grid-B-1-b"]

    cost = D("59000") * D("0.01")
    assert ex.totals()["BTC"] == D("0.01")
    assert ex.totals()["USDC"] == D("1000") - cost - cost * FEE
    assert ex.totals().get("XRP", D(0)) == D(0)
    xrp_hold = D("10") * D("0.9") * (1 + FEE)
    assert ex.balances()["USDC"] == ex.totals()["USDC"] - xrp_hold


OLD_SIM_ORDERS = """
CREATE TABLE sim_orders (
  order_id TEXT PRIMARY KEY, client_order_id TEXT UNIQUE, side TEXT, price TEXT,
  size TEXT, status TEXT, created_at REAL, filled_at REAL, fee TEXT DEFAULT '0');
"""


def test_old_schema_dry_db_refused(tmp_path):
    db = sqlite3.connect(tmp_path / "old.db")
    db.executescript(OLD_SIM_ORDERS)

    with pytest.raises(RuntimeError, match="predates schema v1"):
        DryRunExchange(lambda: db, lambda p: Mkt(), FEE)


ALLOWED_SDK_METHODS = {
    "get_api_key_permissions",
    "get_transaction_summary",
    "get_accounts",
    "get_unix_time",
    "list_orders",
    "get_order",
    "get_fills",
    "get_public_product",
    "get_public_product_book",
    "get_public_candles",
    "limit_order_gtc",
    "cancel_orders",
}

SDK_CLIENTS = ("client", "pub")


def _self_sdk_ref(node):
    """`self.client` / `self.pub` attribute nodes."""
    return (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "self"
        and node.attr in SDK_CLIENTS
    )


def _sdk_calls(node):
    """`self.client.<attr>(...)` / `self.pub.<attr>(...)` calls by attribute name."""
    out = {}
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        fn = sub.func
        if isinstance(fn, ast.Attribute) and _self_sdk_ref(fn.value):
            out.setdefault(fn.attr, []).append(sub)
    return out


def test_exchange_sdk_calls_only_post_only_limit_and_cancel():
    src = pathlib.Path(exchange_mod.__file__).read_text()
    tree = ast.parse(src)
    calls = _sdk_calls(tree)

    # non-vacuous: the two write paths are actually used
    assert "limit_order_gtc" in calls
    assert "cancel_orders" in calls
    assert set(calls) <= ALLOWED_SDK_METHODS

    for call in calls["limit_order_gtc"]:
        kw = {k.arg: k.value for k in call.keywords if k.arg}
        assert "post_only" in kw
        node = kw["post_only"]
        assert isinstance(node, ast.Constant) and node.value is True

    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "getattr"
        ):
            assert node.args, "getattr() without arguments"
            first = node.args[0]
            assert not (isinstance(first, ast.Name) and first.id == "self")
            if len(node.args) > 1:
                name = node.args[1]
                assert not (isinstance(name, ast.Constant) and name.value in SDK_CLIENTS)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            assert not _self_sdk_ref(node.value), "SDK client aliased to another name"


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


class Resp:
    def __init__(self, payload):
        self.payload = payload

    def to_dict(self):
        return self.payload


class FakeAccounts:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get_accounts(self, limit=None, cursor=None):
        self.calls.append({"limit": limit, "cursor": cursor})
        return Resp(self.pages[len(self.calls) - 1])


class FakeOrders:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def list_orders(self, **kwargs):
        self.calls.append(kwargs)
        return Resp(self.pages[len(self.calls) - 1])


def live(client):
    ex = LiveExchange.__new__(LiveExchange)
    ex.sleep = lambda s: None
    ex.client = client
    return ex


def test_live_totals_adds_hold_across_pages():
    fake = FakeAccounts(
        [
            {
                "accounts": [
                    {
                        "currency": "USDC",
                        "available_balance": {"value": "10"},
                        "hold": {"value": "2.5"},
                    },
                    {"currency": "BTC", "available_balance": {"value": "0.5"}},
                ],
                "has_next": True,
                "cursor": "c2",
            },
            {
                "accounts": [
                    {"currency": "ETH", "available_balance": {"value": "2"}},
                ],
                "has_next": False,
            },
        ]
    )

    totals = live(fake).totals()

    assert totals == {"USDC": D("12.5"), "BTC": D("0.5"), "ETH": D("2")}
    assert len(fake.calls) == 2
    assert fake.calls[1]["cursor"] == "c2"


def test_live_list_open_orders_unfiltered_follows_cursor():
    def order(order_id, product):
        return {
            "order_id": order_id,
            "client_order_id": "cid-" + order_id,
            "product_id": product,
            "side": "BUY",
            "status": "OPEN",
            "order_configuration": {
                "limit_limit_gtc": {"limit_price": "0.9", "base_size": "10"}
            },
        }

    fake = FakeOrders(
        [
            {
                "orders": [order("o1", XRP)],
                "has_next": True,
                "cursor": "c2",
            },
            {"orders": [order("o2", BTC)], "has_next": False},
        ]
    )
    ex = live(fake)

    everywhere = ex.list_open_orders()

    assert [o["order_id"] for o in everywhere] == ["o1", "o2"]
    assert all("product_ids" not in c for c in fake.calls)
    assert fake.calls[1]["cursor"] == "c2"

    fake.calls = []
    fake.pages = [{"orders": [order("o1", XRP)], "has_next": False}]
    assert [o["order_id"] for o in ex.list_open_orders(XRP)] == ["o1"]
    assert fake.calls[0]["product_ids"] == [XRP]


def test_live_place_limit_sends_post_only():
    class FakePlace:
        def __init__(self):
            self.calls = []

        def limit_order_gtc(self, **kwargs):
            self.calls.append(kwargs)
            return Resp({"success": True, "success_response": {"order_id": "o1"}})

    fake = FakePlace()
    res = live(fake).place_limit("cid-1", XRP, "BUY", D("10"), D("0.9"))

    sent = fake.calls[0]
    assert sent["post_only"] is True
    assert sent["product_id"] == XRP
    assert sent["client_order_id"] == "cid-1"
    assert res["ok"] and res["order_id"] == "o1"
