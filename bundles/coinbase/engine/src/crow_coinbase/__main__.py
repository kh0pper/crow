"""__main__.py: one process per engine — build the pieces, check them, run them.

`build_app` wires the real engine over a data directory: the sqlite store, the
dry-run exchange over that same file, the snapshot cache, the ledger, the order
gateway, the two strategies and the runner, and finally the HTTP app over all of
them.  The token is read before anything on disk is touched: an engine with no
token is refused, not started with unauthenticated routes.

`main` then does the three things a container needs, in this order:

    1. build, and answer `EXIT_REFUSED` for a configuration that may not start
    2. run the runner's own startup checks; any problem refuses the start too,
       and nothing is started (no thread, no socket)
    3. start the cycle loop on its own daemon thread, then serve the app

The runner's thread is the engine's life.  `_run_runner` ends the process when
the loop returns or raises: a loop that gave up (five failed cycles in a row) is
a container that has to be restarted, so it exits with `EXIT_RUNNER_DIED` in
every case — returning quietly would leave an API answering with a heartbeat
that never gets fresher.  `os._exit` is called as an attribute lookup on the
module, so a test can stand in for it.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

import uvicorn

from .api import ENV_TOKEN, create_app, token_or_refuse
from .exchange import DryRunExchange, MarketData
from .gateway import OrderGateway
from .ledger import Ledger
from .limits import CapWindow, Limits
from .runner import Runner, StartupRefused, build_snapshot_cache
from .store import Store
from .strategies.base import Strategy
from .strategies.grid import GridStrategy
from .strategies.rebalance import RebalanceStrategy

D = Decimal
log = logging.getLogger("crow_coinbase.main")

# ---------------------------------------------------------------- the process
# Every interface INSIDE the container; the host side of the published port is
# loopback only, so this address never reaches a network of its own.
HOST = "0.0.0.0"
PORT = 3062

# 3: the configuration may not be started at all (nothing was opened).
EXIT_REFUSED = 3
# 1: the cycle loop ended, so the process has to be replaced.
EXIT_RUNNER_DIED = 1

ENV_DATA_DIR = "CROW_COINBASE_DATA_DIR"
DEFAULT_DATA_DIR = "/data"
DATABASE_NAME = "engine.sqlite"
HEARTBEAT_NAME = "heartbeat"
RUNNER_THREAD_NAME = "coinbase-runner"


@dataclass(frozen=True)
class Engine:
    """One built engine: what serves requests, and what cycles underneath it."""

    app: Any
    runner: Runner
    store: Store
    gateway: OrderGateway
    exchange: Any
    limits: Limits


# ---------------------------------------------------------------- markets


def _cached_market_for() -> Callable[[str], MarketData]:
    """A `market_for` that builds one public-data client per product, once."""
    cache: dict[str, MarketData] = {}

    def market_for(product: str) -> MarketData:
        market = cache.get(product)
        if market is None:
            market = MarketData(product)
            cache[product] = market
        return market

    return market_for


def _cached_spec_for(
    market_for: Callable[[str], MarketData],
) -> Callable[[str], Any]:
    """A `spec_for` that reads each product's spec off its market client once."""
    cache: dict[str, Any] = {}

    def spec_for(product: str) -> Any:
        spec = cache.get(product)
        if spec is None:
            spec = market_for(product).product()[0]
            cache[product] = spec
        return spec

    return spec_for


def _book_mid(bid: Any, ask: Any) -> D:
    """The mid of the top of book, or a `ValueError` when it is not a price.

    A bid at or below zero, an ask that does not sit above the bid (a crossed
    book), and a mid that is not a finite positive number are all a book this
    engine cannot value anything with: raising here is what lets the surface
    answer 503 rather than counting a bot's base capital as nothing.
    """
    top_bid, top_ask = D(bid), D(ask)
    if not top_bid.is_finite() or not top_ask.is_finite():
        raise ValueError(f"the book is not finite: bid {bid}, ask {ask}")
    if top_bid <= 0:
        raise ValueError(f"the book has no bid: bid {bid}, ask {ask}")
    if top_ask <= top_bid:
        raise ValueError(f"the book is crossed: bid {bid}, ask {ask}")
    mid = (top_bid + top_ask) / 2
    if not mid.is_finite() or mid <= 0:
        raise ValueError(f"the book's mid is not a positive number: {mid}")
    return mid


def _price_for(
    snapshots: Any, market_for: Callable[[str], MarketData]
) -> Callable[[str], D]:
    """The mid a bot's base capital is valued at, from the cache or the book.

    A usable snapshot is the price the engine's own orders are checked against,
    so it is preferred; with none (a bot created before the first poll) the
    public top of book answers instead, and a book that cannot be read — no
    bid, a crossed one, a price that is not finite — raises to the caller.
    """

    def price_for(product: str) -> D:
        snap = snapshots.get(product)
        if snap is not None and snap.bid > 0 and snap.ask > snap.bid:
            return _book_mid(snap.bid, snap.ask)
        bid, ask = market_for(product).best_bid_ask()
        return _book_mid(bid, ask)

    return price_for


# ---------------------------------------------------------------- building


def build_app(
    env: Mapping[str, str],
    *,
    data_dir: Optional[Path | str] = None,
    market_for: Optional[Callable[[str], Any]] = None,
    spec_for: Optional[Callable[[str], Any]] = None,
    now: Callable[[], float] = time.time,
    strategies: Optional[Mapping[str, Strategy]] = None,
) -> Engine:
    """Build the whole engine over *data_dir*, with the outside world injected.

    The token is checked first, before the data directory is created: a refused
    start leaves no file behind.  `market_for` and `spec_for` default to public
    market data (built lazily, so nothing here opens a socket), `now` is the
    clock the runner stamps the heartbeat with, and `strategies` defaults to the
    grid and the rebalancer.
    """
    token = token_or_refuse(env.get(ENV_TOKEN))
    target = (
        Path(data_dir)
        if data_dir is not None
        else Path(env.get(ENV_DATA_DIR) or DEFAULT_DATA_DIR)
    )
    target.mkdir(parents=True, exist_ok=True)

    limits = Limits.from_env(env)
    fee_rate = limits.maker_fee_pct / 100
    if market_for is None:
        market_for = _cached_market_for()
    if spec_for is None:
        spec_for = _cached_spec_for(market_for)
    chosen = (
        dict(strategies)
        if strategies is not None
        else {"grid": GridStrategy(), "rebalance": RebalanceStrategy()}
    )

    store = Store(target / DATABASE_NAME)
    exchange = DryRunExchange(store.conn, market_for, fee_rate)
    snapshots = build_snapshot_cache(limits)
    ledger = Ledger(store, fee_rate=fee_rate)
    caps = CapWindow(store, time.time)
    gateway = OrderGateway(
        store=store,
        ledger=ledger,
        limits=limits,
        caps=caps,
        snapshots=snapshots,
        spec_for=spec_for,
        fee_rate=fee_rate,
        totals=exchange.totals,
        exchange=exchange,
        live_enabled=False,
        now=time.time,
    )
    heartbeat_path = target / HEARTBEAT_NAME
    runner = Runner(
        store=store,
        gateway=gateway,
        exchange=exchange,
        snapshots=snapshots,
        strategies=chosen,
        env=env,
        market_for=market_for,
        spec_for=spec_for,
        now=now,
        heartbeat_path=heartbeat_path,
    )
    app = create_app(
        store=store,
        gateway=gateway,
        runner=runner,
        exchange=exchange,
        strategies=chosen,
        limits=limits,
        spec_for=spec_for,
        price_for=_price_for(snapshots, market_for),
        token=token,
        heartbeat_path=heartbeat_path,
        now=now,
    )
    return Engine(
        app=app,
        runner=runner,
        store=store,
        gateway=gateway,
        exchange=exchange,
        limits=limits,
    )


# ---------------------------------------------------------------- running


def _run_runner(runner: Any) -> None:
    """Run the cycle loop on this thread, and end the process whenever it stops.

    A raise and a plain return are the same outcome here: the engine has no loop,
    so the container has to start another one.  The error is logged first, so the
    reason survives into the log the restart replaces.
    """
    try:
        runner.run_forever()
        log.error("the runner returned; ending the process")
    except BaseException as error:  # noqa: BLE001 - any end of the loop ends us
        log.error("the runner stopped: %s", error)
    finally:
        os._exit(EXIT_RUNNER_DIED)


def main(
    env: Optional[Mapping[str, str]] = None,
    *,
    build: Callable[[Mapping[str, str]], Engine] = build_app,
    serve: Optional[Callable[..., Any]] = None,
) -> int:
    """Build, check, start the loop and serve; the exit code of a refused start.

    A `StartupRefused` (or any `ValueError` out of the configuration), and any
    problem the runner's own startup checks report, answer `EXIT_REFUSED` with
    nothing started: no thread, no socket.  Logging is configured first, so a
    refusal and the reasons for it reach the container's log.
    """
    logging.basicConfig(level=logging.INFO)
    source = os.environ if env is None else env
    run = uvicorn.run if serve is None else serve

    try:
        engine = build(source)
    except StartupRefused as error:
        log.error("refusing to start: %s", error)
        return EXIT_REFUSED
    except ValueError as error:
        log.error("refusing to start: %s", error)
        return EXIT_REFUSED

    problems = engine.runner.startup_checks()
    if problems:
        for problem in problems:
            log.error("startup check failed: %s", problem)
        return EXIT_REFUSED

    thread = threading.Thread(
        target=_run_runner,
        args=(engine.runner,),
        name=RUNNER_THREAD_NAME,
        daemon=True,
    )
    thread.start()
    run(engine.app, host=HOST, port=PORT)
    return 0


if __name__ == "__main__":
    sys.exit(main())