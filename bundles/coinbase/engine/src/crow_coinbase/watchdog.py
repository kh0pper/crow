"""The heartbeat watchdog: alert on a stale engine, and optionally pull its orders.

The runner writes `<data_dir>/heartbeat` once per cycle: a small JSON object whose
`ts` is the epoch seconds of that cycle.  This module reads that file and answers
whether the engine is still getting through.  A heartbeat that is absent,
unreadable, malformed, or older than the threshold is stale; a timestamp from far
in the future is stale too, because it is the sign of a clock nothing else can be
compared with.

The age of a numeric `ts` is measured from the LATER of that timestamp and the
moment this watchdog started, so a heartbeat older than the watchdog itself — the
ordinary shape of a restart — gets the same one-window grace as a heartbeat file
that is not there yet, and only a heartbeat that goes stale while the run is
underway counts against the engine.  The future-dated check uses the raw
timestamp.  A file that IS there but cannot be read, does not hold a JSON object,
carries no usable `ts`, or carries one that is not a finite number is stale at
once, with no grace: the engine wrote something and it is wrong.  Exactly the
threshold is still fresh, on either side.

One stale spell is one episode, and the episode lives in the engine's own database
(`kv`, under `watchdog:episode`), so a watchdog restarted in the middle of a spell
joins the one already in progress instead of starting another: one ALERT event
per episode, however many stale passes follow.  The record is cleared only by a
heartbeat that is TRULY FRESH — a valid numeric `ts` within half the threshold of
this clock — so a heartbeat flapping around the threshold (stale, then merely old,
then stale again) stays one episode instead of alerting on every wobble.  A pass
inside a grace window, or one whose heartbeat is not stale but not truly fresh
either, answers "ok" and leaves the record exactly as it found it.

The policy decides what a stale heartbeat does.  `leave` raises the alert only.
`cancel` also takes the engine's own resting orders off the book on EVERY stale
pass — only the orders whose client order id carries the engine's `cb-` prefix,
never an order somebody else put on the same account — so an order that appears
in the middle of an episode is swept by the next pass.  The exchange is built on
the first sweep and reused afterwards, and nothing in that path puts an order on.
A pass whose sweep asked for at least one cancel answers "acted"; a pass with
nothing to cancel asks for nothing and answers "stale"; and a sweep that raises is
written down as an error event and automatically retried by the next stale pass.

`main` is the process entry point: it answers the refusal code for a live switch
this build cannot honour, builds the store and the dry-run exchange over the data
directory, and reads the heartbeat once per poll interval.  A pass that raises is
logged and the loop carries on, but `FAILURE_STREAK_LIMIT` raising passes in a row
mean the loop itself is broken rather than one unlucky cycle: one error event for
the streak, and the failure code, so the supervisor restarts the process.
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Optional

from .exchange import DryRunExchange, MarketData
from .limits import WATCHDOG_POLICIES, Limits
from .runner import ENV_LIVE, LIVE_IN_P1, LIVE_OFF, LIVE_ON
from .store import Store

log = logging.getLogger("crow_coinbase.watchdog")

# The level the API lists as an alert a person is meant to read.
ALERT_LEVEL = "ALERT"
# The prefix every client order id the engine writes carries.
CB_PREFIX = "cb-"
# The kv key holding the stale episode in progress.
KV_EPISODE = "watchdog:episode"
# A heartbeat is stale after this many poll intervals without a new one.
STALE_FACTOR = 5
# 1: the run itself failed and the supervisor should start it again.
EXIT_FAILED = 1
# 3: the configuration may not be started at all (nothing was opened).
EXIT_REFUSED = 3
# This many raising passes in a row end the run instead of being logged and left.
FAILURE_STREAK_LIMIT = 3

ENV_DATA_DIR = "CROW_COINBASE_DATA_DIR"
DEFAULT_DATA_DIR = "/data"
DATABASE_NAME = "engine.sqlite"
HEARTBEAT_NAME = "heartbeat"

# The policy that acts on the book, as opposed to the one that only alerts.
CANCEL_POLICY = "cancel"


def _positive_number(name: str, value: Any) -> float:
    """*value* as a finite float above zero, or a `ValueError` naming *name*."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number of seconds, got {value!r}")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(
            f"{name} must be a finite number greater than 0, got {value!r}"
        )
    return number


def cancel_all_cb_orders(exchange: Any, store: Optional[Store] = None) -> int:
    """Take every resting order the engine wrote off the book, in one call.

    The order list is asked for across every product at once, and only the orders
    whose client order id starts with `cb-` are named: an order without that
    prefix belongs to somebody else on the account and is left where it is.  The
    answer is how many ids were requested, and an empty list asks the exchange
    for nothing at all — no cancel call, and no event either.  With a store, the
    request is written down once as an info event, whatever the exchange answers.
    """
    open_orders = exchange.list_open_orders(None)
    ids: list = []
    for entry in open_orders:
        client_order_id = entry.get("client_order_id")
        if isinstance(client_order_id, str) and client_order_id.startswith(CB_PREFIX):
            ids.append(entry.get("order_id"))
    if not ids:
        return 0
    if store is not None:
        store.event("info", f"watchdog cancel requested for {len(ids)} cb- order(s)")
    exchange.cancel(ids)
    return len(ids)


class Watchdog:
    """Reads the heartbeat and applies the policy to one stale spell at a time.

    `data_dir` is the engine's data directory, the one the runner writes the
    heartbeat into; `store` is the engine's database, which is where the episode
    record, the alert and the info events live; `exchange_factory()` is called
    only from a first sweep, so a watchdog under the alerting policy never builds
    an exchange and a watchdog that sweeps builds exactly one.  The threshold is
    `stale_after_s` seconds without a new heartbeat, and `now` is the clock the
    ages are measured with.

    `started` is the one clock reading the constructor takes: it is the moment the
    cold-start grace is measured from, and the earlier bound of a heartbeat's age.
    """

    def __init__(
        self,
        data_dir: Path | str,
        store: Store,
        exchange_factory: Callable[[], Any],
        policy: str,
        stale_after_s: float = 5 * 60,
        now: Callable[[], float] = time.time,
    ) -> None:
        if policy not in WATCHDOG_POLICIES:
            raise ValueError(
                f"watchdog policy must be one of {', '.join(WATCHDOG_POLICIES)}, "
                f"got {policy!r}"
            )
        self.data_dir = Path(data_dir)
        self.heartbeat_path = self.data_dir / HEARTBEAT_NAME
        self.store = store
        self.exchange_factory = exchange_factory
        self.policy = policy
        self.stale_after_s = _positive_number("stale_after_s", stale_after_s)
        self.now = now
        self.started = now()
        # The exchange the sweeps use: built by the first sweep, then reused.
        self._exchange: Any = None

    # ------------------------------------------------ the heartbeat
    def stale_reason(self) -> Optional[str]:
        """Why the heartbeat is stale, or None while it is fresh.

        A missing heartbeat file is given one grace window from the moment this
        watchdog started, because a watchdog that comes up beside an engine which
        has not written its first heartbeat yet is not looking at a failure.  A
        file that IS there but cannot be read, does not hold a JSON object,
        carries no usable `ts`, or carries one that is not a finite number is
        stale at once: the engine wrote something and it is wrong.

        The age of a timestamp is measured from `max(ts, started)`, so a heartbeat
        dated before this run is inside the grace as well, and it is measured both
        ways: a timestamp more than the threshold ahead of this clock is a clock
        problem, not a fresh engine, and that check uses the raw timestamp.
        Exactly the threshold is still fresh on either side.  `_inspect` holds
        the reading; this is the answer a caller outside this class wants.
        """
        return self._inspect()[0]

    def _inspect(self) -> tuple[Optional[str], Optional[float]]:
        """One reading of the heartbeat: the stale reason, and the signed raw age.

        The reason is None while the heartbeat is fresh.  The age is `now - ts`
        for a heartbeat that carried a usable numeric timestamp, and None for one
        that did not: it is what tells a truly fresh heartbeat from one that is
        merely not stale yet.
        """
        now = self.now()
        path = self.heartbeat_path
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            waited = now - self.started
            if waited > self.stale_after_s:
                return f"heartbeat file is missing at {path}", None
            return None, None
        except OSError as error:
            return f"heartbeat file at {path} cannot be read: {error}", None

        try:
            payload = json.loads(text)
        except ValueError as error:
            return f"heartbeat file at {path} is not valid JSON: {error}", None
        if not isinstance(payload, dict):
            return f"heartbeat file at {path} does not hold a JSON object", None

        stamp = payload.get("ts")
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
            return f"heartbeat at {path} carries no numeric timestamp", None
        seconds = float(stamp)
        if not math.isfinite(seconds):
            return (
                f"heartbeat at {path} carries a timestamp that is not finite",
                None,
            )

        age = now - seconds
        if -age > self.stale_after_s:
            return f"heartbeat at {path} is dated {-age:.0f}s in the future", age
        measured = now - max(seconds, self.started)
        if measured > self.stale_after_s:
            return f"heartbeat at {path} is {measured:.0f}s old", age
        return None, age

    def _truly_fresh(self, age: Optional[float]) -> bool:
        """True only for a numeric `ts` within half the threshold of this clock.

        That is stricter than "not stale": a heartbeat between half the threshold
        and the threshold keeps the episode record alive, so a heartbeat sitting
        on the edge cannot clear and reopen an episode on every pass.
        """
        return age is not None and abs(age) <= self.stale_after_s / 2

    # ------------------------------------------------ one pass
    def check(self) -> str:
        """One pass: "ok" while the heartbeat is fresh, else "stale" or "acted".

        "ok" is answered both by a truly fresh heartbeat and by one that is merely
        not stale yet (inside a grace window, or between half the threshold and
        the threshold).  Only the truly fresh one ends the episode: it clears the
        record, and the next spell alerts again.  A merely fresh pass writes
        nothing at all, so a restarted watchdog still joins the episode it finds.

        A stale pass raises the alert once per episode — the record is stored
        BEFORE the alert is written, so an alert that cannot be written is not
        repeated — and under the cancel policy sweeps the book on every stale
        pass, not just the first: an order that appeared mid-episode goes with the
        next pass.  "acted" is the answer of a pass whose sweep requested at least
        one cancel; a pass with nothing to cancel answers "stale".  A sweep that
        raises is recorded as an error event and the next pass sweeps again.
        """
        reason, age = self._inspect()
        if reason is None:
            if self._truly_fresh(age) and self.store.get(KV_EPISODE) is not None:
                self.store.put(KV_EPISODE, None)
            return "ok"

        episode = self._episode()
        if not episode["alerted"]:
            episode["alerted"] = True
            self.store.put(KV_EPISODE, episode)
            message = f"engine heartbeat stale: {reason}"
            log.error(message)
            self.store.event(ALERT_LEVEL, message)

        if self.policy != CANCEL_POLICY:
            return "stale"

        try:
            requested = cancel_all_cb_orders(self._sweep_exchange(), self.store)
        except Exception as error:  # noqa: BLE001 - the next pass tries again
            message = f"watchdog cancel failed: {error}"
            log.exception(message)
            self.store.event("error", message)
            return "stale"
        return "acted" if requested else "stale"

    # ------------------------------------------------ the episode record
    def _episode(self) -> dict:
        """The spell in progress, a fresh one when nothing is stored.

        Only `alerted` is kept: alerts are once per episode, while the sweep runs
        on every stale pass and needs no record of its own.
        """
        stored = self.store.get(KV_EPISODE)
        if not isinstance(stored, dict):
            return {"alerted": False}
        return {"alerted": bool(stored.get("alerted"))}

    # ------------------------------------------------ the exchange
    def _sweep_exchange(self) -> Any:
        """The exchange the sweeps use, built on the first one and then reused.

        A build that raises is not remembered, so the next stale pass tries to
        build again instead of sweeping with something half-made.
        """
        if self._exchange is None:
            self._exchange = self.exchange_factory()
        return self._exchange


def _dry_run_factory(store: Store, limits: Limits) -> Callable[[], Any]:
    """A factory building the dry-run exchange over the engine's own database.

    The public market clients are built on demand and kept per product, and
    nothing here reads a book: this is only called when a cancel is about to run,
    and that call lists orders and cancels them, so no market client is ever
    built on this path.
    """
    markets: dict[str, MarketData] = {}

    def market_for(product: str) -> MarketData:
        market = markets.get(product)
        if market is None:
            market = MarketData(product)
            markets[product] = market
        return market

    def build() -> Any:
        return DryRunExchange(store.conn, market_for, limits.maker_fee_pct / 100)

    return build


def _give_up(store: Store, failures: int, error: Exception) -> int:
    """End a loop that keeps raising: one error event for the streak, then the code.

    The event write is best effort: a store that is itself broken is one of the
    likeliest reasons a pass dies, and it must not keep the process from
    answering with the code its supervisor restarts it on.
    """
    message = f"watchdog stopping after {failures} failing passes in a row: {error}"
    log.error(message)
    try:
        store.event("error", message)
    except Exception as broken:  # noqa: BLE001 - the exit matters, not the record
        log.exception("watchdog could not record the streak: %s", broken)
    return EXIT_FAILED


def main(
    env: Optional[Mapping[str, str]] = None,
    *,
    exchange_factory: Optional[Callable[[], Any]] = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.time,
    max_checks: Optional[int] = None,
) -> int:
    """Run the watchdog: the refusal code, then one pass per poll interval.

    A live switch this build cannot honour answers `EXIT_REFUSED` before any file
    is opened, and so does a configuration the limits refuse.  Otherwise the
    store and the exchange factory are built over the data directory, the policy
    and the threshold are taken from `limits` (the threshold is
    `STALE_FACTOR` poll intervals), and each pass reads the heartbeat before
    waiting out the interval.  `max_checks` ends the loop after that many passes,
    which is how a caller bounds the run.

    A pass that raises is logged and the loop carries on, with one wait after it
    as usual; a pass that returns resets that count.  `FAILURE_STREAK_LIMIT`
    raising passes in a row are not one unlucky cycle but a broken loop, so the
    run ends there: one error event, and `EXIT_FAILED` instead of another wait.
    """
    logging.basicConfig(level=logging.INFO)
    source = os.environ if env is None else env

    switch = str(source.get(ENV_LIVE) or "").strip().lower()
    if switch in LIVE_ON or switch not in LIVE_OFF:
        log.error("%s=%r: %s", ENV_LIVE, switch, LIVE_IN_P1)
        return EXIT_REFUSED

    try:
        limits = Limits.from_env(source)
    except ValueError as error:
        log.error("refusing to start: %s", error)
        return EXIT_REFUSED

    data_dir = Path(source.get(ENV_DATA_DIR) or DEFAULT_DATA_DIR)
    store = Store(data_dir / DATABASE_NAME)
    if exchange_factory is None:
        exchange_factory = _dry_run_factory(store, limits)

    watchdog = Watchdog(
        data_dir,
        store,
        exchange_factory,
        limits.watchdog_policy,
        stale_after_s=STALE_FACTOR * limits.poll_seconds,
        now=now,
    )

    passes = 0
    failures = 0
    while max_checks is None or passes < max_checks:
        passes += 1
        try:
            watchdog.check()
        except Exception as error:  # noqa: BLE001 - one bad pass is not the end
            log.exception("watchdog pass %s failed: %s", passes, error)
            failures += 1
            if failures >= FAILURE_STREAK_LIMIT:
                return _give_up(store, failures, error)
        else:
            failures = 0
        sleep(limits.poll_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())