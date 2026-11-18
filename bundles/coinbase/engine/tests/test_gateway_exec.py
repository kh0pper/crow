"""gateway.py execution: submit, the post-only retry loop, cancels, halt and seeding.

Every test runs on the real wall clock, like the check-chain suite: `store`
stamps `created_at` with `time.time()` and the `CapWindow` is built on the same
clock, so the caps see the rows the tests write.  `sleep` is a no-op by default
so a retry loop never waits; the one test that cares about the backoff passes a
recording callable instead.

The exchange is a `ScriptedExchange`: it records every call and answers from a
per-test script, so the send/adopt/reprice paths run without a network and
without guessing at a real book.  The dry-run end-to-end test uses the real
`DryRunExchange` over the store's own connection.
"""

import re
import threading
import time
from decimal import Decimal as D

import pytest

from crow_coinbase import money
from crow_coinbase.exchange import (
    DryRunExchange,
    PermanentError,
    TransientError,
    new_client_order_id,
)
from crow_coinbase.gateway import (
    EXCHANGE_REJECTED,
    HALTED,
    NOT_CANCELLABLE,
    NOT_OWNER,
    ORDER_TOO_LARGE,
    POST_ONLY_EXHAUSTED,
    GatewayResult,
    OrderGateway,
)
from crow_coinbase.ledger import Ledger
from crow_coinbase.limits import CapWindow, Limits
from crow_coinbase.money import ProductSpec
from crow_coinbase.snapshot import SnapshotCache
from crow_coinbase.store import (
    CANCELLED,
    FILLED,
    OPEN,
    PENDING_SUBMIT,
    REJECTED,
    Store,
)
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
FEE_RATE = D("0.005")

POST_ONLY = "INVALID_LIMIT_PRICE_POST_ONLY"


# ---------------------------------------------------------------- harness


class ScriptedExchange:
    """A stand-in exchange that records calls and answers from a script.

    `place_script` is consumed one entry per `place_limit` call: a result dict, an
    exception INSTANCE to raise, or the string "land_then_timeout" (the order
    reaches the book and the answer is lost, carrying `landed_status`).  An empty
    script answers the happy path with `ex-<n>`.  `find_by_client_id` answers from
    `landed`, unless `find_script` raises first.  `on_place` runs at the start of
    every place with the cid, so a test can look at the store row at call time or
    trip a halt.
    """

    def __init__(
        self,
        *,
        open_orders=None,
        place_script=None,
        find_script=None,
        on_place=None,
        landed_status="OPEN",
    ):
        self.place_calls = []
        self.find_calls = []
        self.cancel_calls = []
        self.list_calls = []
        self.open_orders = list(open_orders or ())
        self.landed = {}
        self.place_script = list(place_script or ())
        self.find_script = list(find_script or ())
        self.on_place = on_place
        # The status the exchange reports for an order whose answer was lost.
        self.landed_status = landed_status
        self._sent = 0

    def new_client_order_id(self, prefix, side, level):
        return new_client_order_id(prefix, side, level)

    def place_limit(self, cid, product, side, size, price):
        if self.on_place is not None:
            self.on_place(cid)
        self.place_calls.append((cid, product, side, size, price))
        step = self.place_script.pop(0) if self.place_script else None
        if step is None:
            self._sent += 1
            return {"ok": True, "order_id": f"ex-{self._sent}", "reason": None}
        if isinstance(step, str):
            assert step == "land_then_timeout"
            self.landed[cid] = exchange_order(
                cid, "ex-landed", side=side, status=self.landed_status
            )
            raise TransientError("answer lost after the order landed")
        if isinstance(step, Exception):
            raise step
        return step

    def find_by_client_id(self, cid, since, product=None):
        self.find_calls.append(cid)
        if self.find_script:
            step = self.find_script.pop(0)
            if isinstance(step, Exception):
                raise step
        return self.landed.get(cid)

    def cancel(self, order_ids):
        self.cancel_calls.append(list(order_ids))
        return {order_id: True for order_id in order_ids}

    def list_open_orders(self, product=None):
        self.list_calls.append(product)
        return list(self.open_orders)


def exchange_order(cid, order_id, side="BUY", product=PRODUCT, status="OPEN"):
    """One normalized exchange order dict, shaped like the adapter's own."""
    return {
        "order_id": order_id,
        "client_order_id": cid,
        "product": product,
        "side": side,
        "status": status,
        "price": D("0.95"),
        "size": D("10"),
    }


class FakeMarket:
    """The public market data the dry-run exchange asks for: a fixed book."""

    def best_bid_ask(self):
        return BID, ASK


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
    """Extra stores (independent order tables) closed when the test ends."""
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


def ready_cache(*, skew=0.0, ts=None):
    cache = SnapshotCache()
    cache.put(snapshot(ts))
    cache.set_clock(100.0 + skew, 100.0)  # server - local == skew
    return cache


class ChangingSnapshots:
    """A snapshot cache whose book changes on every read.

    `books` is a list of (bid, ask) pairs; the last pair repeats forever.  Every
    `get(product)` builds a NEW snapshot from the next pair and records it in
    `served`, so a test can count the book evaluations one submit made and see
    which book each of them priced against.  Only `get` and `skew_s` are there,
    the two reads the gateway makes of a cache; the skew is fresh and zero.
    """

    def __init__(self, books):
        self.books = [(D(bid), D(ask)) for bid, ask in books]
        self.served = []

    def get(self, product):
        index = min(len(self.served), len(self.books) - 1)
        bid, ask = self.books[index]
        snap = snapshot(bid=bid, ask=ask, product=product)
        self.served.append(snap)
        return snap

    def skew_s(self):
        return 0.0


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
    sleep=None,
    max_post_only_retries=5,
    **overrides,
):
    """A gateway whose retry loop never actually sleeps unless asked to."""
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
        max_post_only_retries=max_post_only_retries,
        sleep=(lambda seconds: None) if sleep is None else sleep,
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
    status=PENDING_SUBMIT,
    price=D("0.95"),
    size=D("10"),
    cid_suffix=1,
    side="BUY",
    product=PRODUCT,
    level=-1,
    order_id=None,
    cid=None,
):
    """Insert a local order row the engine's own way (`cb-<owner>-...` id)."""
    cid = cid or f"cb-{owner}-B0-{cid_suffix:012x}"
    store.insert_order(
        cid, owner, source, product, side, level, price, size, status=status
    )
    if order_id is not None:
        store.update_order(cid, order_id=order_id)
    return cid


# ---------------------------------------------------------------- happy path


def test_happy_path_post_only_with_prefix(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    at_place = {}

    def on_place(cid):
        if "row" not in at_place:
            at_place["row"] = store.order(cid)

    exchange.on_place = on_place

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None
    cid = res.cid
    assert re.fullmatch(r"cb-b1-B-1-[0-9a-f]{12}", cid)

    assert exchange.place_calls == [(cid, PRODUCT, "BUY", D("10"), D("0.95"))]

    # The row was already on record when the exchange was called: a timeout can
    # never leave an order the engine has no name for.
    assert at_place["row"] is not None
    assert at_place["row"]["status"] == PENDING_SUBMIT

    row = store.order(cid)
    assert row["status"] == OPEN
    assert row["order_id"] == "ex-1"
    assert row["source"] == "bot"
    assert row["owner"] == "b1"
    assert row["price"] == D("0.95")
    assert row["level"] == -1
    assert len(store.orders()) == 1

    sell = gw.submit("bot", "b1", place(side="SELL", price=D("1.01"), level=2))
    assert sell.ok is True
    assert sell.refusal is None
    assert re.fullmatch(r"cb-b1-S\+2-[0-9a-f]{12}", sell.cid)
    assert store.order(sell.cid)["status"] == OPEN


def test_refusal_does_not_touch_exchange_or_store(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)
    gw.halt("kill")

    assert gw.submit("bot", "b1", place()) == GatewayResult(False, None, HALTED)
    assert exchange.place_calls == []
    assert store.orders() == []


def test_submit_runs_under_lock(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)
    probed = {}

    def on_place(cid):
        # A second thread, so a reentrant lock is not mistaken for a free one.
        outcome = {}

        def probe():
            got = gw.lock.acquire(blocking=False)
            outcome["acquired"] = got
            if got:
                gw.lock.release()

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join(timeout=5)
        probed["acquired"] = outcome.get("acquired")

    exchange.on_place = on_place

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert probed["acquired"] is False

    # ... and the cycle lock is free again once the submit returns.
    assert gw.lock.acquire(blocking=False) is True
    gw.lock.release()


# ---------------------------------------------------------------- timeouts


def test_timeout_after_order_landed_does_not_double_place(store):
    exchange = ScriptedExchange(place_script=["land_then_timeout"])
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None

    assert len(exchange.place_calls) == 1
    assert exchange.find_calls == [res.cid]

    row = store.order(res.cid)
    assert row["status"] == OPEN
    assert row["order_id"] == "ex-landed"
    assert len(store.orders()) == 1


def test_adopted_filled_order_is_not_marked_open(store):
    """An adopted order the exchange reports as FILLED stays PENDING_SUBMIT.

    Only the id is recorded: reconcile's pending path looks the row up and
    applies the fills, which a terminal status written here would skip.
    """
    exchange = ScriptedExchange(
        place_script=["land_then_timeout"], landed_status=FILLED
    )
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None
    assert len(exchange.place_calls) == 1

    row = store.order(res.cid)
    assert row["status"] == PENDING_SUBMIT
    assert row["order_id"] == "ex-landed"


def test_adopted_cancelled_order_is_not_marked_cancelled(store):
    """An adopted order the exchange reports as CANCELLED also stays PENDING_SUBMIT."""
    exchange = ScriptedExchange(
        place_script=["land_then_timeout"], landed_status="CANCELLED"
    )
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None
    assert len(exchange.place_calls) == 1

    row = store.order(res.cid)
    assert row["status"] == PENDING_SUBMIT
    assert row["order_id"] == "ex-landed"


def test_failed_lookup_does_not_reject_a_possibly_live_order(store):
    """A lookup that errors is not evidence the order failed: the row stays live."""
    exchange = ScriptedExchange(
        place_script=[TransientError("lost")],
        find_script=[PermanentError("lookup refused")],
    )
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None
    assert len(exchange.place_calls) == 1

    row = store.order(res.cid)
    assert row["status"] == PENDING_SUBMIT


def test_timeout_before_landing_resends_same_cid(store):
    exchange = ScriptedExchange(place_script=[TransientError("outcome unknown")])
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None

    assert len(exchange.place_calls) == 2
    assert [call[0] for call in exchange.place_calls] == [res.cid, res.cid]
    assert exchange.find_calls == [res.cid]

    assert len(store.orders()) == 1
    assert store.order(res.cid)["status"] == OPEN


def test_unknown_outcome_leaves_pending_submit(store, make_store):
    def run(at, find_script):
        slept = []
        exchange = ScriptedExchange(
            place_script=[TransientError("down")] * 3, find_script=find_script
        )
        gw = make_gateway(at, exchange=exchange, sleep=slept.append)

        res = gw.submit("bot", "b1", place())
        assert res.ok is True
        assert res.refusal is None
        assert res.cid

        assert len(exchange.place_calls) == 3
        assert {call[0] for call in exchange.place_calls} == {res.cid}
        assert len(exchange.find_calls) == 3

        row = at.order(res.cid)
        assert row["status"] == PENDING_SUBMIT
        assert row["order_id"] is None
        assert len(at.orders()) == 1
        assert slept
        assert all(delay >= 0 for delay in slept)
        return res

    run(store, [])
    # A lookup that itself fails counts as "not found": same outcome, same row.
    run(make_store("find-down.db"), [TransientError("lookup down")] * 3)


# ---------------------------------------------------------------- post-only


REPRICE_CASES = (
    ("buy", "BUY", D("0.95"), D("0.9499"), -1),
    ("sell", "SELL", D("1.01"), D("1.0101"), 2),
)


@pytest.mark.parametrize(
    "case,side,level_price,retry_price,level",
    REPRICE_CASES,
    ids=[c[0] for c in REPRICE_CASES],
)
def test_post_only_rejection_reprices_one_tick_away(
    store, case, side, level_price, retry_price, level
):
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": POST_ONLY}]
    )
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place(side=side, price=level_price, level=level))
    assert res.ok is True
    assert res.refusal is None

    assert len(exchange.place_calls) == 2
    first, second = exchange.place_calls
    assert first[0] != second[0]  # a fresh id for the new attempt
    assert first[1] == PRODUCT and first[2] == side and first[3] == D("10")
    assert first[4] == level_price
    assert second[4] == retry_price
    assert res.cid == second[0]

    rejected = store.order(first[0])
    assert rejected["status"] == REJECTED
    assert POST_ONLY in (rejected["note"] or "")
    assert store.order(second[0])["status"] == OPEN
    assert len(store.orders()) == 2


def test_post_only_retries_exhausted(store):
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": POST_ONLY}] * 3
    )
    gw = make_gateway(store, exchange=exchange, max_post_only_retries=2)

    res = gw.submit("bot", "b1", place())
    assert res.ok is False
    assert res.refusal == POST_ONLY_EXHAUSTED

    assert len(exchange.place_calls) == 3
    cids = [call[0] for call in exchange.place_calls]
    assert len(set(cids)) == 3

    prices = [call[4] for call in exchange.place_calls]
    assert prices[0] > prices[1] > prices[2]  # a buy walks further from the ask
    assert len(set(prices)) == 3

    assert res.cid == cids[-1]
    rows = store.orders()
    assert len(rows) == 3
    assert all(row["status"] == REJECTED for row in rows)
    assert all(POST_ONLY in (row["note"] or "") for row in rows)


def test_non_post_only_rejection_is_not_retried(store, make_store):
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": "INSUFFICIENT_FUND"}]
    )
    gw = make_gateway(store, exchange=exchange)

    res = gw.submit("bot", "b1", place())
    assert res.ok is False
    assert res.refusal == EXCHANGE_REJECTED
    assert len(exchange.place_calls) == 1
    row = store.order(res.cid)
    assert row["status"] == REJECTED
    assert "INSUFFICIENT_FUND" in (row["note"] or "")
    assert len(store.orders()) == 1

    # An error raised instead of answered is the same refusal, one attempt.
    other = make_store("perm.db")
    exchange2 = ScriptedExchange(place_script=[PermanentError("HTTP 400: rejected")])
    gw2 = make_gateway(other, exchange=exchange2)

    res2 = gw2.submit("bot", "b1", place())
    assert res2.ok is False
    assert res2.refusal == EXCHANGE_REJECTED
    assert len(exchange2.place_calls) == 1
    row2 = other.order(res2.cid)
    assert row2["status"] == REJECTED
    assert "HTTP 400" in (row2["note"] or "")
    assert len(other.orders()) == 1


def test_crossing_level_rests_inside_instead_of_taking(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    # A buy level above the ask: the order rests just under the ask instead of
    # paying the offer.
    buy = gw.submit("bot", "b1", place(price=D("1.05"), level=-1))
    assert buy.ok is True
    assert buy.refusal is None
    assert len(exchange.place_calls) == 1
    assert exchange.place_calls[0][4] == D("0.9999")
    assert store.order(buy.cid)["price"] == D("0.9999")
    assert store.order(buy.cid)["price"] != D("1.05")

    # ... and a sell level below the bid rests just above it.
    sell = gw.submit("bot", "b1", place(side="SELL", price=D("0.90"), level=2))
    assert sell.ok is True
    assert sell.refusal is None
    assert len(exchange.place_calls) == 2
    assert exchange.place_calls[1][4] == D("0.9901")
    assert store.order(sell.cid)["price"] == D("0.9901")
    assert store.order(sell.cid)["price"] != D("0.90")


def test_reprice_rechecks_caps(store):
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": POST_ONLY}]
    )
    gw = make_gateway(store, exchange=exchange)

    # 50 * 1.00 == 50 sits exactly on the bot's single-order cap.
    wide = place(side="SELL", size=D("50"), price=D("1.00"), level=2)
    assert gw.check("bot", "b1", wide) is None

    res = gw.submit("bot", "b1", wide)
    # The retry is one tick further up: 50 * 1.0001 = 50.005 is over the cap.
    assert res.ok is False
    assert res.refusal == ORDER_TOO_LARGE

    assert len(exchange.place_calls) == 1
    assert exchange.place_calls[0][4] == D("1.00")

    rows = store.orders()
    assert len(rows) == 1
    assert rows[0]["client_order_id"] == exchange.place_calls[0][0]
    assert rows[0]["status"] == REJECTED
    assert POST_ONLY in (rows[0]["note"] or "")


def test_reprice_stops_when_halted_between_attempts(store):
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": POST_ONLY}]
    )
    gw = make_gateway(store, exchange=exchange)

    def on_place(cid):
        gw.halt("kill")

    exchange.on_place = on_place

    res = gw.submit("bot", "b1", place())
    assert res.ok is False
    assert res.refusal == HALTED
    assert gw.is_halted()

    assert len(exchange.place_calls) == 1
    rows = store.orders()
    assert len(rows) == 1
    assert rows[0]["status"] == REJECTED


# ---------------------------------------------------------------- book drift


def test_submit_prices_from_the_checked_book(store):
    """The send is priced from the book the chain looked at, not a fresh read.

    A second read during one submit would price the order against a book that no
    cap, minimum or funds step ever saw.
    """
    snaps = ChangingSnapshots([(D("0.99"), D("1.00")), (D("0.50"), D("0.51"))])
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange, snapshots=snaps)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None

    # One snapshot for the submit: the priced book is the checked book.
    assert len(snaps.served) == 1
    assert len(exchange.place_calls) == 1
    priced = snaps.served[0]
    assert exchange.place_calls[0][4] == money.maker_price(
        "BUY", D("0.95"), priced.bid, priced.ask, SPEC.price_increment
    )


def test_submit_never_sends_when_the_book_goes_bad_after_the_check(store):
    """A book that turns crossed between the check and the send never misprices."""
    # The second book is crossed: no bid can sit above its ask.
    snaps = ChangingSnapshots([(D("0.99"), D("1.00")), (D("1.00"), D("0.90"))])
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange, snapshots=snaps)

    res = gw.submit("bot", "b1", place())

    if res.ok:
        assert len(exchange.place_calls) == 1
        assert exchange.place_calls[0][4] == D("0.95")
        # One book evaluation per send: an unusable book never prices an order.
        assert len(snaps.served) == len(exchange.place_calls)
    else:
        assert res.refusal is not None


def test_reprice_is_evaluated_against_its_own_book(store):
    """A repriced retry runs the chain on its own read of the book."""
    snaps = ChangingSnapshots([(D("0.99"), D("1.00")), (D("0.90"), D("0.91"))])
    exchange = ScriptedExchange(
        place_script=[{"ok": False, "order_id": None, "reason": POST_ONLY}]
    )
    gw = make_gateway(store, exchange=exchange, snapshots=snaps)

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None

    assert len(exchange.place_calls) == 2
    assert len(snaps.served) == 2
    first, second = exchange.place_calls
    price0 = money.maker_price(
        "BUY",
        D("0.95"),
        snaps.served[0].bid,
        snaps.served[0].ask,
        SPEC.price_increment,
    )
    price1 = money.maker_price(
        "BUY",
        money.reprice_away("BUY", price0, SPEC.price_increment),
        snaps.served[1].bid,
        snaps.served[1].ask,
        SPEC.price_increment,
    )
    assert first[4] == price0
    assert second[4] == price1


def test_check_alone_never_reaches_the_exchange(store):
    """`check()` answers the same happy intent without touching exchange or store."""
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    assert gw.check("bot", "b1", place()) is None
    assert exchange.place_calls == []
    assert exchange.find_calls == []
    assert exchange.cancel_calls == []
    assert exchange.list_calls == []
    assert store.orders() == []


# ---------------------------------------------------------------- cancel


def test_cancel_intent_via_submit(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    own = seed_order(store)
    store.update_order(own, status=OPEN, order_id="ex-9")

    res = gw.submit("bot", "b1", cancel(own))
    assert res.ok is True
    assert res.refusal is None
    assert exchange.cancel_calls == [["ex-9"]]

    row = store.order(own)
    assert "cancel" in (row["note"] or "")
    assert row["status"] == OPEN  # reconcile moves it to CANCELLED

    # Another bot's order, an id nobody holds, a row with no order id yet, and a
    # row that is already done: each is refused without touching the exchange.
    store.create_bot("b2", PRODUCT, "grid", {}, D("100"), D("50"))
    other = seed_order(store, owner="b2", cid_suffix=2, status=OPEN, order_id="ex-10")
    refused = gw.submit("bot", "b1", cancel(other))
    assert refused.ok is False and refused.refusal == NOT_OWNER

    nowhere = gw.submit("bot", "b1", cancel("cb-b1-B0-ffffffffffff"))
    assert nowhere.ok is False and nowhere.refusal == NOT_OWNER

    pending = seed_order(store, cid_suffix=3)
    early = gw.submit("bot", "b1", cancel(pending))
    assert early.ok is False and early.refusal == NOT_CANCELLABLE

    done = seed_order(store, cid_suffix=4, status=CANCELLED, order_id="ex-11")
    late = gw.submit("bot", "b1", cancel(done))
    assert late.ok is False and late.refusal == NOT_CANCELLABLE

    assert len(exchange.cancel_calls) == 1

    # A halt never blocks taking our own order off the book.
    gw.halt("kill")
    resting = seed_order(store, cid_suffix=5, status=OPEN, order_id="ex-12")
    while_halted = gw.submit("bot", "b1", cancel(resting))
    assert while_halted.ok is True
    assert while_halted.refusal is None
    assert exchange.cancel_calls == [["ex-9"], ["ex-12"]]
    assert "cancel" in (store.order(resting)["note"] or "")


def test_cancel_all_appends_its_note_instead_of_overwriting(store):
    adopted_cid = "cb-b1-S-1-000000000001"
    bare_cid = "cb-b1-B-1-000000000002"
    exchange = ScriptedExchange(
        open_orders=[
            exchange_order(adopted_cid, "ex-adopted", side="SELL"),
            exchange_order(bare_cid, "ex-bare"),
        ]
    )
    gw = make_gateway(store, exchange=exchange)

    seed_order(store, cid=adopted_cid, side="SELL", level=1, status=OPEN)
    seed_order(store, cid=bare_cid, status=OPEN)
    store.update_order(adopted_cid, note="adopted orphan")

    assert gw.cancel_all("owner", "b1") == 2

    adopted = store.order(adopted_cid)["note"]
    assert "adopted orphan" in adopted
    assert "cancel requested" in adopted
    assert adopted == "adopted orphan; cancel requested"

    # A row with no note of its own gets exactly the cancel note.
    assert store.order(bare_cid)["note"] == "cancel requested"

    # Cancelling the same rows again does not repeat the note.
    assert gw.cancel_all("owner", "b1") == 2
    assert store.order(adopted_cid)["note"] == "adopted orphan; cancel requested"
    assert store.order(bare_cid)["note"] == "cancel requested"


def test_cancel_intent_appends_its_note_instead_of_overwriting(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    cid = seed_order(store, status=OPEN, order_id="ex-9")
    store.update_order(cid, note="post-only bounce")

    first = gw.submit("bot", "b1", cancel(cid))
    assert first.ok is True
    assert store.order(cid)["note"] == "post-only bounce; cancel requested"

    # The row is still OPEN until reconcile settles it, so the same cancel can be
    # sent again: the note is not repeated.
    second = gw.submit("bot", "b1", cancel(cid))
    assert second.ok is True
    assert exchange.cancel_calls == [["ex-9"], ["ex-9"]]
    assert store.order(cid)["note"] == "post-only bounce; cancel requested"


def test_cancel_all_owner_scope_leaves_other_bot_and_non_cb(store):
    store.create_bot("b2", PRODUCT, "grid", {}, D("100"), D("50"))
    store.create_bot("b10", PRODUCT, "grid", {}, D("100"), D("50"))

    b1_cid = "cb-b1-B-1-000000000001"
    b2_cid = "cb-b2-B-1-000000000002"
    b10_cid = "cb-b10-B-1-000000000003"

    exchange = ScriptedExchange(
        open_orders=[
            exchange_order(b1_cid, "ex-b1"),
            exchange_order(b2_cid, "ex-b2"),
            exchange_order(b10_cid, "ex-b10"),
            exchange_order("manual-1", "ex-manual"),
        ]
    )
    gw = make_gateway(store, exchange=exchange)

    for cid, owner in ((b1_cid, "b1"), (b2_cid, "b2"), (b10_cid, "b10")):
        seed_order(store, owner=owner, cid=cid, status=OPEN)

    # "b1" must not sweep "cb-b10-..." — the owner part ends at the dash.
    assert gw.cancel_all("owner", "b1") == 1
    assert exchange.cancel_calls == [["ex-b1"]]
    assert exchange.list_calls == [None]  # unfiltered: the sweep takes every product
    assert "cancel" in (store.order(b1_cid)["note"] or "")
    assert store.order(b2_cid)["note"] is None
    assert store.order(b10_cid)["note"] is None

    assert gw.cancel_all("all") == 3
    everywhere = exchange.cancel_calls[-1]
    assert len(everywhere) == 3
    assert sorted(everywhere) == ["ex-b1", "ex-b10", "ex-b2"]
    assert "ex-manual" not in everywhere
    assert "cancel" in (store.order(b10_cid)["note"] or "")

    with pytest.raises(ValueError):
        gw.cancel_all("owner")
    with pytest.raises(ValueError):
        gw.cancel_all("everything")

    # Nothing to do: no cancel call at all.
    empty = ScriptedExchange()
    quiet = make_gateway(store, exchange=empty)
    assert quiet.cancel_all("owner", "b1") == 0
    assert empty.cancel_calls == []

    # The kill path works while halted.
    gw.halt("kill")
    assert gw.cancel_all("owner", "b1") == 1
    assert exchange.cancel_calls[-1] == ["ex-b1"]


# ---------------------------------------------------------------- halt


def test_halt_blocks_submit_after_kill(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)
    results = []

    def worker():
        results.append(gw.submit("bot", "b1", place()))

    gw.lock.acquire()
    try:
        thread = threading.Thread(target=worker)
        thread.start()
        time.sleep(0.1)  # the worker queues on the cycle lock
        gw.halt("kill")
    finally:
        gw.lock.release()

    thread.join(timeout=5)
    assert not thread.is_alive()

    assert len(results) == 1
    res = results[0]
    assert res.ok is False
    assert res.refusal == HALTED
    assert exchange.place_calls == []
    assert store.orders() == []


def test_halt_does_not_wait_for_cycle_lock(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    holding = threading.Event()
    release = threading.Event()
    failures = []

    def holder():
        gw.lock.acquire()
        holding.set()
        try:
            release.wait(timeout=10)
        finally:
            gw.lock.release()

    def killer():
        try:
            gw.halt("kill")
        except BaseException as exc:  # noqa: BLE001 - reported below
            failures.append(exc)

    holder_thread = threading.Thread(target=holder)
    holder_thread.start()
    assert holding.wait(timeout=5)

    killer_thread = threading.Thread(target=killer)
    killer_thread.start()
    killer_thread.join(timeout=2)
    still_waiting = killer_thread.is_alive()

    try:
        assert not still_waiting  # a kill never queues behind a running cycle
        assert failures == []
        assert gw.is_halted()
        assert store.get("halted")

        # The flag was persisted, so a restart is halted too.
        restarted = make_gateway(store, exchange=exchange)
        assert restarted.is_halted()
        assert restarted.check("bot", "b1", place()) == HALTED
    finally:
        release.set()
        holder_thread.join(timeout=5)

    assert not holder_thread.is_alive()


def test_clear_halt(store):
    exchange = ScriptedExchange()
    gw = make_gateway(store, exchange=exchange)

    gw.halt("kill")
    assert gw.is_halted()
    assert gw.check("bot", "b1", place()) == HALTED
    assert store.get("halted")

    gw.clear_halt()
    assert not gw.is_halted()
    assert not store.get("halted")
    assert gw.check("bot", "b1", place()) is None

    restarted = make_gateway(store, exchange=exchange)
    assert not restarted.is_halted()
    assert restarted.check("bot", "b1", place()) is None

    assert exchange.place_calls == []
    assert store.orders() == []


# ---------------------------------------------------------------- dry seeding


def test_seed_dry_only_for_dry_owner(store):
    store.create_bot("b2", PRODUCT, "grid", {}, D("100"), D("50"))
    exchange = DryRunExchange(store.conn, lambda product: FakeMarket(), FEE_RATE)
    gw = make_gateway(
        store,
        exchange=exchange,
        route_for=lambda owner: "dry" if owner == "b1" else "live",
    )

    gw.seed_dry("b1", D("100"), D("50"))
    assert exchange.totals() == {QUOTE: D("100"), BASE: D("50")}

    # b2 is on a live route: nothing may be deposited for it.
    with pytest.raises(ValueError):
        gw.seed_dry("b2", D("100"), D("50"))
    assert exchange.totals() == {QUOTE: D("100"), BASE: D("50")}

    # An owner with no bot row has no product to seed.
    with pytest.raises(ValueError):
        gw.seed_dry("ai", D("10"), D("10"))

    with pytest.raises(ValueError):
        gw.seed_dry("b1", D("-1"), D("0"))
    with pytest.raises(ValueError):
        gw.seed_dry("b1", D("0"), D("-5"))
    assert exchange.totals() == {QUOTE: D("100"), BASE: D("50")}

    # A zero amount is skipped rather than refused: only the quote moves.
    gw.seed_dry("b1", D("10"), D("0"))
    assert exchange.totals() == {QUOTE: D("110"), BASE: D("50")}

    bare = make_gateway(store, exchange=None)
    with pytest.raises(ValueError):
        bare.seed_dry("b1", D("1"), D("1"))


def test_dry_exchange_end_to_end(store):
    exchange = DryRunExchange(store.conn, lambda product: FakeMarket(), FEE_RATE)
    gw = make_gateway(store, exchange=exchange, totals=exchange.totals)

    gw.seed_dry("b1", D("100"), D("50"))
    assert exchange.totals() == {QUOTE: D("100"), BASE: D("50")}

    res = gw.submit("bot", "b1", place())
    assert res.ok is True
    assert res.refusal is None

    resting = exchange.list_open_orders()
    assert [order["client_order_id"] for order in resting] == [res.cid]
    assert store.order(res.cid)["status"] == OPEN

    assert gw.cancel_all("owner", "b1") == 1
    assert exchange.list_open_orders() == []
    assert store.order(res.cid)["status"] == OPEN  # reconcile settles the row
    assert "cancel" in (store.order(res.cid)["note"] or "")


def test_seed_dry_rolls_back_the_first_deposit_when_the_second_fails(store):
    """Both deposits share one transaction: a failure in the second undoes the first."""
    exchange = DryRunExchange(store.conn, lambda product: FakeMarket(), FEE_RATE)
    before = exchange.totals()

    real_deposit = exchange.deposit
    deposits = []

    def flaky_deposit(currency, amount, note):
        deposits.append(currency)
        if len(deposits) > 1:
            raise RuntimeError("boom")
        return real_deposit(currency, amount, note)

    exchange.deposit = flaky_deposit
    gw = make_gateway(store, exchange=exchange)

    with pytest.raises(RuntimeError):
        gw.seed_dry("b1", D("100"), D("50"))

    assert len(deposits) == 2  # the quote deposit did run before the base failed
    after = exchange.totals()
    assert after == before
    assert all(amount <= 0 for amount in after.values())
    assert store.conn().execute("SELECT COUNT(*) FROM sim_deposits").fetchone()[0] == 0