"""reconcile.py: the exchange snapshot is the truth, the store catches up.

Every test drives a real `Store` over a temporary file and a `FakeExchange`
that answers from a dict of normalised order snapshots plus a dict of fills per
order id.  The fake records every read, so a test can see which lookups a cycle
made, and it defines no place/cancel method at all: `reconcile` moves orders off
the book only through the gateway, so a stray write would raise AttributeError
here instead of touching a live account.

`now` is always passed in.  A boundary test moves the caller's clock past the
300 s window rather than sleeping, and a row that has to look old gets an
explicit `created_at` through `store.update_order`.  Prices and sizes are
synthetic XRP-USDC values around 1.0; `trades.csv` sits next to the database
file and is read back row by row.
"""

from __future__ import annotations

import contextlib
import csv
import time
from decimal import Decimal as D
from pathlib import Path

import pytest

from crow_coinbase.exchange import PermanentError, TransientError
from crow_coinbase.reconcile import reconcile
from crow_coinbase.store import (
    CANCELLED,
    FAILED,
    FILLED,
    OPEN,
    PENDING_SUBMIT,
    STOPPED,
    Store,
)

PRODUCT = "XRP-USDC"

# `trade_type` sentinel: OMIT leaves the key out of the fill dict, None puts the
# key there with a null value.  Both mean FILL.
OMIT = object()


# ---------------------------------------------------------------- harness


def snap(
    order_id,
    client_order_id,
    *,
    product=PRODUCT,
    side="BUY",
    status="OPEN",
    price="1.0",
    size="10",
    filled_size="0",
    filled_value="0",
    total_fees="0",
):
    """One normalised exchange order snapshot, shaped like the adapter's own."""
    return {
        "order_id": order_id,
        "client_order_id": client_order_id,
        "product": product,
        "side": side,
        "status": status,
        "price": D(price),
        "size": D(size),
        "filled_size": D(filled_size),
        "filled_value": D(filled_value),
        "total_fees": D(total_fees),
    }


def trade_fill(
    trade_id,
    order_id,
    *,
    product=PRODUCT,
    side="BUY",
    size="10",
    price="1.0",
    commission="0",
    trade_time="2026-01-01T00:00:00Z",
    trade_type="FILL",
):
    """One exchange fill.  `trade_type=OMIT` drops the key, `None` nulls it."""
    f = {
        "trade_id": trade_id,
        "order_id": order_id,
        "product": product,
        "side": side,
        "size": D(size),
        "price": D(price),
        "commission": D(commission),
        "trade_time": trade_time,
    }
    if trade_type is not OMIT:
        f["trade_type"] = trade_type
    return f


class FakeExchange:
    """The read half of the adapter, scripted per test.

    `orders` is keyed by order id; `list_open_orders` returns the OPEN ones
    unless the id is named in `hidden`, because absence from that list is not
    evidence about an order and the tests need to model both cases.  `fail_get`
    names the ids whose `get_order` raises TransientError (an error for an
    unknown id is PermanentError 404, like the adapter's).  `fail_list` makes the
    whole list call raise.  There is deliberately no place/cancel/deposit
    method: reconcile may not write to the exchange, so a call would raise.
    """

    def __init__(self, orders=(), fills_by_order=None, *, fail_get=(), fail_list=False,
                 hidden=()):
        self.orders = {o["order_id"]: o for o in orders}
        self.fills_by_order = {
            order_id: list(fills) for order_id, fills in (fills_by_order or {}).items()
        }
        self.fail_get = set(fail_get)
        self.fail_list = fail_list
        self.hidden = set(hidden)
        self.list_calls = []
        self.get_calls = []
        self.find_calls = []
        self.fill_calls = []

    def list_open_orders(self, product=None):
        self.list_calls.append(product)
        if self.fail_list:
            raise TransientError("list_open_orders: 503 service unavailable")
        return [
            dict(order)
            for order_id, order in self.orders.items()
            if order["status"] == "OPEN" and order_id not in self.hidden
        ]

    def get_order(self, order_id):
        self.get_calls.append(order_id)
        if order_id in self.fail_get:
            raise TransientError(f"get_order {order_id}: 429 too many requests")
        order = self.orders.get(order_id)
        if order is None:
            raise PermanentError("HTTP 404: order not found")
        return dict(order)

    def find_by_client_id(self, cid, since, product=None):
        self.find_calls.append((cid, since, product))
        for order in self.orders.values():
            if order["client_order_id"] == cid:
                return dict(order)
        return None

    def fills(self, order_id):
        self.fill_calls.append(order_id)
        return [dict(f) for f in self.fills_by_order.get(order_id, [])]


class FakeGateway:
    """The kill path, recorded.  `halted` is settable, `boom` makes it raise."""

    def __init__(self, *, halted=False, boom=None):
        self.halted = halted
        self.boom = boom
        self.calls = []

    def is_halted(self):
        return self.halted

    def cancel_all(self, scope, owner=None):
        self.calls.append((scope, owner))
        if self.boom is not None:
            raise self.boom
        return 0


def cid_for(owner, n, side="B", level="+1"):
    """A client order id in the engine's own cb-<owner>-<side><level>-<hex> form."""
    return f"cb-{owner}-{side}{level}-{n:012x}"


def new_bot(store, bot_id="b1", product=PRODUCT):
    """An ACTIVE bot with a small capital budget."""
    return store.create_bot(bot_id, product, "grid", {}, D("100"), D("50"))


def seed(
    store,
    cid,
    owner,
    *,
    side="BUY",
    level=1,
    price="1.0",
    size="10",
    status=PENDING_SUBMIT,
    order_id=None,
    product=PRODUCT,
    source="bot",
):
    """Insert one order row and return its cid."""
    store.insert_order(
        cid,
        owner,
        source,
        product,
        side,
        level,
        D(price),
        D(size),
        status=status,
        order_id=order_id,
    )
    return cid


def sync(store, exchange, trades_csv, *, now=None, gateway=None):
    """Run one reconcile cycle with the caller's clock and the test's CSV path."""
    return reconcile(
        store,
        exchange,
        time.time() if now is None else now,
        gateway=gateway,
        trades_csv=trades_csv,
    )


def events(store):
    rows = store.conn().execute("SELECT ts, level, message FROM events ORDER BY ts")
    return [dict(r) for r in rows]


def fill_rows(store, trade_id=None):
    if trade_id is None:
        rows = store.conn().execute("SELECT * FROM fills ORDER BY recorded_at")
    else:
        rows = store.conn().execute(
            "SELECT * FROM fills WHERE trade_id=?", (trade_id,)
        )
    return [dict(r) for r in rows]


def csv_rows(path):
    if not Path(path).exists():
        return []
    with open(path, newline="") as fh:
        return list(csv.reader(fh))


def csv_data_rows(path):
    """Every trades.csv row after the header."""
    return csv_rows(path)[1:]


def csv_rows_for(path, trade_id):
    return [row for row in csv_data_rows(path) if trade_id in row]


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "t.db")
    yield s
    s.close()


@pytest.fixture
def trades_csv(tmp_path):
    return tmp_path / "trades.csv"


# ---------------------------------------------------------------- pending submit


def test_pending_submit_resolved(store, trades_csv):
    """A row written before the send resolves to the order the exchange holds."""
    new_bot(store)
    listed = seed(store, cid_for("b1", 1), "b1")
    hidden = seed(store, cid_for("b1", 2), "b1")
    exchange = FakeExchange(
        [snap("ex-1", listed, size="10"), snap("ex-2", hidden, size="10")],
        hidden=["ex-2"],  # the list is not authoritative for absence
    )

    sync(store, exchange, trades_csv)

    row = store.order(listed)
    assert row["status"] == OPEN
    assert row["order_id"] == "ex-1"

    found = store.order(hidden)
    assert found["status"] == OPEN
    assert found["order_id"] == "ex-2"
    assert hidden in [cid for cid, _, _ in exchange.find_calls]
    since = [s for cid, s, _ in exchange.find_calls if cid == hidden][0]
    assert since == found["created_at"]
    assert [p for cid, _, p in exchange.find_calls if cid == hidden] == [PRODUCT]


def test_pending_submit_never_landed_expires(store, trades_csv):
    """No order anywhere: the row survives the window, then fails."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1")
    created = store.order(cid)["created_at"]
    exchange = FakeExchange()

    early = sync(store, exchange, trades_csv, now=created + 299)
    assert store.order(cid)["status"] == PENDING_SUBMIT
    assert early.updated == 0
    assert [c for c, _, _ in exchange.find_calls] == [cid]

    late = sync(store, exchange, trades_csv, now=created + 301)
    row = store.order(cid)
    assert row["status"] == FAILED
    assert late.updated == 1
    assert "never reached the exchange" in (row["note"] or "")


def test_pending_with_order_id_never_expires(store, trades_csv):
    """An order id, however old the row, is settled from get_order and kept."""
    new_bot(store)
    long_ago = time.time() - 10**6
    open_cid = seed(store, cid_for("b1", 1), "b1", order_id="ex-a")
    filled_cid = seed(store, cid_for("b1", 2), "b1", order_id="ex-b")
    error_cid = seed(store, cid_for("b1", 3), "b1", order_id="ex-c")
    for cid in (open_cid, filled_cid, error_cid):
        store.update_order(cid, created_at=long_ago)

    exchange = FakeExchange(
        [
            snap("ex-a", open_cid, size="10"),
            snap(
                "ex-b",
                filled_cid,
                status="FILLED",
                size="10",
                filled_size="10",
                filled_value="9.95",
                total_fees="0.05",
            ),
            snap("ex-c", error_cid, size="10"),
        ],
        fills_by_order={
            "ex-b": [
                trade_fill(
                    "t-b", "ex-b", size="10", price="0.995", commission="0.05"
                )
            ]
        },
        fail_get=["ex-c"],
        hidden=["ex-a", "ex-b", "ex-c"],
    )

    sync(store, exchange, trades_csv)

    resting = store.order(open_cid)
    assert resting["status"] == OPEN
    assert resting["order_id"] == "ex-a"

    done = store.order(filled_cid)
    assert done["status"] == FILLED
    assert done["filled_size"] == D("10")
    assert store.has_fill("t-b")

    broken = store.order(error_cid)
    assert broken["status"] == PENDING_SUBMIT
    assert broken["order_id"] == "ex-c"
    assert any(e["level"] == "warn" for e in events(store))


# ---------------------------------------------------------------- settling


def test_open_row_missing_from_list_settled_via_get_order(store, trades_csv):
    """An OPEN row the list omits is settled from its own snapshot."""
    new_bot(store)
    filled_cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    cancelled_cid = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-2")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                filled_cid,
                status="FILLED",
                size="10",
                filled_size="10",
                filled_value="9.97",
                total_fees="0.05",
            ),
            snap("ex-2", cancelled_cid, status="CANCELLED", size="10"),
        ],
        fills_by_order={
            "ex-1": [
                trade_fill(
                    "t-1", "ex-1", size="10", price="0.997", commission="0.05"
                )
            ]
        },
        hidden=["ex-1", "ex-2"],
    )

    report = sync(store, exchange, trades_csv)

    row = store.order(filled_cid)
    assert row["status"] == FILLED
    assert row["filled_size"] == D("10")
    assert row["filled_value"] == D("9.97")
    assert row["fees"] == D("0.05")
    assert bool(row["fills_ok"]) is True
    assert fill_rows(store, "t-1")
    assert [r["client_order_id"] for r in report.new_fills["b1"]] == [filled_cid]

    cancelled = store.order(cancelled_cid)
    assert cancelled["status"] == CANCELLED
    assert cancelled["filled_size"] == D("0")
    assert cancelled_cid not in [
        r["client_order_id"] for r in report.new_fills.get("b1", [])
    ]


def test_external_cancel_and_orphans(store, trades_csv):
    """A cancel made in the exchange UI wins; a stranger's cb- order is adopted."""
    new_bot(store)
    cancelled_cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    adopted_cid = cid_for("b1", 2)
    exchange = FakeExchange(
        [
            snap("ex-1", cancelled_cid, status="CANCELLED", size="10"),
            snap("ex-2", adopted_cid, size="10"),
            snap("ex-manual", "manual-1", size="4"),
        ]
    )

    sync(store, exchange, trades_csv, gateway=None)

    assert store.order(cancelled_cid)["status"] == CANCELLED

    adopted = store.order(adopted_cid)
    assert adopted is not None
    assert adopted["status"] == OPEN
    assert adopted["order_id"] == "ex-2"
    assert adopted["owner"] == "b1"
    assert adopted["source"] == "bot"
    assert "adopted" in (adopted["note"] or "")

    # "manual-1" is not ours: no row, and no per-order lookups for it.
    assert store.order("manual-1") is None
    assert "ex-manual" not in exchange.get_calls
    assert "ex-manual" not in exchange.fill_calls
    assert len(store.orders()) == 2


def test_unknown_owner_becomes_orphan_not_cancelled(store, trades_csv):
    """A cb- order whose bot is gone is adopted as an orphan, and left alone."""
    new_bot(store, "b1")
    gone = "cb-gone-B+1-0000000000aa"
    exchange = FakeExchange([snap("ex-gone", gone, size="10")])
    gateway = FakeGateway()  # running, not halted

    report = sync(store, exchange, trades_csv, gateway=gateway)

    row = store.order(gone)
    assert row is not None
    assert row["owner"] == "orphan"
    assert row["status"] == OPEN
    assert "adopted" in (row["note"] or "")
    assert "orphan" in (row["note"] or "")
    assert report.orphans == [gone]
    assert gateway.calls == []

    again = sync(store, exchange, trades_csv, gateway=gateway)
    assert len(store.orders()) == 1
    assert again.orphans == [gone]
    assert gateway.calls == []


# ---------------------------------------------------------------- fills


def test_two_bots_same_product_fills_route_by_prefix(store, trades_csv):
    """Two bots on one product keep their own fills, and a kill hits only one."""
    new_bot(store, "b1")
    new_bot(store, "b2")
    c1 = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    c2 = seed(store, cid_for("b2", 1), "b2", status=OPEN, order_id="ex-2")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                c1,
                status="FILLED",
                filled_size="10",
                filled_value="9.90",
                total_fees="0.05",
            ),
            snap(
                "ex-2",
                c2,
                status="FILLED",
                filled_size="10",
                filled_value="10.10",
                total_fees="0.02",
            ),
        ],
        fills_by_order={
            "ex-1": [
                trade_fill("t-1", "ex-1", size="10", price="0.99", commission="0.05")
            ],
            "ex-2": [
                trade_fill("t-2", "ex-2", size="10", price="1.01", commission="0.02")
            ],
        },
        hidden=["ex-1", "ex-2"],
    )

    report = sync(store, exchange, trades_csv)

    assert set(report.new_fills) == {"b1", "b2"}
    assert [r["client_order_id"] for r in report.new_fills["b1"]] == [c1]
    assert [r["client_order_id"] for r in report.new_fills["b2"]] == [c2]
    owners = {r["trade_id"]: r["owner"] for r in fill_rows(store)}
    assert owners == {"t-1": "b1", "t-2": "b2"}

    # b1 is stopped: its resting order is swept, b2's is not.
    o1 = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-3")
    o2 = seed(store, cid_for("b2", 2), "b2", status=OPEN, order_id="ex-4")
    exchange.orders["ex-3"] = snap("ex-3", o1, size="10")
    exchange.orders["ex-4"] = snap("ex-4", o2, size="10")
    store.set_bot_status("b1", STOPPED)
    gateway = FakeGateway()

    sync(store, exchange, trades_csv, gateway=gateway)

    assert gateway.calls == [("owner", "b1")]


def test_fill_recorded_once_across_two_reconciles(store, trades_csv, monkeypatch):
    """A fill is booked once: no second fills row, no second trades.csv row."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                cid,
                status="FILLED",
                filled_size="10",
                filled_value="10",
                total_fees="0.05",
            )
        ],
        fills_by_order={
            "ex-1": [
                trade_fill("t-1", "ex-1", size="10", price="1.0", commission="0.05")
            ]
        },
        hidden=["ex-1"],
    )

    sync(store, exchange, trades_csv)
    assert len(fill_rows(store)) == 1
    assert len(csv_data_rows(trades_csv)) == 1
    assert csv_rows_for(trades_csv, "t-1")

    second = sync(store, exchange, trades_csv)
    assert second.updated == 0
    assert len(fill_rows(store)) == 1
    assert len(csv_data_rows(trades_csv)) == 1
    assert second.new_fills == {}

    # A trade already in the fills table (booked by the stream, say) adds no
    # trades.csv row of its own.
    pre_cid = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-2")
    pre_fill = trade_fill("t-2", "ex-2", size="10", price="1.0")
    store.record_fill(pre_fill, pre_cid)
    exchange.orders["ex-2"] = snap(
        "ex-2", pre_cid, status="FILLED", filled_size="10", filled_value="10"
    )
    exchange.fills_by_order["ex-2"] = [pre_fill]
    exchange.hidden.add("ex-2")

    sync(store, exchange, trades_csv)
    assert store.has_fill("t-2")
    assert csv_rows_for(trades_csv, "t-2") == []
    assert len(csv_data_rows(trades_csv)) == 1

    # CSV first, database second: a crash between the two may leave the CSV row
    # behind, and the next cycle books the fill without a second fills row.
    crash_cid = seed(store, cid_for("b1", 3), "b1", status=OPEN, order_id="ex-3")
    crash_fill = trade_fill("t-3", "ex-3", size="10", price="1.0")
    exchange.orders["ex-3"] = snap(
        "ex-3", crash_cid, status="FILLED", filled_size="10", filled_value="10"
    )
    exchange.fills_by_order["ex-3"] = [crash_fill]
    exchange.hidden.add("ex-3")

    real_record_fill = store.record_fill

    def broken(fill, cid):
        raise RuntimeError("database went away after the CSV write")

    monkeypatch.setattr(store, "record_fill", broken)
    with contextlib.suppress(Exception):
        sync(store, exchange, trades_csv)
    assert csv_rows_for(trades_csv, "t-3")

    monkeypatch.setattr(store, "record_fill", real_record_fill)
    sync(store, exchange, trades_csv)
    assert len(fill_rows(store, "t-3")) == 1
    assert csv_rows_for(trades_csv, "t-3")


def test_null_trade_type_counts_as_fill(store, trades_csv):
    """A null or absent trade_type is a FILL; CORRECTION is not counted."""
    new_bot(store)
    null_cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    partial_cid = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-2")
    correction_cid = seed(store, cid_for("b1", 3), "b1", status=OPEN, order_id="ex-3")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                null_cid,
                status="FILLED",
                filled_size="10",
                filled_value="10",
                total_fees="0.05",
            ),
            snap(
                "ex-2",
                partial_cid,
                status="FILLED",
                filled_size="10",
                filled_value="10",
                total_fees="0.05",
            ),
            snap(
                "ex-3",
                correction_cid,
                status="FILLED",
                filled_size="10",
                filled_value="10",
                total_fees="0.05",
            ),
        ],
        fills_by_order={
            "ex-1": [
                trade_fill("t-null", "ex-1", size="6", price="1.0", trade_type=None),
                trade_fill("t-missing", "ex-1", size="4", price="1.0", trade_type=OMIT),
            ],
            "ex-2": [trade_fill("t-partial", "ex-2", size="4", price="1.0")],
            "ex-3": [
                trade_fill("t-small", "ex-3", size="4", price="1.0"),
                trade_fill(
                    "t-fixup", "ex-3", size="6", price="1.0", trade_type="CORRECTION"
                ),
            ],
        },
        hidden=["ex-1", "ex-2", "ex-3"],
    )

    sync(store, exchange, trades_csv)

    assert bool(store.order(null_cid)["fills_ok"]) is True
    assert bool(store.order(partial_cid)["fills_ok"]) is False
    assert bool(store.order(correction_cid)["fills_ok"]) is False

    # The missing FILL shows up on the exchange: the next cycle sets fills_ok.
    exchange.fills_by_order["ex-2"].append(
        trade_fill("t-rest", "ex-2", size="6", price="1.0")
    )
    sync(store, exchange, trades_csv)
    assert bool(store.order(partial_cid)["fills_ok"]) is True
    assert len(fill_rows(store, "t-rest")) == 1


def test_partial_fill_then_cancel_records_filled_part(store, trades_csv):
    """A partial fill is booked while the order rests, and again after a cancel."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                cid,
                size="10",
                filled_size="6",
                filled_value="5.94",
                total_fees="0.03",
            )
        ],
        fills_by_order={
            "ex-1": [
                trade_fill("t-1", "ex-1", size="6", price="0.99", commission="0.03")
            ]
        },
    )

    resting = sync(store, exchange, trades_csv)
    row = store.order(cid)
    assert row["status"] == OPEN
    assert row["filled_size"] == D("6")
    assert bool(row["fills_ok"]) is True
    assert cid not in [r["client_order_id"] for r in resting.new_fills.get("b1", [])]

    exchange.orders["ex-1"] = snap(
        "ex-1",
        cid,
        status="CANCELLED",
        size="10",
        filled_size="6",
        filled_value="5.94",
        total_fees="0.03",
    )
    killed = sync(store, exchange, trades_csv)
    row = store.order(cid)
    assert row["status"] == CANCELLED
    assert row["filled_size"] == D("6")
    assert cid in [r["client_order_id"] for r in killed.new_fills["b1"]]

    # A second partial arrives while the order still rests: the absolute
    # filled_size moves to 9 and fills_ok has to be earned again.
    grow_cid = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-2")
    exchange.orders["ex-2"] = snap(
        "ex-2",
        grow_cid,
        size="10",
        filled_size="6",
        filled_value="5.94",
        total_fees="0.03",
    )
    exchange.fills_by_order["ex-2"] = [
        trade_fill("t-2", "ex-2", size="6", price="0.99", commission="0.03")
    ]

    sync(store, exchange, trades_csv)
    assert store.order(grow_cid)["filled_size"] == D("6")
    assert bool(store.order(grow_cid)["fills_ok"]) is True

    exchange.orders["ex-2"] = snap(
        "ex-2",
        grow_cid,
        size="10",
        filled_size="9",
        filled_value="8.90",
        total_fees="0.04",
    )
    sync(store, exchange, trades_csv)
    grown = store.order(grow_cid)
    assert grown["status"] == OPEN
    assert grown["filled_size"] == D("9")
    assert bool(grown["fills_ok"]) is False  # reset by the absolute update

    exchange.fills_by_order["ex-2"].append(
        trade_fill("t-3", "ex-2", size="3", price="0.99", commission="0.01")
    )
    sync(store, exchange, trades_csv)
    grown = store.order(grow_cid)
    assert bool(grown["fills_ok"]) is True
    assert len(fill_rows(store)) == 3


# ---------------------------------------------------------------- kill gap


def test_halted_or_stopped_owner_open_order_is_cancelled_via_gateway(store, trades_csv):
    """Kills go through the gateway's cancel_all and never through the exchange."""
    # (a) a halt sweeps every cb- order that is still live, in one call.
    new_bot(store, "a1")
    new_bot(store, "a2")
    a1 = seed(store, cid_for("a1", 1), "a1", status=OPEN, order_id="ex-a1")
    a2 = seed(store, cid_for("a2", 1), "a2", status=OPEN, order_id="ex-a2")
    gone = "cb-gone-B+1-0000000000aa"
    exchange = FakeExchange(
        [
            snap("ex-a1", a1, size="10"),
            snap("ex-a2", a2, size="10"),
            snap("ex-gone", gone, size="10"),
        ]
    )

    halted = FakeGateway(halted=True)
    sync(store, exchange, trades_csv, gateway=halted)
    assert halted.calls == [("all", None)]

    # The exchange has no write method at all: a place or cancel attempted by
    # reconcile would raise AttributeError and fail this test.
    assert not any(hasattr(exchange, name) for name in ("place_limit", "cancel"))

    # (b) not halted: only the stopped owner's order is swept.
    new_bot(store, "b1")
    new_bot(store, "b2")
    b1 = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-b1")
    b2 = seed(store, cid_for("b2", 1), "b2", status=OPEN, order_id="ex-b2")
    exchange.orders["ex-b1"] = snap("ex-b1", b1, size="10")
    exchange.orders["ex-b2"] = snap("ex-b2", b2, size="10")
    store.set_bot_status("b1", STOPPED)

    quiet = FakeGateway()
    sync(store, exchange, trades_csv, gateway=quiet)
    assert quiet.calls == [("owner", "b1")]

    # (c) no gateway: a stopped owner is left resting, and nothing crashes.
    new_bot(store, "c1")
    c1 = seed(store, cid_for("c1", 1), "c1", status=OPEN, order_id="ex-c1")
    exchange.orders["ex-c1"] = snap("ex-c1", c1, size="10")
    store.set_bot_status("c1", STOPPED)

    sync(store, exchange, trades_csv, gateway=None)
    assert store.order(c1)["status"] == OPEN

    # (d) a failing cancel_all is reported and the cycle still returns.
    new_bot(store, "d1")
    d1 = seed(store, cid_for("d1", 1), "d1", status=OPEN, order_id="ex-d1")
    exchange.orders["ex-d1"] = snap("ex-d1", d1, size="10")
    store.set_bot_status("d1", STOPPED)

    before = len(events(store))
    angry = FakeGateway(boom=RuntimeError("cancel_all died"))
    report = sync(store, exchange, trades_csv, gateway=angry)
    assert report is not None
    assert len(events(store)) > before


def test_non_cb_orders_ignored(store, trades_csv):
    """Only cb- ids are ours; an ai order is adopted, a manual one never is."""
    new_bot(store)
    ai_cid = cid_for("ai", 1)
    exchange = FakeExchange(
        [snap("ex-manual", "manual-1", size="3"), snap("ex-ai", ai_cid, size="5")]
    )

    sync(store, exchange, trades_csv)

    assert store.order("manual-1") is None
    assert [r["client_order_id"] for r in store.orders()] == [ai_cid]
    assert "ex-manual" not in exchange.get_calls
    assert "ex-manual" not in exchange.fill_calls
    assert exchange.list_calls == [None]

    row = store.order(ai_cid)
    assert row["owner"] == "ai"
    assert row["source"] == "ai"
    assert row["status"] == OPEN
    assert row["order_id"] == "ex-ai"


# ---------------------------------------------------------------- failures


def test_exchange_list_failure_propagates(store, trades_csv):
    """A failing list call is not swallowed: the cycle raises and writes nothing."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", order_id="ex-1")
    exchange = FakeExchange([snap("ex-1", cid, size="10")], fail_list=True)

    with pytest.raises(TransientError):
        sync(store, exchange, trades_csv)

    row = store.order(cid)
    assert row["status"] == PENDING_SUBMIT
    assert row["order_id"] == "ex-1"
    assert exchange.get_calls == []
    assert events(store) == []
    assert not Path(trades_csv).exists()


def test_get_order_failure_skips_row(store, trades_csv):
    """A get_order error skips its row only; the other row still settles."""
    new_bot(store)
    broken_cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-broken")
    good_cid = seed(store, cid_for("b1", 2), "b1", status=OPEN, order_id="ex-good")
    exchange = FakeExchange(
        [
            snap("ex-broken", broken_cid, size="10"),
            snap(
                "ex-good",
                good_cid,
                status="FILLED",
                filled_size="10",
                filled_value="10",
                total_fees="0.05",
            ),
        ],
        fills_by_order={
            "ex-good": [trade_fill("t-good", "ex-good", size="10", price="1.0")]
        },
        fail_get=["ex-broken"],
        hidden=["ex-broken", "ex-good"],
    )

    report = sync(store, exchange, trades_csv)

    broken = store.order(broken_cid)
    assert broken["status"] == OPEN
    assert broken["filled_size"] == D("0")
    assert bool(broken["fills_ok"]) is False

    good = store.order(good_cid)
    assert good["status"] == FILLED
    assert store.has_fill("t-good")
    assert good_cid in [r["client_order_id"] for r in report.new_fills["b1"]]
    assert any(e["level"] == "warn" for e in events(store))


# ---------------------------------------------------------------- status mapping


@pytest.mark.parametrize(
    "exchange_status,local_status",
    [
        ("FILLED", FILLED),
        ("CANCELLED", CANCELLED),
        ("EXPIRED", CANCELLED),
        ("FAILED", FAILED),
        ("CANCEL_QUEUED", OPEN),
        ("PENDING", OPEN),
        ("QUEUED", OPEN),
        ("SOMETHING_NEW", OPEN),
    ],
)
def test_status_map_table(store, trades_csv, exchange_status, local_status):
    """A snapshot status settles a live row to the local status the table names.

    Only FILLED, CANCELLED, EXPIRED and FAILED settle an order: a cancel that is
    merely queued, a pending order and a status this module does not know all
    leave the order resting, so nothing is settled on a reading it cannot
    interpret.
    """
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [snap("ex-1", cid, status=exchange_status, size="10", filled_size="0")],
        hidden=["ex-1"],
    )

    sync(store, exchange, trades_csv)

    assert store.order(cid)["status"] == local_status


def test_cancel_queued_stays_live_then_cancelled_records_final_fill(
    store, trades_csv
):
    """A queued cancel leaves the order live; the real cancel records the fill."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [
            snap(
                "ex-1",
                cid,
                status="CANCEL_QUEUED",
                size="10",
                filled_size="4",
                filled_value="4.00",
            )
        ],
        fills_by_order={
            "ex-1": [trade_fill("t-1", "ex-1", size="4", price="1.0")]
        },
    )

    queued = sync(store, exchange, trades_csv)
    row = store.order(cid)
    assert row["status"] == OPEN
    assert row["filled_size"] == D("4")
    assert cid not in [
        r["client_order_id"] for r in queued.new_fills.get("b1", [])
    ]

    exchange.orders["ex-1"] = snap(
        "ex-1",
        cid,
        status="CANCELLED",
        size="10",
        filled_size="9",
        filled_value="9.00",
    )
    exchange.fills_by_order["ex-1"] = [
        trade_fill("t-1", "ex-1", size="4", price="1.0"),
        trade_fill("t-2", "ex-1", size="5", price="1.0"),
    ]

    killed = sync(store, exchange, trades_csv)
    row = store.order(cid)
    assert row["status"] == CANCELLED
    assert row["filled_size"] == D("9")
    assert bool(row["fills_ok"]) is True
    reported = [
        r for r in killed.new_fills["b1"] if r["client_order_id"] == cid
    ]
    assert len(reported) == 1
    assert reported[0]["filled_size"] == D("9")
    assert len(fill_rows(store)) == 2

    third = sync(store, exchange, trades_csv)
    assert third.new_fills == {}


# ---------------------------------------------------------------- owner prefixes


def test_adopt_prefix_collision_orphan(store, trades_csv):
    """An id for b10 is not b1's order, however b1-prefixed it looks."""
    new_bot(store, "b1")
    cid = "cb-b10-B+1-0000000000bb"
    exchange = FakeExchange([snap("ex-10", cid, size="10")])

    report = sync(store, exchange, trades_csv)

    row = store.order(cid)
    assert row is not None
    assert row["owner"] == "orphan"
    assert row["status"] == OPEN
    assert "adopted" in (row["note"] or "")
    assert report.orphans == [cid]


def test_stopped_owner_sweep_does_not_hit_prefix_neighbour(store, trades_csv):
    """Stopping b1 sweeps b1's order and leaves b10's order resting."""
    new_bot(store, "b1")
    new_bot(store, "b10")
    c1 = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    c10 = seed(store, cid_for("b10", 1), "b10", status=OPEN, order_id="ex-10")
    exchange = FakeExchange(
        [snap("ex-1", c1, size="10"), snap("ex-10", c10, size="10")]
    )
    store.set_bot_status("b1", STOPPED)
    gateway = FakeGateway()

    sync(store, exchange, trades_csv, gateway=gateway)

    assert gateway.calls == [("owner", "b1")]


def test_unparseable_cb_id_adopted_at_level_zero(store, trades_csv, tmp_path):
    """A cb- id that is not the engine's shape still gets a row, at level 0."""
    new_bot(store, "b1")
    cid = "cb-b1-weird"
    exchange = FakeExchange([snap("ex-weird", cid, side="SELL", size="10")])

    sync(store, exchange, trades_csv)

    row = store.order(cid)
    assert row is not None
    assert row["owner"] == "b1"
    assert row["level"] == 0
    assert row["side"] == "SELL"

    # The same id with no b1 bot row: nobody owns it, so it is an orphan.
    other = Store(tmp_path / "other.db")
    try:
        other_exchange = FakeExchange(
            [snap("ex-weird", cid, side="SELL", size="10")]
        )
        sync(other, other_exchange, tmp_path / "other.csv")

        orphan = other.order(cid)
        assert orphan is not None
        assert orphan["owner"] == "orphan"
        assert orphan["level"] == 0
        assert orphan["side"] == "SELL"
    finally:
        other.close()


# ---------------------------------------------------------------- ai owner


def test_ai_order_adopted_and_swept_only_on_halt(store, trades_csv):
    """The ai owner's order is adopted, and only a halt sweeps it."""
    cid = cid_for("ai", 1)
    exchange = FakeExchange([snap("ex-ai", cid, size="5")])

    quiet = FakeGateway()
    sync(store, exchange, trades_csv, gateway=quiet)

    row = store.order(cid)
    assert row is not None
    assert row["owner"] == "ai"
    assert row["source"] == "ai"
    assert row["status"] == OPEN
    assert quiet.calls == []

    halted = FakeGateway(halted=True)
    sync(store, exchange, trades_csv, gateway=halted)
    assert halted.calls == [("all", None)]


# ---------------------------------------------------------------- fill guards


def test_wrong_product_fill_left_unbooked_warned_once(store, trades_csv):
    """A fill for another product is never booked, and is warned about once."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [snap("ex-1", cid, size="10", filled_size="4", filled_value="4.00")],
        fills_by_order={
            "ex-1": [trade_fill("t-wrong", "ex-1", product="BTC-USDC", size="4")]
        },
    )

    sync(store, exchange, trades_csv)

    assert fill_rows(store) == []
    assert csv_data_rows(trades_csv) == []
    assert len([e for e in events(store) if e["level"] == "warn"]) == 1
    assert bool(store.order(cid)["fills_ok"]) is False

    sync(store, exchange, trades_csv)

    assert fill_rows(store) == []
    assert csv_data_rows(trades_csv) == []
    assert len([e for e in events(store) if e["level"] == "warn"]) == 1
    assert bool(store.order(cid)["fills_ok"]) is False


def test_fill_with_other_order_id_skipped_with_warning(store, trades_csv):
    """A fill naming another order id belongs elsewhere: skip it, and say so."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    exchange = FakeExchange(
        [snap("ex-1", cid, size="10", filled_size="4", filled_value="4.00")],
        fills_by_order={
            "ex-1": [trade_fill("t-elsewhere", "ex-999", size="4")]
        },
    )

    sync(store, exchange, trades_csv)

    assert fill_rows(store, "t-elsewhere") == []
    assert csv_rows_for(trades_csv, "t-elsewhere") == []
    assert any(e["level"] == "warn" for e in events(store))


@pytest.mark.parametrize("trade_id_state", ["null", "missing"])
def test_fill_without_trade_id_warns(store, trades_csv, trade_id_state):
    """A fill with no trade id cannot be booked, so it is warned about instead."""
    new_bot(store)
    cid = seed(store, cid_for("b1", 1), "b1", status=OPEN, order_id="ex-1")
    fill = trade_fill("t-none", "ex-1", size="4", price="1.0")
    if trade_id_state == "null":
        fill["trade_id"] = None
    else:
        del fill["trade_id"]
    exchange = FakeExchange(
        [snap("ex-1", cid, size="10", filled_size="4", filled_value="4.00")],
        fills_by_order={"ex-1": [fill]},
    )

    sync(store, exchange, trades_csv)

    assert fill_rows(store) == []
    assert csv_data_rows(trades_csv) == []
    assert any(e["level"] == "warn" for e in events(store))


# ---------------------------------------------------------------- the updated count


def test_updated_counts_rows_once(store, trades_csv):
    """`updated` counts a row once, however many writes settle it."""
    new_bot(store)
    cid = cid_for("b1", 1)
    exchange = FakeExchange(
        [snap("ex-1", cid, size="10", filled_size="3", filled_value="3.00")],
        fills_by_order={
            "ex-1": [trade_fill("t-1", "ex-1", size="3", price="1.0")]
        },
    )

    adopted = sync(store, exchange, trades_csv)
    row = store.order(cid)
    assert row is not None
    assert row["owner"] == "b1"
    assert row["filled_size"] == D("3")
    assert bool(row["fills_ok"]) is True
    assert adopted.updated == 1

    unchanged = sync(store, exchange, trades_csv)
    assert unchanged.updated == 0
    assert len(fill_rows(store)) == 1
    assert len(csv_data_rows(trades_csv)) == 1

    # The order settles at the exchange: one further row change, counted once.
    exchange.orders["ex-1"] = snap(
        "ex-1",
        cid,
        status="FILLED",
        size="10",
        filled_size="10",
        filled_value="10.00",
    )
    exchange.fills_by_order["ex-1"].append(
        trade_fill("t-2", "ex-1", size="7", price="1.0")
    )

    settled = sync(store, exchange, trades_csv)
    assert settled.updated == 1
    assert store.order(cid)["status"] == FILLED