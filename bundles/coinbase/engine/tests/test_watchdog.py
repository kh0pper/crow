"""tests/test_watchdog.py: the heartbeat watchdog, its cancel and its one alert.

Nothing here waits: the clock is a one-element list the test moves, so "four
hundred seconds stale" is a single assignment and a stale heartbeat is stale at
the instant the test says so.  A real `Store` on a temporary file is the system
of record, because the episode record and the events both live in the database:
that is what makes a second `Watchdog` over the same file see the same episode.
The data directory is `tmp_path`, and the exchange is a `FakeExchange` that
keeps its open orders in a list and records the `list_open_orders` product
arguments and the `cancel` id lists; its `place_limit` and `deposit` only append
to `placed`, so a test can assert the watchdog never put anything on the book.

`main` is called with the same fakes: its loop runs its promised number of
passes with an injected `sleep` and `now`, so no real exchange is built and no
real second goes by.  The live switch is the piece the environment itself
controls, and every value this build cannot honour has to answer the refusal
code before the data directory is touched.
"""

from __future__ import annotations

import json
import runpy
from pathlib import Path

import pytest

import crow_coinbase.watchdog as watchdog_module
from crow_coinbase.store import Store
from crow_coinbase.watchdog import Watchdog, cancel_all_cb_orders, main

NOW = 1000.0  # the clock every test starts at
STALE = 300.0  # the threshold the tests construct the watchdog with
HEARTBEAT = "heartbeat"  # the file the runner writes next to engine.sqlite
# The two orders a cancel may touch: the one cb- order per product.
CB_ORDER_IDS = frozenset({"oid-btc", "oid-xrp"})
REFUSED = 3  # the contract's EXIT_REFUSED: the configuration may not start


# ---------------------------------------------------------------- the outside world


class FakeExchange:
    """Open orders in a list; every list and cancel recorded, nothing placed."""

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
            return list(self.orders)
        return [entry for entry in self.orders if entry["product"] == product]

    # -- the one write the watchdog may make
    def cancel(self, order_ids):
        ids = list(order_ids)
        self.cancelled.append(ids)
        if self.fail_cancel_times:
            self.fail_cancel_times -= 1
            raise RuntimeError("the exchange refused the cancel")
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


def order(order_id, client_order_id, product="BTC-USDC"):
    """One open order in the shape `list_open_orders` hands back."""
    return {
        "order_id": order_id,
        "client_order_id": client_order_id,
        "product": product,
        "side": "BUY",
    }


def cb_orders_exchange():
    """One cb- order per product, plus three orders a cancel has to leave alone."""
    return FakeExchange(
        [
            order("oid-btc", "cb-b1-B+1-aaaaaaaaaaaa", "BTC-USDC"),
            order("oid-xrp", "cb-b2-S-2-bbbbbbbbbbbb", "XRP-USDC"),
            order("oid-manual", "manual-1", "BTC-USDC"),
            order("oid-blank", "", "XRP-USDC"),
            order("oid-lookalike", "xcb-foo", "BTC-USDC"),
        ]
    )


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
    write_heartbeat(tmp_path, t[0] - STALE)
    assert wd.check() == "ok"
    assert messages(store, "ALERT") == []

    # One second past it is stale.
    write_heartbeat(tmp_path, t[0] - STALE - 1)
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

    write_heartbeat(tmp_path, t[0] - 400)

    assert isinstance(wd.stale_reason(), str)
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert factory.calls == 0
    assert fake.listed == []
    assert fake.cancelled == []
    assert fake.placed == []


# ---------------------------------------------------------------- the cancel policy


def test_stale_cancel_policy_cb_only(tmp_path):
    """A stale cancel policy cancels the cb- orders and never the others."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0] - 400)

    assert wd.check() == "acted"

    # The list is unfiltered: every product at once, not one product at a time.
    assert fake.listed == [None]
    assert len(fake.cancelled) == 1
    assert set(fake.cancelled[0]) == CB_ORDER_IDS
    assert fake.placed == []
    assert any("cancel" in message.lower() for message in messages(store, "info"))
    assert len(messages(store, "ALERT")) == 1

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
    assert cancel_all_cb_orders(direct, None) == 2
    assert len(direct.cancelled) == 2
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


def test_alert_once_per_episode(tmp_path):
    """One alert and one cancel per stale spell, however many passes it takes."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0] - 400)

    assert wd.check() == "acted"
    assert wd.check() == "stale"
    assert wd.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert factory.calls == 1

    # A second watchdog over the same file joins the episode in progress.
    restarted = watchdog(tmp_path, store, factory, "cancel", t=t)
    assert restarted.check() == "stale"
    assert len(messages(store, "ALERT")) == 1
    assert len(fake.cancelled) == 1
    assert factory.calls == 1

    # A fresh heartbeat ends the episode.
    write_heartbeat(tmp_path, t[0])
    assert wd.check() == "ok"
    assert len(messages(store, "ALERT")) == 1

    # The next stale spell is a new episode: it alerts and cancels again.
    t[0] += 10_000
    assert wd.check() == "acted"
    assert len(messages(store, "ALERT")) == 2
    assert len(fake.cancelled) == 2

    # The same sequence under the leave policy: an alert per episode, no cancel.
    leave_dir = tmp_path / "leave"
    leave_dir.mkdir()
    leave_store = open_store(leave_dir)
    leave_fake = cb_orders_exchange()
    leave_factory = Factory(leave_fake)
    leave_wd = watchdog(leave_dir, leave_store, leave_factory, "leave", t=t)

    write_heartbeat(leave_dir, t[0] - 400)
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
    """A cancel that raises leaves an error event and is retried on the next pass."""
    t = [NOW]
    store = open_store(tmp_path)
    fake = cb_orders_exchange()
    fake.fail_cancel_times = 1
    factory = Factory(fake)
    wd = watchdog(tmp_path, store, factory, "cancel", t=t)

    write_heartbeat(tmp_path, t[0] - 400)

    assert wd.check() == "stale"
    assert len(messages(store, "error")) == 1
    assert len(messages(store, "ALERT")) == 1

    # The episode kept cancelled=False, so this pass tries again and gets through.
    assert wd.check() == "acted"
    assert len(fake.cancelled) == 2
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
    t = [NOW]
    fake = cb_orders_exchange()
    factory = Factory(fake)
    write_heartbeat(tmp_path, 0)
    env = {
        "CROW_COINBASE_WATCHDOG_POLICY": "cancel",
        "CROW_COINBASE_DATA_DIR": str(tmp_path),
        "CROW_COINBASE_POLL_SECONDS": "10",
    }

    code = main(
        env,
        exchange_factory=factory,
        sleep=lambda seconds: None,
        now=lambda: t[0],
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
    write_heartbeat(tmp_path, t[0] - 400)

    assert wd.check() == "acted"
    assert len(fake.cancelled) == 1
    assert fake.placed == []