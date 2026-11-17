"""store.py: the SQLite system of record. Schema v1, WAL, explicit transactions."""

import threading
from decimal import Decimal as D

import pytest

from crow_coinbase.store import (
    CANCELLED,
    OPEN,
    PENDING_SUBMIT,
    Store,
)

XRP = "XRP-USDC"
BTC = "BTC-USDC"

# Every column the interface contract promises. PRAGMA table_info is checked
# against these so a schema edit cannot silently drop one.
ORDER_COLUMNS = {
    "client_order_id",
    "order_id",
    "owner",
    "source",
    "product",
    "side",
    "level",
    "price",
    "size",
    "status",
    "parent_cid",
    "created_at",
    "updated_at",
    "filled_size",
    "filled_value",
    "fees",
    "basis_per_base",
    "consumes_fill",
    "opposite",
    "fills_ok",
    "note",
}

BOT_COLUMNS = {
    "id",
    "product",
    "strategy",
    "params_json",
    "state_json",
    "capital_quote",
    "capital_base",
    "status",
    "init_done",
    "created_at",
}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "s.db")
    yield s
    s.close()


def columns(store, table):
    """Column names of *table* (PRAGMA table_info: cid, name, type, ...)."""
    return [row[1] for row in store.conn().execute(f"PRAGMA table_info({table})")]


def fill(trade_id, side="BUY", size="1", price="1", commission="0", order_id="o1"):
    return {
        "trade_id": trade_id,
        "order_id": order_id,
        "side": side,
        "size": D(size),
        "price": D(price),
        "commission": D(commission),
        "trade_time": "2026-01-01T00:00:00Z",
    }


def test_bot_id_grammar_and_reserved_names(store):
    for ok in ("a", "grid1", "a" * 16):
        store.create_bot(ok, XRP, "grid", {}, D("100"), D("50"))
    assert {b["id"] for b in store.list_bots()} == {"a", "grid1", "a" * 16}

    for bad in ("", "A", "bad-id", "has space", "a" * 17, "ai", "orphan"):
        with pytest.raises(ValueError):
            store.create_bot(bad, XRP, "grid", {}, D("100"), D("50"))

    with pytest.raises(ValueError):  # duplicate id
        store.create_bot("a", XRP, "grid", {}, D("100"), D("50"))


def test_create_bot_rejects_negative_capital(store):
    for quote, base in ((D("-1"), D("0")), (D("0"), D("-1")), (D("-1"), D("-1"))):
        with pytest.raises(ValueError):
            store.create_bot("neg", XRP, "grid", {}, quote, base)
    assert store.list_bots() == []
    assert store.get_bot("neg") is None


def test_create_bot_round_trips(store):
    store.create_bot("b1", XRP, "grid", {"step_pct": "1"}, D("100"), D("50"))
    store.create_bot("b2", BTC, "spot", {"mode": "dry"}, D("60"), D("0"))

    bot = store.get_bot("b1")
    assert bot["id"] == "b1"
    assert bot["product"] == XRP
    assert bot["strategy"] == "grid"
    assert bot["params"] == {"step_pct": "1"}
    assert bot["state"] == {}
    assert bot["capital_quote"] == D("100")
    assert isinstance(bot["capital_quote"], D)
    assert bot["capital_base"] == D("50")
    assert isinstance(bot["capital_base"], D)
    assert bot["status"] == "ACTIVE"
    assert bot["init_done"] is False
    assert bot["created_at"] > 0

    assert store.get_bot("nope") is None
    assert [b["id"] for b in store.list_bots()] == ["b1", "b2"]


def test_reopen_idempotent_schema_v1(tmp_path):
    path = tmp_path / "s.db"
    first = Store(path)
    first.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    first.close()

    second = Store(path)
    try:
        assert second.get_bot("b1")["id"] == "b1"
        assert second.schema_version() == 1

        versions = second.conn().execute(
            "SELECT version FROM schema_version"
        ).fetchall()
        assert len(versions) == 1 and versions[0][0] == 1

        order_cols = set(columns(second, "orders"))
        assert ORDER_COLUMNS <= order_cols, sorted(ORDER_COLUMNS - order_cols)
        bot_cols = set(columns(second, "bots"))
        assert BOT_COLUMNS <= bot_cols, sorted(BOT_COLUMNS - bot_cols)
    finally:
        second.close()


def test_per_thread_connections(store):
    main_conn = store.conn()
    assert store.conn() is main_conn

    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))

    box = []

    def worker():
        try:
            box.append((store.conn(), store.get_bot("b1")))
        except BaseException as exc:  # surfaced in the asserting thread
            box.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    t.join()

    assert len(box) == 1
    assert not isinstance(box[0], BaseException), box[0]
    other_conn, bot = box[0]

    assert other_conn is not main_conn
    assert store.conn() is main_conn  # still one per thread
    assert bot is not None and bot["id"] == "b1"


def test_wal_and_autocommit(store):
    mode = store.conn().execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"
    assert store.conn().isolation_level is None


def test_tx_commits_and_rolls_back(store):
    with pytest.raises(RuntimeError):
        with store.tx():
            store.put("k", {"a": 1})
            raise RuntimeError("boom")
    assert store.get("k", "missing") == "missing"
    assert store.conn().in_transaction is False

    with store.tx():
        store.put("k", {"a": 1})
    assert store.get("k") == {"a": 1}
    assert store.conn().in_transaction is False


def test_tx_nests_as_savepoint(store):
    with store.tx():
        store.put("outer", 1)
        with pytest.raises(RuntimeError):
            with store.tx():
                store.put("inner", 2)
                raise RuntimeError("boom")
    assert store.get("outer") == 1
    assert store.get("inner", "gone") == "gone"
    assert store.conn().in_transaction is False


def test_create_bot_inside_callers_transaction_rolls_back_with_it(store):
    with pytest.raises(RuntimeError):
        with store.tx():
            store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
            raise RuntimeError("boom")
    assert store.get_bot("b1") is None
    assert store.list_bots() == []


def test_apply_fill_exactly_once(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    store.insert_order(
        "cid-1", "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN
    )
    f = fill("t1", "BUY", "4", "1", "0.02")

    assert store.apply_fill(f, "cid-1") is True
    assert store.apply_fill(f, "cid-1") is False

    o = store.order("cid-1")
    assert o["filled_size"] == D("4")
    assert o["filled_value"] == D("4")
    assert o["fees"] == D("0.02")

    assert store.has_fill("t1") is True
    assert store.has_fill("t2") is False

    rows = store.conn().execute(
        "SELECT owner, side, size, price, commission FROM fills"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "b1"
    assert rows[0][1] == "BUY"
    assert D(rows[0][2]) == D("4")
    assert D(rows[0][3]) == D("1")
    assert D(rows[0][4]) == D("0.02")


def test_apply_fill_accumulates_partial_fills(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    store.insert_order(
        "cid-1", "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN
    )

    assert store.apply_fill(fill("t1", "BUY", "3", "1", "0.01"), "cid-1") is True
    assert store.apply_fill(fill("t2", "BUY", "4", "1.5", "0.02"), "cid-1") is True

    o = store.order("cid-1")
    assert o["filled_size"] == D("7")
    assert o["filled_value"] == D("9")
    assert o["fees"] == D("0.03")
    assert o["status"] == OPEN


def test_apply_fill_unknown_cid_writes_nothing(store):
    with pytest.raises(KeyError):
        store.apply_fill(fill("t1", "BUY", "1", "1", "0"), "missing-cid")

    assert store.has_fill("t1") is False
    assert store.conn().execute("SELECT COUNT(*) FROM fills").fetchone()[0] == 0


def test_order_round_trip_columns(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    store.insert_order(
        "cid-2",
        "b1",
        "grid",
        XRP,
        "SELL",
        2,
        D("1.05"),
        D("4"),
        status=OPEN,
        order_id="o-2",
        parent_cid="cid-1",
        consumes_fill="fill-t1",
        basis_per_base=D("0.99"),
        note="post-only",
    )
    store.insert_order(
        "cid-3", "b1", "grid", XRP, "BUY", -2, D("0.95"), D("5"), status=PENDING_SUBMIT
    )

    o = store.order("cid-2")
    assert o["client_order_id"] == "cid-2"
    assert o["order_id"] == "o-2"
    assert o["owner"] == "b1"
    assert o["source"] == "grid"
    assert o["product"] == XRP
    assert o["side"] == "SELL"
    assert o["level"] == 2
    assert o["status"] == OPEN
    assert o["price"] == D("1.05") and isinstance(o["price"], D)
    assert o["size"] == D("4") and isinstance(o["size"], D)
    assert o["filled_size"] == D("0")
    assert o["filled_value"] == D("0")
    assert o["fees"] == D("0")
    assert o["parent_cid"] == "cid-1"
    assert o["consumes_fill"] == "fill-t1"
    assert o["basis_per_base"] == D("0.99")
    assert isinstance(o["basis_per_base"], D)
    assert o["opposite"] == 0
    assert not o["fills_ok"]
    assert o["note"] == "post-only"
    assert o["updated_at"] >= o["created_at"]

    assert store.order("missing") is None
    assert [
        x["client_order_id"]
        for x in store.orders(owner="b1", statuses=[OPEN], product=XRP)
    ] == ["cid-2"]
    assert [
        x["client_order_id"] for x in store.orders(statuses=[PENDING_SUBMIT])
    ] == ["cid-3"]
    assert [x["client_order_id"] for x in store.orders(owner="b1")] == [
        "cid-2",
        "cid-3",
    ]
    assert store.orders(owner="b1", product=BTC) == []
    assert store.orders(product=BTC) == []

    store.update_order("cid-2", status=CANCELLED, opposite=1)
    o = store.order("cid-2")
    assert o["status"] == CANCELLED
    assert o["opposite"] == 1
    assert o["updated_at"] >= o["created_at"]

    store.update_order("cid-3", fees=D("0.5"), basis_per_base=D("0.9"))
    o = store.order("cid-3")
    assert o["fees"] == D("0.5")
    assert o["basis_per_base"] == D("0.9")


def test_hwm_only_ratchets_up(store):
    assert store.hwm("b1") is None

    assert store.update_hwm("b1", D("100")) == D("100")
    assert isinstance(store.hwm("b1"), D)

    assert store.update_hwm("b1", D("90")) == D("100")
    assert store.hwm("b1") == D("100")

    assert store.update_hwm("b1", D("120")) == D("120")
    assert store.hwm("b1") == D("120")

    assert store.hwm("nobody") is None


def test_kv_json_and_events(store):
    store.put("halted", True)
    assert store.get("halted") is True
    store.put("halted", False)
    assert store.get("halted") is False

    store.put("state", {"level": 3, "note": "x", "sizes": ["1", "2"]})
    assert store.get("state") == {"level": 3, "note": "x", "sizes": ["1", "2"]}

    assert store.get("missing") is None
    assert store.get("missing", "dflt") == "dflt"

    store.event("WARN", "something happened")
    rows = store.conn().execute("SELECT level, message FROM events").fetchall()
    assert [(r[0], r[1]) for r in rows] == [("WARN", "something happened")]