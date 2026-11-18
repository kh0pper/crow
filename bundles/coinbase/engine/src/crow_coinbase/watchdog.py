"""The heartbeat watchdog: alert on a stale engine, and optionally pull its orders.

The runner writes `<data_dir>/heartbeat` once per cycle: a small JSON object whose
`ts` is the epoch seconds of that cycle.  This module reads that file and answers
whether the engine is still getting through.  A heartbeat that is absent,
unreadable, malformed, or older than the threshold is stale; a timestamp from far
in the future is stale too, because it is the sign of a clock nothing else can be
compared with.

One stale spell is one episode, and the episode lives in the engine's own database
(`kv`, under `watchdog:episode`), so a watchdog restarted in the middle of a spell
joins the one already in progress instead of starting another: one ALERT event and
one cancel attempt per episode.  Once the heartbeat is fresh again the record is
cleared, which makes the next spell a new episode.

The policy decides what a stale heartbeat does.  `leave` raises the alert only.
`cancel` also takes the engine's own resting orders off the book — only the orders
whose client order id carries the engine's `cb-` prefix, never an order somebody
else put on the same account — with one exchange call, and it never puts an order
on.  A cancel that fails is written down and tried again on the next pass.

`main` is the process entry point: it answers the refusal code for a live switch
this build cannot honour, builds the store and the dry-run exchange over the data
directory, and reads the heartbeat once per poll interval.
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
# 3: the configuration may not be started at all (nothing was opened).
EXIT_REFUSED = 3

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
    for nothing at all.  With a store, the request is written down once as an
    info event, whatever the exchange answers.
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
    only when a cancel is about to run, so a watchdog under the alerting policy
    never builds an exchange.  The threshold is `stale_after_s` seconds without a
    new heartbeat, and `now` is the clock the ages are measured with.
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

    # ------------------------------------------------ the heartbeat
    def stale_reason(self) -> Optional[str]:
        """Why the heartbeat is stale, or None while it is fresh.

        A file that is not there at all is given one grace window from the
        moment this watchdog started, because a watchdog that comes up beside an
        engine which has not written its first heartbeat yet is not looking at a
        failure.  A file that IS there but cannot be read, does not hold a JSON
        object, carries no usable `ts`, or carries one that is not a finite
        number is stale at once: the engine wrote something and it is wrong.

        The age is measured both ways.  Older than the threshold is stale, and so
        is a timestamp more than the threshold ahead of this clock: a heartbeat
        dated in the future is a clock problem, not a fresh engine.  Exactly the
        threshold is still fresh on either side.
        """
        path = self.heartbeat_path
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            waited = self.now() - self.started
            if waited > self.stale_after_s:
                return f"heartbeat file is missing at {path}"
            return None
        except OSError as error:
            return f"heartbeat file at {path} cannot be read: {error}"

        try:
            payload = json.loads(text)
        except ValueError as error:
            return f"heartbeat file at {path} is not valid JSON: {error}"
        if not isinstance(payload, dict):
            return f"heartbeat file at {path} does not hold a JSON object"

        stamp = payload.get("ts")
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
            return f"heartbeat at {path} carries no numeric timestamp"
        seconds = float(stamp)
        if not math.isfinite(seconds):
            return f"heartbeat at {path} carries a timestamp that is not finite"

        age = self.now() - seconds
        if age > self.stale_after_s:
            return f"heartbeat at {path} is {age:.0f}s old"
        if -age > self.stale_after_s:
            return f"heartbeat at {path} is dated {-age:.0f}s in the future"
        return None

    # ------------------------------------------------ one pass
    def check(self) -> str:
        """One pass: "ok" while the heartbeat is fresh, else "stale" or "acted".

        A fresh heartbeat ends any spell in progress, so the record is cleared
        and the next spell alerts again.  A stale one raises the alert once per
        episode and, under the cancel policy, builds the exchange and asks it to
        take the engine's orders off the book once.  "acted" is the answer of the
        pass that made that request; every later pass of the same episode answers
        "stale".  A cancel that raises is recorded as an error event and leaves
        the episode uncancelled, so the next pass asks again.
        """
        reason = self.stale_reason()
        if reason is None:
            if self.store.get(KV_EPISODE) is not None:
                self.store.put(KV_EPISODE, None)
            return "ok"

        episode = self._episode()
        if not episode["alerted"]:
            message = f"engine heartbeat stale: {reason}"
            log.error(message)
            self.store.event(ALERT_LEVEL, message)
            episode["alerted"] = True

        if self.policy == CANCEL_POLICY and not episode["cancelled"]:
            try:
                cancel_all_cb_orders(self.exchange_factory(), self.store)
            except Exception as error:  # noqa: BLE001 - the next pass tries again
                message = f"watchdog cancel failed: {error}"
                log.exception(message)
                self.store.event("error", message)
                episode["cancelled"] = False
                self.store.put(KV_EPISODE, episode)
                return "stale"
            episode["cancelled"] = True
            self.store.put(KV_EPISODE, episode)
            return "acted"

        self.store.put(KV_EPISODE, episode)
        return "stale"

    # ------------------------------------------------ the episode record
    def _episode(self) -> dict:
        """The spell in progress as two flags, a fresh one when nothing is stored."""
        stored = self.store.get(KV_EPISODE)
        if not isinstance(stored, dict):
            return {"alerted": False, "cancelled": False}
        return {
            "alerted": bool(stored.get("alerted")),
            "cancelled": bool(stored.get("cancelled")),
        }


def _dry_run_factory(store: Store, limits: Limits) -> Callable[[], Any]:
    """A factory building the dry-run exchange over the engine's own database.

    The public market clients are built on demand and kept per product, and
    nothing here reads a book: this is only called when a cancel is about to run,
    and that call lists orders and cancels them.
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
    waiting out the interval.  A pass that raises is logged and the loop carries
    on.  `max_checks` ends the loop after that many passes, which is how a caller
    bounds the run.
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
    while max_checks is None or passes < max_checks:
        passes += 1
        try:
            watchdog.check()
        except Exception as error:  # noqa: BLE001 - one bad pass is not the end
            log.exception("watchdog pass %s failed: %s", passes, error)
        sleep(limits.poll_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())