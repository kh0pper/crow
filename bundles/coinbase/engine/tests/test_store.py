"""store.py: the SQLite system of record. Schema v1, WAL, explicit transactions."""

import sqlite3
import threading
import time
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

# Same idea for the fills table: including the extra product / trade_type columns.
FILL_COLUMNS = {
    "trade_id",
    "order_id",
    "client_order_id",
    "owner",
    "side",
    "size",
    "price",
    "commission",
    "trade_time",
    "recorded_at",
    "product",
    "trade_type",
}


def ocid(owner, n):
    """A client order id in the engine's `cb-<owner>-...` form."""
    return f"cb-{owner}-{n:012d}"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "s.db")
    yield s
    s.close()


def columns(store, table):
    """Column names of *table* (PRAGMA table_info: cid, name, type, ...)."""
    return [row[1] for row in store.conn().execute(f"PRAGMA table_info({table})")]


def fill(
    trade_id,
    side="BUY",
    size="1",
    price="1",
    commission="0",
    order_id="o1",
    product=None,
    trade_type=None,
):
    f = {
        "trade_id": trade_id,
        "order_id": order_id,
        "side": side,
        "size": D(size),
        "price": D(price),
        "commission": D(commission),
        "trade_time": "2026-01-01T00:00:00Z",
    }
    if product is not None:
        f["product"] = product
    if trade_type is not None:
        f["trade_type"] = trade_type
    return f


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
        fill_cols = set(columns(second, "fills"))
        assert FILL_COLUMNS <= fill_cols, sorted(FILL_COLUMNS - fill_cols)
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


def test_connections_carry_30s_busy_timeout(store):
    """The connect timeout is the one place the busy timeout is set, per connection."""
    assert store.conn().execute("PRAGMA busy_timeout").fetchone()[0] == 30000

    box = []

    def worker():
        try:
            box.append(store.conn().execute("PRAGMA busy_timeout").fetchone()[0])
        except BaseException as exc:  # surfaced in the asserting thread
            box.append(exc)

    t = threading.Thread(target=worker)
    t.start()
    t.join()

    assert box == [30000]


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


class _CommitFailsOnce:
    """A connection proxy that fails "COMMIT" once and delegates everything else.

    A sqlite3.Connection cannot be monkeypatched, so the store's `conn` is pointed
    at one of these for the duration of a test.
    """

    def __init__(self, conn):
        self._conn = conn
        self.failed = False

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def execute(self, sql, *args):
        if sql.strip().upper() == "COMMIT" and not self.failed:
            self.failed = True
            raise sqlite3.OperationalError("disk I/O error")
        return self._conn.execute(sql, *args)


def test_tx_commit_failure_rolls_back_and_next_tx_commits(store):
    real_conn = store.conn()
    proxy = _CommitFailsOnce(real_conn)
    store.conn = lambda: proxy  # this thread only; removed again below
    try:
        with pytest.raises(sqlite3.OperationalError):
            with store.tx():
                store.put("k", 1)
        assert proxy.failed is True
        assert proxy.in_transaction is False
        assert real_conn.in_transaction is False
    finally:
        del store.conn

    assert store.get("k", "missing") == "missing"  # the write was undone

    # The next transaction takes the BEGIN IMMEDIATE path, not the savepoint one.
    assert store.conn().in_transaction is False
    with store.tx():
        store.put("k", 2)
    assert store.get("k") == 2
    assert store.conn().in_transaction is False


def test_tx_body_failure_leaves_store_usable(store):
    with pytest.raises(RuntimeError):
        with store.tx():
            store.put("a", 1)
            raise RuntimeError("boom")
    assert store.conn().in_transaction is False
    assert store.get("a", "missing") == "missing"

    with store.tx():
        store.put("b", 2)
    assert store.get("b") == 2
    assert store.conn().in_transaction is False

    # A failed savepoint leaves the caller's own transaction intact and usable.
    with store.tx():
        store.put("outer", 1)
        with pytest.raises(RuntimeError):
            with store.tx():
                store.put("inner", 2)
                raise RuntimeError("boom")
        store.put("outer", 3)
    assert store.get("outer") == 3
    assert store.get("inner", "missing") == "missing"
    assert store.conn().in_transaction is False


def test_concurrent_begin_immediate_writers_both_succeed(store):
    started = threading.Event()
    errors = []
    seen_by_second = []

    def first():
        try:
            with store.tx():
                store.put("a", 1)
                started.set()
                time.sleep(0.4)  # hold the write lock while the other one waits
        except BaseException as exc:  # surfaced in the asserting thread
            errors.append(exc)

    def second():
        try:
            assert started.wait(5)
            with store.tx() as db:
                # BEGIN IMMEDIATE waited for the first writer instead of failing:
                # we hold the lock only after its COMMIT, so its row is visible.
                row = db.execute("SELECT value FROM kv WHERE key='a'").fetchone()
                seen_by_second.append(row["value"])
                store.put("b", 2)
        except BaseException as exc:  # surfaced in the asserting thread
            errors.append(exc)

    threads = [threading.Thread(target=first), threading.Thread(target=second)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)

    assert [t.is_alive() for t in threads] == [False, False]
    assert not errors, errors
    assert seen_by_second == ["1"]
    assert store.get("a") == 1
    assert store.get("b") == 2


def test_record_fill_exactly_once(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)
    f = fill("t1", "BUY", "4", "1", "0.02")

    assert store.record_fill(f, cid) is True
    assert store.record_fill(f, cid) is False  # duplicate trade_id: nothing written

    assert store.has_fill("t1") is True
    assert store.has_fill("t2") is False

    rows = store.conn().execute(
        "SELECT trade_id, order_id, client_order_id, owner, side, size, price, "
        "commission, trade_time, product, trade_type FROM fills"
    ).fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert row["trade_id"] == "t1"
    assert row["order_id"] == "o1"
    assert row["client_order_id"] == cid
    assert row["owner"] == "b1"
    assert row["side"] == "BUY"
    assert D(row["size"]) == D("4")
    assert D(row["price"]) == D("1")
    assert D(row["commission"]) == D("0.02")
    assert row["trade_time"] == "2026-01-01T00:00:00Z"
    assert row["product"] == XRP  # absent from the fill dict: the order's product
    assert row["trade_type"] is None  # absent from the fill dict

    # Booking a fill leaves the order's own totals alone.
    o = store.order(cid)
    assert o["filled_size"] == D("0")
    assert o["filled_value"] == D("0")
    assert o["fees"] == D("0")
    assert o["status"] == OPEN


def test_record_fill_stores_fill_product_and_trade_type(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)

    # The fill's product must match the order's: a fill belongs to its order.
    f = fill("t1", "BUY", "4", "1", "0.02", product=XRP, trade_type="FILL")
    assert store.record_fill(f, cid) is True

    row = store.conn().execute(
        "SELECT product, trade_type FROM fills WHERE trade_id=?", ("t1",)
    ).fetchone()
    assert row["product"] == XRP
    assert row["trade_type"] == "FILL"


def test_record_fill_rejects_product_mismatch(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)

    with pytest.raises(ValueError):
        store.record_fill(fill("t1", "BUY", "4", "1", "0.02", product=BTC), cid)

    assert store.has_fill("t1") is False
    assert store.conn().execute("SELECT COUNT(*) FROM fills").fetchone()[0] == 0
    assert store.order(cid)["filled_size"] == D("0")


def test_record_fill_never_touches_order_totals(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)
    store.update_order(cid, filled_size=D("4"), filled_value=D("4"), fees=D("0.02"))

    # The same trade arrives again through the reconcile loop (or the stream).
    f = fill("t1", "BUY", "4", "1", "0.02")
    assert store.record_fill(f, cid) is True
    assert store.record_fill(f, cid) is False

    o = store.order(cid)
    assert o["filled_size"] == D("4")
    assert o["filled_value"] == D("4")
    assert o["fees"] == D("0.02")
    assert store.conn().execute("SELECT COUNT(*) FROM fills").fetchone()[0] == 1


def test_record_fill_unknown_cid_writes_nothing(store):
    with pytest.raises(KeyError):
        store.record_fill(fill("t1", "BUY", "1", "1", "0"), "missing-cid")

    assert store.has_fill("t1") is False
    assert store.conn().execute("SELECT COUNT(*) FROM fills").fetchone()[0] == 0


def test_record_fill_keeps_owner_after_bot_row_deleted(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)
    store.conn().execute("DELETE FROM bots WHERE id=?", ("b1",))

    assert store.record_fill(fill("t1", "BUY", "4", "1", "0.02"), cid) is True

    row = store.conn().execute(
        "SELECT owner FROM fills WHERE trade_id=?", ("t1",)
    ).fetchone()
    assert row["owner"] == "b1"
    assert store.order(cid)["owner"] == "b1"


def test_update_order_sets_absolute_fill_totals(store):
    """filled_size / filled_value / fees mirror the exchange: absolute, not deltas."""
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)

    store.update_order(cid, filled_size=D("3"), filled_value=D("3"), fees=D("0.01"))
    store.update_order(cid, filled_size=D("7"), filled_value=D("9"), fees=D("0.03"))

    o = store.order(cid)
    assert o["filled_size"] == D("7")
    assert o["filled_value"] == D("9")
    assert o["fees"] == D("0.03")
    assert o["status"] == OPEN


def test_update_order_rejects_unknown_column(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid = ocid("b1", 1)
    store.insert_order(cid, "b1", "grid", XRP, "BUY", -1, D("1"), D("10"), status=OPEN)

    with pytest.raises(ValueError):
        store.update_order(cid, bogus=1)
    with pytest.raises(ValueError):
        store.update_order(cid, **{"status=1, owner": "x"})
    with pytest.raises(ValueError):  # the primary key is not patchable either
        store.update_order(cid, client_order_id=ocid("b1", 9))

    o = store.order(cid)
    assert o["status"] == OPEN
    assert o["owner"] == "b1"
    assert store.order(ocid("b1", 9)) is None


def test_insert_order_requires_cb_owner_prefix(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    store.create_bot("b2", XRP, "grid", {}, D("10"), D("0"))

    for bad in ("B-1", "cb-b2-B-1", "b1-B-1", ""):  # other owner, no `cb-`
        with pytest.raises(ValueError):
            store.insert_order(
                bad, "b1", "grid", XRP, "BUY", -1, D("1"), D("1"), status=OPEN
            )

    # Orphan orders are exempt from the owner part of the id, not from `cb-`.
    with pytest.raises(ValueError):
        store.insert_order(
            "0xdeadbeef", "orphan", "reconcile", XRP, "BUY", -1, D("1"), D("1")
        )

    assert store.orders() == []  # a rejected id leaves no row behind

    orphan_cid = "cb-b9-B-1-000000000001"  # a bot that no longer exists
    store.insert_order(
        orphan_cid, "orphan", "reconcile", XRP, "BUY", -1, D("1"), D("1")
    )
    assert store.order(orphan_cid)["owner"] == "orphan"

    store.insert_order(
        ocid("b1", 1), "b1", "grid", XRP, "BUY", -1, D("1"), D("1"), status=OPEN
    )
    assert store.order(ocid("b1", 1))["owner"] == "b1"


def test_orphan_order_accepts_any_cb_cid(store):
    cid = "cb-gone1-S-2-000000000002"  # no bot "gone1" any more; id is still ours
    store.insert_order(cid, "orphan", "reconcile", XRP, "SELL", 2, D("2"), D("3"))

    o = store.order(cid)
    assert o["client_order_id"] == cid
    assert o["owner"] == "orphan"
    assert o["side"] == "SELL"
    assert o["level"] == 2
    assert o["price"] == D("2")
    assert o["size"] == D("3")
    assert [x["client_order_id"] for x in store.orders(owner="orphan")] == [cid]


def test_newer_schema_version_refused(tmp_path):
    path = tmp_path / "s.db"
    Store(path).close()

    raw = sqlite3.connect(path)
    try:
        raw.execute("UPDATE schema_version SET version=2")
        raw.commit()
    finally:
        raw.close()

    with pytest.raises(RuntimeError) as err:
        Store(path)
    message = str(err.value)
    assert "2" in message
    assert "1" in message


def test_order_round_trip_columns(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    cid2, cid3 = ocid("b1", 2), ocid("b1", 3)
    store.insert_order(
        cid2,
        "b1",
        "grid",
        XRP,
        "SELL",
        2,
        D("1.05"),
        D("4"),
        status=OPEN,
        order_id="o-2",
        parent_cid=ocid("b1", 1),
        consumes_fill="fill-t1",
        basis_per_base=D("0.99"),
        note="post-only",
    )
    store.insert_order(
        cid3, "b1", "grid", XRP, "BUY", -2, D("0.95"), D("5"), status=PENDING_SUBMIT
    )

    o = store.order(cid2)
    assert o["client_order_id"] == cid2
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
    assert o["parent_cid"] == ocid("b1", 1)
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
    ] == [cid2]
    assert [
        x["client_order_id"] for x in store.orders(statuses=[PENDING_SUBMIT])
    ] == [cid3]
    assert [x["client_order_id"] for x in store.orders(owner="b1")] == [
        cid2,
        cid3,
    ]
    assert store.orders(owner="b1", product=BTC) == []
    assert store.orders(product=BTC) == []

    store.update_order(cid2, status=CANCELLED, opposite=1)
    o = store.order(cid2)
    assert o["status"] == CANCELLED
    assert o["opposite"] == 1
    assert o["updated_at"] >= o["created_at"]

    store.update_order(cid3, fees=D("0.5"), basis_per_base=D("0.9"))
    o = store.order(cid3)
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


def test_set_bot_params_round_trips(store):
    store.create_bot("b1", XRP, "grid", {"step_pct": "1"}, D("100"), D("50"))

    store.set_bot_params("b1", {"center": "1.1", "levels_below": 2})

    bot = store.get_bot("b1")
    assert bot["params"] == {"center": "1.1", "levels_below": 2}
    # The rest of the row is left alone, and an empty mapping is stored as one.
    assert bot["product"] == XRP
    assert bot["status"] == "ACTIVE"
    assert bot["init_done"] is False

    store.set_bot_params("b1", {})
    assert store.get_bot("b1")["params"] == {}


def test_set_init_done_defaults_to_one_and_can_be_reset(store):
    store.create_bot("b1", XRP, "grid", {}, D("100"), D("50"))
    assert store.get_bot("b1")["init_done"] is False

    # The one-argument call still means "done".
    store.set_init_done("b1")
    assert store.get_bot("b1")["init_done"] is True
    row = store.conn().execute(
        "SELECT init_done FROM bots WHERE id=?", ("b1",)
    ).fetchone()
    assert row[0] == 1

    store.set_init_done("b1", False)
    assert store.get_bot("b1")["init_done"] is False
    row = store.conn().execute(
        "SELECT init_done FROM bots WHERE id=?", ("b1",)
    ).fetchone()
    assert row[0] == 0

    store.set_init_done("b1", True)
    assert store.get_bot("b1")["init_done"] is True


def test_bot_setters_roll_back_with_the_callers_transaction(store):
    store.create_bot("b1", XRP, "grid", {"step_pct": "1"}, D("100"), D("50"))

    with pytest.raises(RuntimeError):
        with store.tx():
            store.set_bot_params("b1", {"step_pct": "2"})
            store.set_init_done("b1")
            raise RuntimeError("boom")

    bot = store.get_bot("b1")
    assert bot["params"] == {"step_pct": "1"}
    assert bot["init_done"] is False
    assert store.conn().in_transaction is False


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