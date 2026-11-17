import sqlite3
from decimal import Decimal as D

import pytest
import requests

from crow_coinbase.exchange import (
    DryRunExchange,
    PermanentError,
    TransientError,
    new_client_order_id,
    parse_client_order_id,
    with_retry,
)

FEE = D("0.005")


class Mkt:
    def __init__(self):
        self.bid, self.ask = D("0.9644"), D("0.9646")
        self.cs = []

    def best_bid_ask(self):
        return self.bid, self.ask

    def candles(self, start, end):
        return self.cs


def sim():
    db = sqlite3.connect(":memory:", isolation_level=None)
    m = Mkt()
    return DryRunExchange("XRP-USDC", db, m, FEE, D("45"), D("43.8")), m, db


def test_sim_post_only_and_funds():
    ex, m, _ = sim()
    assert (
        ex.place_limit("grid-B-1-a", "BUY", D("10"), D("0.9646"))["reason"]
        == "INVALID_LIMIT_PRICE_POST_ONLY"
    )
    assert (
        ex.place_limit("grid-S+1-a", "SELL", D("10"), D("0.9644"))["reason"]
        == "INVALID_LIMIT_PRICE_POST_ONLY"
    )
    assert (
        ex.place_limit("grid-B-1-b", "BUY", D("100"), D("0.9"))["reason"]
        == "INSUFFICIENT_FUND"
    )
    r = ex.place_limit("grid-B-1-c", "BUY", D("10"), D("0.9"))
    assert r["ok"]
    # duplicate client_order_id returns the same order (Coinbase semantics)
    assert (
        ex.place_limit("grid-B-1-c", "BUY", D("10"), D("0.9"))["order_id"]
        == r["order_id"]
    )
    assert ex.balances()["USDC"] == D("45") - D("10") * D("0.9") * (1 + FEE)


def test_sim_fills_only_when_later_candle_trades_through():
    ex, m, db = sim()
    oid = ex.place_limit("grid-B-1-c", "BUY", D("10"), D("0.9"))["order_id"]
    created = db.execute("SELECT created_at FROM sim_orders").fetchone()[0]
    m.cs = [
        {"start": int(created) - 30, "low": D("0.8"), "high": D("1")}
    ]  # before placement: ignored
    assert ex.advance(created + 100) == []
    m.cs = [
        {"start": int(created) + 60, "low": D("0.9"), "high": D("1")}
    ]  # touched, not through
    assert ex.advance(created + 100) == []
    m.cs = [{"start": int(created) + 60, "low": D("0.8999"), "high": D("1")}]
    assert ex.advance(created + 200) == ["grid-B-1-c"]
    o = ex.get_order(oid)
    assert o["status"] == "FILLED" and o["filled_size"] == D("10")
    assert ex.totals()["XRP"] == D("53.8")
    assert ex.totals()["USDC"] == D("45") - D("9") - D("9") * FEE
    f = ex.fills(oid)
    assert len(f) == 1 and f[0]["commission"] == D("9") * FEE


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
