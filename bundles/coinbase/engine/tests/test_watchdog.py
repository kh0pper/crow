"""tests/test_watchdog.py: the heartbeat watchdog, its alerts and its sweeps.

Nothing here waits: the clock is a one-element list the test moves, so "four
hundred seconds stale" is a single assignment and a stale heartbeat is stale at
the instant the test says so.  A watchdog measures a cold start's grace from the
moment it was built, so every test that needs a stale heartbeat builds the
`Watchdog` first and only then moves the clock forward past that grace: a
heartbeat dated before the run, and a heartbeat file that was never written, are
both inside the grace until the run itself is that old.

A real `Store` on a temporary file is the system of record, because the episode
record and the events both live in the database: that is what makes a second
`Watchdog` over the same file join the episode an earlier one opened.  The data
directory is `tmp_path`, and the exchange is a `FakeExchange` that keeps its open
orders in a list, drops the ones it cancels and records the `list_open_orders`
product arguments and the `cancel` id lists; its `place_limit` and `deposit` only
append to `placed`, so a test can assert the watchdog never put anything on the
book.

`main` is called with the same fakes, an injected `sleep` and an injected clock,
so no real exchange is built and no real second goes by.  The live switch is the
piece the environment itself controls, and every value this build cannot honour
has to answer the refusal code before the data directory is touched.

The one test that uses the real dry-run exchange opens `Store` twice on one file
— once as the engine side the orders are placed from, once as the file `main`
opens itself — and then settles the swept rows with `reconcile`, so the whole
stale-cancel path runs against simulated orders and a fixed market touch with no
client and no request.
"""

from __future__ import annotations

import json
import runpy
from decimal import Decimal as D
from pathlib import Path

import pytest

import crow_coinbase.watchdog as watchdog_module
from crow_coinbase.exchange import DryRunExchange
from crow_coinbase.reconcile import reconcile
from crow_coinbase.store import CANCELLED, OPEN, Store
from crow_coinbase.watchdog import (
    KV_EPISODE,
    STALE_FACTOR,
    Watchdog,
    cancel_all_cb_orders,
    main,
)

NOW = 1000.0  # the clock every test starts at
STALE = 300.0  # the threshold the tests construct the watchdog with
HEARTBEAT = "heartbeat"  # the file the runner writes next to engine.sqlite
PRODUCT = "XRP-USDC"  # the product the dry-run exchange test trades
# The two orders a cancel may touch: the one cb- order per product.
CB_ORDER_IDS = frozenset({"oid-btc", "oid-xrp"})
REFUSED = 3  # the contract's EXIT_REFUSED: the configuration may not start
EXIT_FAILED = 1  # the contract's EXIT_FAILED: the run failed, restart it


# ---------------------------------------------------------------- the outside world


class FakeExchange:
    """Open orders in a list; every list and cancel recorded, nothing placed.

    `cancel` takes the cancelled orders off the book, the way the real exchange
    does, so a later sweep over the same fake finds nothing left of them.
    """

    def __init__(self, orders=(), fail_cancel_times=0):
        self.orders = [dict(entry) for entry in orders]
        self.listed = []
        self.cancelled = []
        self.placed = []
        self.fail_cancel_times = fail_cancel_times

    # -- reads
    def list_open_orders(self, product=None):
        self.listed.append(product)
        if product is None:
            return [dict(entry) for entry in self.orders]
        return [
            dict(entry) for entry in self.orders if entry["product"] == product
        ]

    # -- the one write the watchdog may make
    def cancel(self, order_ids):
        ids = list(order_ids)
        self.cancelled.append(ids)
        if self.fail_cancel_times:
            self.fail_cancel_times -= 1
            raise RuntimeError("the exchange refused the cancel")
        self.orders = [
            entry for entry in self.orders if entry["order_id"] not in ids
        ]
        return {order_id: True for order_id in ids}

    # -- writes the watchdog must never make
    def place_limit(self, *args, **kwargs):
        self.placed.append(("place_limit", args, kwargs))

    def deposit(self, *args, **kwargs):
        self.placed.append(("deposit", args, kwargs))


class Factory:
    """A counting exchange_factory that hands back one fake exchange."""

    def __init__(self, exchange):
        self.exchange = exchange
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.exchange


class FakeMarket:
    """A public market with a fixed touch: no client, no request, no candles."""

    def __init__(self, bid, ask):
        self.bid = D(bid)
        self.ask = D(ask)

    def best_bid_ask(self):
        return self.bid, self.ask


class SteppingClock:
    """`start` for the first read, `later` for every read after it.

    `main` builds its `Watchdog` with the very first read of the clock, and the
    watchdog's cold-start grace is measured from that moment.  A caller that
    wants the first pass to see a stale heartbeat therefore has to answer the
    construction with one time and the passes with another; this is that clock,
    and `later` is also the value such a test hands to `reconcile`.
    """

    def __init__(self, start, later):
        self.start = float(start)
        self.later = float(later)
        self.reads = 0

    def __call__(self):
        self.reads += 1
        return self.start if self.reads == 1 else self.later


class AlertBreakingStore:
    """A store whose `event` fails the first time it is asked for an ALERT.

    Every other attribute is the real store's, so `tx`, `put` and `get` reach the
    real database and the episode record is written exactly as it is in
    production: the watchdog's transaction around the record and the alert is the
    real one, and only the ALERT write inside it raises.  The info and error
    events are written as they are in production too.
    """

    def __init__(self, store, fail_times=1):
        self.store = store
        self.fail_times = fail_times
        self.alert_attempts = 0

    def __getattr__(self, name):
        return getattr(self.store, name)

    def event(self, level, message):
        if level == "ALERT":
            self.alert_attempts += 1
            if self.fail_times:
                self.fail_times -= 1
                raise RuntimeError("the events table refused the alert")
        return self.store.event(level, message)


def order(order_id, client_order_id, product="BTC-USDC"):
    """One open order in the shape `list_open_orders` hands back."""
    return {
        "order_id": order_id,
        "client_order_id": client_order_id,
        "product": product,
        "side": "BUY",
    }


def cb_order_list():
    """One cb- order per product, plus three orders a cancel has to leave alone."""
    return [
        order("oid-btc", "cb-b1-B+1-aaaaaaaaaaaa", "BTC-USDC"),
        order("oid-xrp", "cb-b2-S-2-bbbbbbbbbbbb", "XRP-USDC"),
        order("oid-manual", "manual-1", "BTC-USDC"),
        order("oid-blank", "", "XRP-USDC"),
        order("oid-lookalike", "xcb-foo", "BTC-USDC"),
    ]


def cb_orders_exchange(fail_cancel_times=0):
    """A fake holding the cb- orders of two products and three strangers' orders."""
    return FakeExchange(cb_order_list(), fail_cancel_times=fail_cancel_times)


# ---------------------------------------------------------------- the harness


def open_store(root):
    """The engine's database file under *root*, in the name `main` uses."""
    return Store(Path(root) / "engine.sqlite")


def watchdog(root, store, factory, policy="leave", *, t):
    """A Watchdog over *root* with the 300 s threshold and the injected clock."""
    return Watchdog(root, store, factory, policy, stale_after_s=STALE, now=lambda: t[0])


def write_heartbeat(root, ts):
    """Write the heartbeat the runner writes: ts, cycle, bots_active, errors."""
    (Path(root) / HEARTBEAT).write_text(
        json.dumps({"ts": ts, "cycle": 1, "bots_active": 1, "errors": []})
    )


def events(store, level=None):
    rows = store.conn().execute("SELECT level, message FROM events").fetchall()
    found = [{"level": row["level"], "message": row["message"]} for row in rows]
    if level is None:
        return found
    return [event for event in found if event["level"] == level]


def messages(store, level=None):
    return [event["message"] for event in events(store, level)]


def episode_record(store):
    """The stale episode in progress, or None when nothing is stored."""
    stored = store.get(KV_EPISODE)
    return stored if isinstance(stored, dict) else None


# ---------------------------------------------------------------- a fresh heartbeat


def test_fresh_ok(tmp_path):
    """A heartbeat at the clock's own time is fresh; the threshold is a strict edge."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    write_heartbeat(tmp_path, t[0])

    assert wd.stale_reason() is None
    assert wd.check() == "ok"
    assert messages(store, "ALERT") == []

    # Exactly the threshold old is still fresh.
    t[0] += STALE
    assert wd.check() == "ok"
    assert messages(store, "ALERT") == []

    # One second past it is stale.
    t[0] += 1
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1

    assert factory.calls == 0


def test_stale_leave_alerts_only(tmp_path):
    """The leave policy raises the alert and builds no exchange at all."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 100

    assert isinstance(wd.stale_reason(), str)
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 0
    assert fake.listed == []
    assert fake.cancelled == []
    assert fake.placed == []


# ---------------------------------------------------------------- the cold-start grace


def test_old_heartbeat_at_start_gets_grace(tmp_path):
    """A heartbeat older than the watchdog is measured from the watchdog's start."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    # The file is there and readable, but older than this run: grace, not stale.
    write_heartbeat(tmp_path, t[0] - 10_000)

    assert wd.stale_reason() is None
    assert wd.check() == "ok"
    assert events(store) == []
    assert factory.calls == 0

    # Exactly the threshold into the run is still inside it.
    t[0] += STALE
    assert wd.check() == "ok"
    assert events(store) == []
    assert factory.calls == 0

    # One second later the grace is over and the heartbeat's age counts.
    t[0] += 1
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 0


def test_restart_joins_episode_through_grace(tmp_path):
    """A restarted watchdog is quiet through its grace, then joins the episode."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    first = watchdog(tmp_path, store, factory, "cancel", t=t)

    # The first run opens an episode: one alert, one sweep.
    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1
    assert first.check() == "acted"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert (episode_record(store) or {}).get("alerted") is True

    # A watchdog that restarts mid-episode sees a heartbeat older than itself,
    # which is its grace: "ok", nothing written, and the record left in place.
    restarted = watchdog(tmp_path, store, factory, "cancel", t=t)
    before = len(events(store))
    assert restarted.stale_reason() is None
    assert restarted.check() == "ok"
    assert len(events(store)) == before
    assert factory.calls == 1  # a pass that is not stale builds no exchange
    assert (episode_record(store) or {}).get("alerted") is True
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1

    # Once the grace is over the staleness begins, and the episode it joins does
    # not alert again; the book is already empty, so the sweep asks for nothing.
    t[0] += STALE + 1
    assert restarted.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert (episode_record(store) or {}).get("alerted") is True


# ---------------------------------------------------------------- hysteresis


def test_hysteresis_flapping_one_alert(tmp_path):
    """A heartbeat flapping around the threshold is one episode with one alert."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    t[0] += 10 * STALE  # well past the cold-start grace

    write_heartbeat(tmp_path, t[0] - STALE - 1)
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1

    # Not stale, but not truly fresh either: each "ok" keeps the episode open.
    for ts in (
        t[0] - STALE + 1,
        t[0] - STALE - 1,
        t[0] - STALE + 1,
        t[0] - STALE - 1,
    ):
        write_heartbeat(tmp_path, ts)
        expected = "ok" if ts > t[0] - STALE else "stale"
        assert wd.check() == expected
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 0

    # Exactly half the threshold old is truly fresh: the episode is over.
    write_heartbeat(tmp_path, t[0] - STALE / 2)
    assert wd.check() == "ok"
    assert episode_record(store) is None

    # The next stale spell is a new episode and alerts again.
    write_heartbeat(tmp_path, t[0] - STALE - 1)
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 2
    assert factory.calls == 0


def test_clear_only_when_truly_fresh(tmp_path):
    """Only a truly fresh heartbeat clears the episode record."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1
    assert wd.check() == "stale"
    assert (episode_record(store) or {}).get("alerted") is True

    # Between the half threshold and the threshold: "ok" and the record stays.
    write_heartbeat(tmp_path, t[0] - STALE + 1)
    assert wd.check() == "ok"
    assert (episode_record(store) or {}).get("alerted") is True
    assert len(messages(store, "ALERT")) == 1

    # Exactly half the threshold old: truly fresh, so the episode is over.
    write_heartbeat(tmp_path, t[0] - STALE / 2)
    assert wd.check() == "ok"
    assert episode_record(store) is None

    # A second spell opens a second episode.
    t[0] += STALE + 1
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 2
    assert (episode_record(store) or {}).get("alerted") is True

    # A watchdog restarted beside a missing heartbeat is inside its grace: the
    # record is neither cleared nor alerted on.
    (tmp_path / HEARTBEAT).unlink()
    restarted = watchdog(tmp_path, store, factory, "leave", t=t)
    t[0] += STALE
    assert restarted.check() == "ok"
    assert (episode_record(store) or {}).get("alerted") is True
    assert len(messages(store, "ALERT")) == 2

    # A truly fresh heartbeat, and the record goes.
    write_heartbeat(tmp_path, t[0])
    assert restarted.check() == "ok"
    assert episode_record(store) is None
    assert len(messages(store, "ALERT")) == 2


# ---------------------------------------------------------------- the cancel policy


def test_stale_cancel_policy_cb_only(tmp_path):
    """A stale cancel policy cancels the cb- orders and never the others."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "acted"

    # The list is unfiltered: every product at once, not one product at a time.
    assert fake.listed == [None]
    assert len(fake.cancelled) == 1
    assert set(fake.cancelled[0]) == CB_ORDER_IDS
    assert fake.placed == []
    assert any("cancel" in message.lower() for message in messages(store, "info"))
    assert len(messages(store, "ALERT")) == 1

    # The cancelled orders are off the book; the strangers' orders are still on it.
    left = {entry["client_order_id"] for entry in fake.list_open_orders(None)}
    assert left == {"manual-1", "", "xcb-foo"}

    # The helper on its own: the same two ids, the count of them, one call.
    direct = cb_orders_exchange()
    before = len(events(store))
    assert cancel_all_cb_orders(direct, store) == 2
    assert len(direct.cancelled) == 1
    assert set(direct.cancelled[0]) == CB_ORDER_IDS
    assert len(events(store)) == before + 1  # the request is recorded once
    assert any("cancel" in message.lower() for message in messages(store, "info"))

    # No store means no event written, and the cancel still happens.
    before_none = len(events(store))
    silent = cb_orders_exchange()
    assert cancel_all_cb_orders(silent, None) == 2
    assert set(silent.cancelled[0]) == CB_ORDER_IDS
    assert len(events(store)) == before_none

    # Nothing worth cancelling: no cancel call and no event.
    untouched = FakeExchange(
        [
            order("oid-manual", "manual-1", "BTC-USDC"),
            order("oid-blank", "", "XRP-USDC"),
            order("oid-lookalike", "xcb-foo", "BTC-USDC"),
        ]
    )
    assert cancel_all_cb_orders(untouched, store) == 0
    assert untouched.cancelled == []
    assert len(events(store)) == before_none


def test_sweep_every_stale_pass(tmp_path):
    """Every stale pass sweeps, so an order placed mid-episode is taken too."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "acted"
    assert len(fake.cancelled) == 1
    assert set(fake.cancelled[0]) == CB_ORDER_IDS
    assert len(messages(store, "info")) == 1
    assert len(messages(store, "ALERT")) == 1

    # Nothing left to cancel: the sweep looks, asks for nothing, writes nothing.
    assert wd.check() == "stale"
    assert len(fake.cancelled) == 1
    assert len(messages(store, "info")) == 1
    assert len(messages(store, "ALERT")) == 1
    assert fake.listed == [None, None]
    assert factory.calls == 1

    # An order that appears mid-episode is swept by the next stale pass.
    fake.orders.append(order("oid-eth", "cb-b3-B+1-cccccccccccc", "ETH-USDC"))
    assert wd.check() == "acted"
    assert len(fake.cancelled) == 2
    assert fake.cancelled[1] == ["oid-eth"]
    assert len(messages(store, "info")) == 2
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 1


def test_sweep_nothing_no_event(tmp_path):
    """A stale pass with nothing of ours on the book asks for nothing."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = FakeExchange([order("oid-manual", "manual-1", "BTC-USDC")])
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert fake.listed == [None]  # the sweep looked
    assert fake.cancelled == []
    assert messages(store, "info") == []
    assert factory.calls == 1

    # The exchange built by the first sweep is reused by the next pass.
    assert wd.check() == "stale"
    assert fake.listed == [None, None]
    assert fake.cancelled == []
    assert messages(store, "info") == []
    assert factory.calls == 1


def test_alert_once_per_episode(tmp_path):
    """One alert per stale spell, however many passes — and a sweep on each."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "acted"
    assert wd.check() == "stale"
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert factory.calls == 1

    # A second watchdog over the same file joins the episode in progress: its
    # grace is quiet first, then the staleness it sees is the episode's own.
    restarted = watchdog(tmp_path, store, factory, "cancel", t=t)
    assert restarted.check() == "ok"
    assert factory.calls == 1
    t[0] += STALE + 1
    assert restarted.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1

    # A truly fresh heartbeat ends the episode.
    write_heartbeat(tmp_path, t[0])
    assert wd.check() == "ok"
    assert len(messages(store, "ALERT")) == 1
    assert episode_record(store) is None

    # The next stale spell is a new episode: it alerts and sweeps again.
    fake.orders = cb_order_list()
    t[0] += 10_000
    assert wd.check() == "acted"
    assert len(messages(store, "ALERT")) == 2
    assert len(fake.cancelled) == 2
    assert set(fake.cancelled[1]) == CB_ORDER_IDS

    # The same sequence under the leave policy: an alert per episode, no cancel.
    leave_dir = tmp_path / "leave"
    leave_dir.mkdir()
    leave_store = open_store(leave_dir)
    leave_fake = cb_orders_exchange()
    leave_factory = Factory(leave_fake)
    leave_wd = watchdog(leave_dir, leave_store, leave_factory, "leave", t=t)

    write_heartbeat(leave_dir, t[0])
    t[0] += STALE + 1
    assert leave_wd.check() == "stale"
    assert leave_wd.check() == "stale"
    assert len(messages(leave_store, "ALERT")) == 1
    assert leave_factory.calls == 0

    write_heartbeat(leave_dir, t[0])
    assert leave_wd.check() == "ok"

    t[0] += 10_000
    assert leave_wd.check() == "stale"
    assert len(messages(leave_store, "ALERT")) == 2
    assert leave_factory.calls == 0
    assert leave_fake.cancelled == []


def test_cancel_failure_retries_next_check(tmp_path):
    """A cancel that raises is written down once and the next pass sweeps again."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    fake.fail_cancel_times = 1
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "stale"
    assert len(messages(store, "error")) == 1
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert len(messages(store, "info")) == 1  # the request is written down
    # The error is remembered for the episode, which is what keeps it to one.
    assert (episode_record(store) or {}).get("sweep_error") is True

    # The book is untouched by the failure, so this pass asks for the same ids
    # and gets through.  The exchange is the one the first sweep built.
    assert wd.check() == "acted"
    assert len(fake.cancelled) == 2
    assert set(fake.cancelled[1]) == CB_ORDER_IDS
    assert len(messages(store, "ALERT")) == 1
    assert len(messages(store, "error")) == 1
    assert len(messages(store, "info")) == 2
    assert factory.calls == 1

    left = {entry["client_order_id"] for entry in fake.list_open_orders(None)}
    assert left == {"manual-1", "", "xcb-foo"}


def test_sweep_error_event_once_per_episode(tmp_path):
    """A sweep that keeps failing is retried every pass but written down once."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange(fail_cancel_times=3)
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    # Three stale passes in one episode: three cancel attempts, one error event.
    for attempts in (1, 2, 3):
        assert wd.check() == "stale"
        assert len(fake.cancelled) == attempts
        assert set(fake.cancelled[-1]) == CB_ORDER_IDS
        assert (episode_record(store) or {}).get("sweep_error") is True
    assert len(messages(store, "error")) == 1
    assert len(messages(store, "ALERT")) == 1
    assert len(messages(store, "info")) == 3  # every attempt is written down
    assert factory.calls == 1

    # The fourth pass gets through with the same ids: the sweep is still retried
    # on every stale pass, however quiet the record keeps it.
    assert wd.check() == "acted"
    assert len(fake.cancelled) == 4
    assert set(fake.cancelled[3]) == CB_ORDER_IDS
    assert len(messages(store, "error")) == 1
    assert len(messages(store, "ALERT")) == 1
    assert (episode_record(store) or {}).get("alerted") is True
    left = {entry["client_order_id"] for entry in fake.list_open_orders(None)}
    assert left == {"manual-1", "", "xcb-foo"}

    # A truly fresh heartbeat ends the episode, and a new spell may write an
    # error event of its own: the once-per-episode count went with the episode.
    write_heartbeat(tmp_path, t[0])
    assert wd.check() == "ok"
    assert episode_record(store) is None

    t[0] += STALE + 1
    fake.orders = cb_order_list()
    fake.fail_cancel_times = 1
    assert wd.check() == "stale"
    assert len(fake.cancelled) == 5
    assert len(messages(store, "error")) == 2
    assert len(messages(store, "ALERT")) == 2
    assert (episode_record(store) or {}).get("sweep_error") is True


# ---------------------------------------------------------------- the alert and the record


def test_failed_alert_write_leaves_episode_unmarked(tmp_path):
    """The record and the ALERT share one transaction: a failed write marks nothing.

    The episode save (`alerted` True) and the ALERT event are written together, so
    a store that refuses the ALERT rolls the record back with it instead of
    leaving an episode marked with no alert to read.  The next pass therefore
    opens the episode from the beginning: it writes exactly one ALERT and marks
    the record.
    """
    t = [NOW]
    real_store = open_store(tmp_path)
    store = AlertBreakingStore(real_store)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    with pytest.raises(RuntimeError):
        wd.check()

    # The record was written in the same transaction as the ALERT, so the failed
    # ALERT took it with it: nothing is marked, and no alert row exists.
    assert store.alert_attempts == 1
    assert not (episode_record(store) or {}).get("alerted")
    assert messages(store, "ALERT") == []

    # Nothing is marked, so the next pass writes the alert it owed: exactly one,
    # and the record that comes with it.
    assert wd.check() == "stale"
    assert store.alert_attempts == 2
    assert len(messages(store, "ALERT")) == 1
    assert (episode_record(store) or {}).get("alerted") is True

    # The episode is marked now, so a further stale pass does not alert again.
    assert wd.check() == "stale"
    assert store.alert_attempts == 2
    assert len(messages(store, "ALERT")) == 1


# ---------------------------------------------------------------- the heartbeat file itself


def test_missing_heartbeat_after_grace(tmp_path):
    """A heartbeat that was never written is stale only once the grace is over."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    assert wd.check() == "ok"

    t[0] += STALE
    assert wd.check() == "ok"
    assert messages(store, "ALERT") == []
    assert factory.calls == 0

    t[0] += 1
    assert wd.check() == "stale"
    alerts = messages(store, "ALERT")
    assert len(alerts) == 1
    assert "missing" in alerts[0].lower()

    # The engine comes back: the episode is over.
    write_heartbeat(tmp_path, t[0])
    assert wd.check() == "ok"


# The file bodies a heartbeat has to survive, by case name.  json.loads accepts
# NaN and Infinity, so those three arrive as a float that is not finite.
GARBLED = {
    "not-json": "not json{",
    "json-list": "[]",
    "json-null": "null",
    "no-ts": '{"cycle": 1}',
    "ts-string": '{"ts": "1000"}',
    "ts-bool": '{"ts": true}',
    "ts-nan": '{"ts": NaN}',
    "ts-infinite": '{"ts": Infinity}',
    "ts-negative-infinite": '{"ts": -Infinity}',
    "empty-file": "",
}
FUTURE_TS = {
    # a clock that far ahead of us is a bad clock, not a fresh heartbeat
    "ts-301-in-the-future": NOW + STALE + 1,
    "ts-300-in-the-future": NOW + STALE,
}
FRESH_CASES = frozenset({"ts-300-in-the-future"})


@pytest.mark.parametrize(
    "case",
    list(GARBLED) + ["path-is-a-directory"] + list(FUTURE_TS),
)
def test_garbled_and_infinite_ts_are_stale(tmp_path, case):
    """A present-but-broken heartbeat is stale at once, with no grace window."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(cb_orders_exchange())
    path = tmp_path / HEARTBEAT
    if case == "path-is-a-directory":
        path.mkdir()
    elif case in GARBLED:
        path.write_text(GARBLED[case])
    else:
        write_heartbeat(tmp_path, FUTURE_TS[case])

    wd = watchdog(tmp_path, store, factory, "leave", t=t)

    result = wd.check()

    if case in FRESH_CASES:
        assert result == "ok"
        assert messages(store, "ALERT") == []
        return
    assert result == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 0


# ---------------------------------------------------------------- construction


def test_policy_and_threshold_validation(tmp_path):
    """An unknown policy and a threshold that is not a positive number are refused."""
    t = [NOW]
    store = open_store(tmp_path)
    factory = Factory(FakeExchange())

    with pytest.raises(ValueError):
        Watchdog(
            tmp_path, store, factory, "nuke", stale_after_s=STALE, now=lambda: t[0]
        )

    for bad in (0, -1, float("nan")):
        with pytest.raises(ValueError):
            Watchdog(
                tmp_path, store, factory, "leave", stale_after_s=bad, now=lambda: t[0]
            )


# ---------------------------------------------------------------- main


def test_main_refuses_live_exit_3(tmp_path):
    """Every live switch this build cannot honour ends before the disk is touched."""
    factory = Factory(cb_orders_exchange())
    sleeps = []

    for value in ("true", "1", "yes", "maybe"):
        env = {"CROW_COINBASE_LIVE": value, "CROW_COINBASE_DATA_DIR": str(tmp_path)}
        code = main(env, exchange_factory=factory, sleep=sleeps.append, max_checks=1)
        assert code == REFUSED
        assert not (tmp_path / "engine.sqlite").exists()
        assert factory.calls == 0
    assert sleeps == []

    # The offline switch runs the loop, one check and one sleep per pass.
    t = [NOW]
    write_heartbeat(tmp_path, t[0])
    env = {"CROW_COINBASE_LIVE": "false", "CROW_COINBASE_DATA_DIR": str(tmp_path)}
    code = main(
        env,
        exchange_factory=factory,
        sleep=sleeps.append,
        now=lambda: t[0],
        max_checks=2,
    )
    assert code == 0
    assert sleeps == [60, 60]
    assert factory.calls == 0


def test_main_cancels_on_stale_with_cancel_policy(tmp_path):
    """main takes its policy and threshold from the environment and cancels once."""
    fake = cb_orders_exchange()
    factory = Factory(fake)
    # The engine's last heartbeat is older than the run; the clock moves past the
    # cold-start grace between the watchdog's construction and its first pass.
    write_heartbeat(tmp_path, NOW - 10_000)
    poll = 10
    clock = SteppingClock(NOW, NOW + STALE_FACTOR * poll + 1)
    env = {
        "CROW_COINBASE_WATCHDOG_POLICY": "cancel",
        "CROW_COINBASE_DATA_DIR": str(tmp_path),
        "CROW_COINBASE_POLL_SECONDS": str(poll),
    }

    code = main(
        env,
        exchange_factory=factory,
        sleep=lambda seconds: None,
        now=clock,
        max_checks=3,
    )

    assert code == 0
    assert factory.calls == 1
    assert len(fake.cancelled) == 1
    assert set(fake.cancelled[0]) == CB_ORDER_IDS
    assert fake.placed == []

    # The alert is in the file main used, read back through a fresh Store.
    reopened = open_store(tmp_path)
    assert len(messages(reopened, "ALERT")) == 1


def test_main_cancel_sweep_with_real_dry_exchange_and_reconcile(tmp_path, monkeypatch):
    """The cancel policy through main's own dry-run exchange, then a reconcile."""
    clock = SteppingClock(NOW, NOW + STALE_FACTOR * 10 + 1)

    # The engine side: the simulated account the orders are placed from.
    engine_store = open_store(tmp_path)
    market = FakeMarket("0.99", "1.01")
    engine_exchange = DryRunExchange(
        engine_store.conn, lambda product: market, D("0.005")
    )
    engine_exchange.deposit("USDC", D("100"), "watchdog sweep")

    cids = ("cb-b1-B+1-a00000000001", "cb-b1-B+2-b00000000002")
    for cid, level in zip(cids, (1, 2)):
        placed = engine_exchange.place_limit(
            cid, PRODUCT, "BUY", D("10"), D("0.98")
        )
        assert placed["ok"] is True
        engine_store.insert_order(
            cid,
            "b1",
            "bot",
            PRODUCT,
            "BUY",
            level,
            D("0.98"),
            D("10"),
            status=OPEN,
            order_id=placed["order_id"],
        )

    # Somebody else's order on the same simulated account, written straight in:
    # no `cb-` prefix, so no sweep may touch it.
    engine_store.conn().execute(
        "INSERT INTO sim_orders(order_id, client_order_id, product, side, price,"
        " size, status, created_at) VALUES(?,?,?,?,?,?,?,?)",
        ("sim-manual", "manual-1", PRODUCT, "BUY", "0.90", "5", "OPEN", clock.later),
    )

    def refuse_market(*args, **kwargs):
        raise AssertionError("the cancel path must not build a market client")

    monkeypatch.setattr(watchdog_module, "MarketData", refuse_market)

    write_heartbeat(tmp_path, NOW - 10_000)
    env = {
        "CROW_COINBASE_WATCHDOG_POLICY": "cancel",
        "CROW_COINBASE_DATA_DIR": str(tmp_path),
        "CROW_COINBASE_POLL_SECONDS": "10",
    }

    code = main(env, max_checks=1, sleep=lambda seconds: None, now=clock)

    assert code == 0
    left = engine_exchange.list_open_orders(None)
    assert [entry["client_order_id"] for entry in left] == ["manual-1"]

    # The exchange's own snapshots are the truth: reconcile settles the two swept
    # rows, and the stranger's order is not ours to write down.
    report = reconcile(engine_store, engine_exchange, clock.later)
    assert report.updated == 2
    for cid in cids:
        row = engine_store.order(cid)
        assert row["status"] == CANCELLED
        assert row["filled_size"] == D("0")
    assert engine_store.order("manual-1") is None
    manual = engine_store.conn().execute(
        "SELECT status FROM sim_orders WHERE client_order_id='manual-1'"
    ).fetchone()
    assert manual["status"] == "OPEN"


def test_main_exits_1_after_three_failing_passes(tmp_path, monkeypatch):
    """Three pass failures in a row end the run with the failure code."""
    calls = []

    def failing(self):
        calls.append(1)
        raise RuntimeError("the pass died")

    monkeypatch.setattr(watchdog_module.Watchdog, "check", failing)
    sleeps = []
    env = {
        "CROW_COINBASE_DATA_DIR": str(tmp_path),
        "CROW_COINBASE_POLL_SECONDS": "10",
    }

    code = main(env, sleep=sleeps.append, max_checks=10)

    assert code == EXIT_FAILED
    assert len(calls) == 3
    assert len(sleeps) == 2  # no sleep after the pass that ends the run

    # One error event for the streak, in the file main built.
    store = open_store(tmp_path)
    assert len(messages(store, "error")) == 1


def test_main_failure_streak_resets(tmp_path, monkeypatch):
    """A pass that returns resets the streak, so the run keeps going."""
    script = ["fail", "fail", "ok", "fail", "fail", "ok"]
    calls = []

    def scripted(self):
        calls.append(1)
        if script[len(calls) - 1] == "fail":
            raise RuntimeError("the pass died")
        return "ok"

    monkeypatch.setattr(watchdog_module.Watchdog, "check", scripted)
    sleeps = []
    env = {
        "CROW_COINBASE_DATA_DIR": str(tmp_path),
        "CROW_COINBASE_POLL_SECONDS": "10",
    }

    code = main(env, sleep=sleeps.append, max_checks=len(script))

    assert code == 0
    assert len(calls) == len(script)

    # No streak of three, so no streak event.
    store = open_store(tmp_path)
    assert messages(store, "error") == []


@pytest.mark.filterwarnings("ignore")  # runpy re-imports a module already loaded
def test_module_runs_as_main(tmp_path, monkeypatch):
    """The module is a process: it refuses a live switch through sys.exit(3)."""
    source = Path(watchdog_module.__file__).read_text()
    assert 'if __name__ == "__main__":' in source
    assert "sys.exit(main())" in source

    monkeypatch.setenv("CROW_COINBASE_LIVE", "true")
    monkeypatch.setenv("CROW_COINBASE_DATA_DIR", str(tmp_path))
    with pytest.raises(SystemExit) as exit_code:
        runpy.run_module("crow_coinbase.watchdog", run_name="__main__")
    assert exit_code.value.code == REFUSED
    assert not (tmp_path / "engine.sqlite").exists()


def test_watchdog_never_places(tmp_path):
    """The source never names a way to put an order on, and a stale run places none."""
    source = Path(watchdog_module.__file__).read_text()
    for forbidden in ("place_limit", "deposit", "limit_order", ".client"):
        assert forbidden not in source

    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)
    write_heartbeat(tmp_path, t[0])
    t[0] += STALE + 1

    assert wd.check() == "acted"
    assert len(fake.cancelled) == 1
    assert fake.placed == []