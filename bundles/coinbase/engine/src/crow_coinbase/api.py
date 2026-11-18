"""api.py: the engine's HTTP surface — health, status, bots, fills, kill.

Every route but `GET /health` needs the engine's bearer token.  The header is
compared with `hmac.compare_digest` — looked up on the `hmac` module at call
time — and the comparison runs even when the header is missing or carries
another scheme, against an empty value, so one refusal takes the same time
whatever was sent.  A mismatch is a 401 that says nothing more.  `/health` is
the one anonymous route and it carries three keys and nothing else: whether the
heartbeat is fresh, that live trading is off, and how old the heartbeat is.  It
reads the heartbeat file and no database, no balance and no exchange.

The surface is dry-run only.  There is no endpoint that switches a route, none
that funds an owner, and no live anything: a bot's capital arrives exactly once,
from its own creation, through `gateway.seed_dry` inside the same transaction
that writes the bot row.  Every mutation runs under `gateway.lock` — the lock a
cycle holds — because a request and a running cycle must never build a book at
the same time.  The kill switch is the one exception to the order and not to the
lock: it halts first, without the lock, so a kill never queues behind a cycle,
and only then takes the lock to sweep the book and stop the bots.

Handlers are plain functions, so FastAPI runs them on worker threads; the store
hands every thread its own sqlite connection, so a handler can read while the
runner's thread writes.  Money is `Decimal` inside and a string in JSON.
"""

from __future__ import annotations

import csv
import hmac
import json
import logging
import re
import tempfile
import time
from collections.abc import Callable, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from . import records
from .benchmark import KEY_PREFIX, Benchmark
from .gateway import NOT_BOT_OWNERS, OrderGateway
from .limits import Limits
from .money import ProductSpec
from .runner import Runner, StartupRefused, realized_pnl
from .store import ACTIVE, BOT_ID_RE, PAUSED, STOPPED, Store
from .strategies.base import Strategy

D = Decimal
log = logging.getLogger("crow_coinbase.api")

# ---------------------------------------------------------------- constants
# The one environment variable this module names: its absence refuses a start.
ENV_TOKEN = "CROW_COINBASE_ENGINE_TOKEN"
MISSING_TOKEN = "CROW_COINBASE_ENGINE_TOKEN is missing or blank"

AUTH_SCHEME = "Bearer"
BEARER_PREFIX = f"{AUTH_SCHEME} "
UNAUTHORIZED = "unauthorized"

# A heartbeat older than this many poll windows means the engine is not cycling.
HEALTH_WINDOWS = 2
# The startup grace: this many poll windows may pass with no heartbeat at all.
DEFAULT_GRACE_WINDOWS = 2

# The event level and how many of them `/status` reports.
ALERT_LEVEL = "ALERT"
ALERT_LIMIT = 10

# Every exported row is a dry-run fill: P1 has no other route.
RECORD_MODE = "dry"
YEAR_RE = re.compile(r"^\d{4}$")
CSV_NAME = "fills.csv"
CSV_PREFIX = "fills-"
CSV_SUFFIX = ".csv"
ALL_YEARS = "all"


# ---------------------------------------------------------------- tokens


def token_or_refuse(token: Optional[str]) -> str:
    """The configured API token, or `StartupRefused` when it is blank.

    Shared by `create_app` and the process wrapper: a blank token is not a
    running engine with unauthenticated routes, it is an engine that refuses to
    start.  Called before anything is opened or written.
    """
    text = "" if token is None else str(token).strip()
    if not text:
        raise StartupRefused(MISSING_TOKEN)
    return text


def _presented_token(authorization: Optional[str]) -> bytes:
    """The bytes a request presented as its bearer token; empty when it named none.

    A missing header and a header of another scheme both answer an empty value,
    so the comparison below always runs and always runs on bytes.
    """
    if not authorization:
        return b""
    header = str(authorization)
    if not header.startswith(BEARER_PREFIX):
        return b""
    return header[len(BEARER_PREFIX) :].strip().encode("utf-8")


# ---------------------------------------------------------------- refusals


def _invalid(detail: str) -> HTTPException:
    """422: the request cannot be honoured as sent."""
    return HTTPException(status_code=422, detail=detail)


def _unknown(detail: str) -> HTTPException:
    """404: no such bot."""
    return HTTPException(status_code=404, detail=detail)


def _conflict(detail: str) -> HTTPException:
    """409: a state the request does not fit."""
    return HTTPException(status_code=409, detail=detail)


def _unavailable(detail: str) -> HTTPException:
    """503: something the surface needs cannot be reached right now."""
    return HTTPException(status_code=503, detail=detail)


def _bad_gateway(detail: str) -> HTTPException:
    """502: the exchange (or the layer in front of it) failed the call."""
    return HTTPException(status_code=502, detail=detail)


# ---------------------------------------------------------------- request bodies


class BotCreate(BaseModel):
    """The whole POST /bots body.

    `extra="forbid"` is load-bearing: P1 is dry-run only, so a body carrying a
    `mode` (or any other field this build does not know) is refused rather than
    quietly ignored.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    product: str
    strategy: str
    params: dict[str, Any]
    capital_quote: str | int | float
    capital_base: str | int | float


class Recenter(BaseModel):
    """The whole POST /bots/{id}/recenter body: one new center, nothing else."""

    model_config = ConfigDict(extra="forbid")

    center: str | int | float


# ---------------------------------------------------------------- money parsing


def _amount(value: Any, field: str) -> D:
    """A non-negative finite `Decimal` from a JSON string or number.

    A number goes through `Decimal(str(value))`, never `Decimal(float)`, so no
    binary rounding is introduced on the way in.  NaN and infinity are refused
    here because every later comparison would answer false for them.
    """
    try:
        amount = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        raise _invalid(f"{field} must be a number") from None
    if not amount.is_finite():
        raise _invalid(f"{field} must be a finite number")
    if amount < 0:
        raise _invalid(f"{field} must be >= 0")
    return amount


def _positive(value: Any, field: str) -> D:
    """A strictly positive finite `Decimal` (a grid center, for instance)."""
    amount = _amount(value, field)
    if amount <= 0:
        raise _invalid(f"{field} must be > 0")
    return amount


# ---------------------------------------------------------------- rows as JSON


def _text(value: Any) -> str:
    """A stored value as the string this surface reports it as."""
    return "" if value is None else str(value)


def _bot_json(bot: Mapping[str, Any]) -> dict:
    """One bot row, money as strings and `init_done` as the boolean it means."""
    return {
        "id": bot["id"],
        "product": bot["product"],
        "strategy": bot["strategy"],
        "params": bot["params"],
        "status": bot["status"],
        "init_done": bool(bot["init_done"]),
        "capital_quote": _text(bot["capital_quote"]),
        "capital_base": _text(bot["capital_base"]),
        "created_at": bot["created_at"],
    }


def _bot_brief(bot: Mapping[str, Any]) -> dict:
    """The five fields `/status` reports per bot."""
    return {
        "id": bot["id"],
        "product": bot["product"],
        "strategy": bot["strategy"],
        "status": bot["status"],
        "init_done": bool(bot["init_done"]),
    }


def _holding_json(product: str, holding: Any) -> dict:
    """One owner's holding on its product, every amount a string."""
    return {
        "product": product,
        "quote": _text(holding.quote),
        "base": _text(holding.base),
        "reserved_quote": _text(holding.reserved_quote),
        "reserved_base": _text(holding.reserved_base),
    }


def _fill_json(row: Any) -> dict:
    """One fills-table row in the shape the surface reports it."""
    return {
        "trade_id": _text(row["trade_id"]),
        "order_id": _text(row["order_id"]),
        "client_order_id": _text(row["client_order_id"]),
        "product": _text(row["product"]),
        "side": _text(row["side"]),
        "size": _text(row["size"]),
        "price": _text(row["price"]),
        "commission": _text(row["commission"]),
        "trade_time": _text(row["trade_time"]),
        "trade_type": _text(row["trade_type"]),
    }


# ---------------------------------------------------------------- the store


def _require_bot(store: Store, bot_id: str) -> dict:
    """The bot row, or a 404 for an id this engine does not know."""
    bot = store.get_bot(bot_id)
    if bot is None:
        raise _unknown(f"no bot {bot_id!r}")
    return bot


def _ever_existed(store: Store, bot_id: str) -> bool:
    """True when this id has ever been used, however little of it is left.

    An id is never reused: a bot row, an order or fill row, a high-water mark,
    or a benchmark record (a `benchmark:<id>` kv KEY, even one holding null,
    which is what forgetting a benchmark leaves behind) all mean the name
    belongs to a history this engine still reports on.
    """
    db = store.conn()
    for sql, args in (
        ("SELECT 1 FROM bots WHERE id=? LIMIT 1", (bot_id,)),
        ("SELECT 1 FROM orders WHERE owner=? LIMIT 1", (bot_id,)),
        ("SELECT 1 FROM fills WHERE owner=? LIMIT 1", (bot_id,)),
        ("SELECT 1 FROM hwm WHERE owner=? LIMIT 1", (bot_id,)),
        ("SELECT 1 FROM kv WHERE key=? LIMIT 1", (f"{KEY_PREFIX}{bot_id}",)),
    ):
        if db.execute(sql, args).fetchone() is not None:
            return True
    return False


def _alert_rows(store: Store) -> list[dict]:
    """The most recent ALERT events, newest first, each as {ts, message}."""
    rows = store.conn().execute(
        "SELECT ts, message FROM events WHERE level=? "
        "ORDER BY ts DESC, rowid DESC LIMIT ?",
        (ALERT_LEVEL, ALERT_LIMIT),
    ).fetchall()
    return [{"ts": row["ts"], "message": row["message"]} for row in rows]


def _fee_total(store: Store, bot_id: str) -> D:
    """What this owner has paid in commission, summed in `Decimal`."""
    total = D(0)
    rows = store.conn().execute(
        "SELECT commission FROM fills WHERE owner=?", (bot_id,)
    )
    for row in rows:
        total += D(row["commission"] or "0")
    return total


def _fill_rows(store: Store, year: Optional[str]) -> list[Any]:
    """Every fill row, oldest first, optionally only one calendar year's."""
    sql = "SELECT * FROM fills"
    args: tuple = ()
    if year is not None:
        sql += " WHERE trade_time LIKE ?"
        args = (f"{year}%",)
    sql += " ORDER BY trade_time, trade_id"
    return list(store.conn().execute(sql, args).fetchall())


# ---------------------------------------------------------------- csv


def _record_fill(row: Any) -> dict:
    """The parts of a fill row `records.append_fill` reads."""
    return {
        "size": row["size"],
        "price": row["price"],
        "commission": row["commission"],
        "side": row["side"],
        "trade_time": row["trade_time"],
        "trade_id": row["trade_id"],
        "order_id": row["order_id"],
    }


def _write_header(path: Path) -> None:
    """A file with the column header and no row: an empty export is still a table."""
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerow(records.COLUMNS)


def _fills_csv(rows: list[Any]) -> str:
    """The fills as CSV text, written by the one formatter that owns the columns.

    Each row goes through `records.append_fill` into a scratch file, so the web
    export and the on-disk trades file can never disagree about a column's
    formatting.  An empty selection still answers the header line.
    """
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / CSV_NAME
        for row in rows:
            records.append_fill(
                path,
                _text(row["product"]),
                _record_fill(row),
                _text(row["client_order_id"]),
                RECORD_MODE,
            )
        if not path.exists():
            _write_header(path)
        return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------- the heartbeat


def _read_json_file(path: Path | str) -> Any:
    """A JSON file's contents, or None when it is absent, unreadable or garbled."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _heartbeat_age(path: Path | str, at: float) -> Optional[float]:
    """How old the heartbeat's stamp is at *at*, or None when there is no stamp.

    No file, an unreadable one, one that is not JSON, and one whose `ts` is not
    a number are all "no stamp": the caller decides what a missing heartbeat
    means, and a garbled file must never read as a fresh one.
    """
    payload = _read_json_file(path)
    if not isinstance(payload, dict):
        return None
    stamp = payload.get("ts")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return None
    return float(at) - float(stamp)


def _health_body(ok: bool, age: Optional[float]) -> dict:
    """The whole `/health` body: three keys, and never a balance or a bot."""
    return {"ok": bool(ok), "live_enabled": False, "heartbeat_age_s": age}


# ---------------------------------------------------------------- bot creation


def _check_new_bot(
    store: Store,
    limits: Limits,
    strategies: Mapping[str, Strategy],
    spec_for: Callable[[str], ProductSpec],
    price_for: Callable[[str], D],
    body: BotCreate,
) -> tuple[D, D]:
    """Every refusal a new bot can earn, in the order they are checked.

    Nothing is written here: the caller runs this inside the transaction that
    writes the row and its one seed, so a refusal anywhere leaves the store
    exactly as it was.  Returns the parsed `(capital_quote, capital_base)`.
    """
    bot_id = body.id
    if not BOT_ID_RE.fullmatch(bot_id):
        raise _invalid(f"bot id {bot_id!r} must be 1-16 lowercase letters or digits")
    if bot_id in NOT_BOT_OWNERS:
        raise _invalid(f"bot id {bot_id!r} is reserved")
    if _ever_existed(store, bot_id):
        raise _conflict(f"bot id {bot_id!r} was used before; ids are never reused")
    if body.product not in limits.products:
        raise _invalid(f"product {body.product!r} is not in the allow-list")
    strategy = strategies.get(body.strategy)
    if strategy is None:
        raise _invalid(f"unknown strategy {body.strategy!r}")
    try:
        spec = spec_for(body.product)
    except Exception as error:  # noqa: BLE001 - any failure means no spec
        raise _invalid(f"no product spec for {body.product}: {error}") from None
    try:
        strategy.validate(body.params, spec)
        why = strategy.fee_guard(body.params, limits.maker_fee_pct)
    except ValueError as error:
        raise _invalid(str(error)) from None
    if why:
        raise _invalid(str(why))

    quote = _amount(body.capital_quote, "capital_quote")
    base = _amount(body.capital_base, "capital_base")
    if quote + base <= 0:
        raise _invalid("capital must be more than zero: both amounts are zero")
    value = quote
    if base > 0:
        try:
            price = price_for(body.product)
        except Exception as error:  # noqa: BLE001 - the price is the exchange's
            raise _unavailable(f"cannot price {body.product}: {error}") from None
        value += base * D(price)
    if value > limits.max_bot_capital_usd:
        raise _invalid(
            f"capital {value} is over the {limits.max_bot_capital_usd} USD cap"
        )
    return quote, base


# ---------------------------------------------------------------- the app


def create_app(
    *,
    store: Store,
    gateway: OrderGateway,
    runner: Runner,
    exchange: Any,
    strategies: Mapping[str, Strategy],
    limits: Limits,
    spec_for: Callable[[str], ProductSpec],
    price_for: Callable[[str], D],
    token: Optional[str],
    heartbeat_path: Path | str,
    now: Callable[[], float] = time.time,
    startup_grace_s: Optional[float] = None,
) -> FastAPI:
    """Build the app over already-built pieces: nothing here opens a file or a socket.

    The token is checked FIRST, before the app object exists: a blank one is a
    refused start, never a set of unauthenticated routes.  `now` is the clock
    the health route reads, `heartbeat_path` the file a cycle writes, and
    `price_for` the mid a bot's base capital is valued at in quote terms.
    """
    secret = token_or_refuse(token).encode("utf-8")
    created_at = now()
    window = HEALTH_WINDOWS * limits.poll_seconds
    grace = (
        DEFAULT_GRACE_WINDOWS * limits.poll_seconds
        if startup_grace_s is None
        else startup_grace_s
    )

    def _check_token(authorization: Optional[str] = Header(default=None)) -> None:
        """The bearer-token gate: uniform on the presented bytes, silent when it passes."""
        presented = _presented_token(authorization)
        if hmac.compare_digest(presented, secret):
            return
        raise HTTPException(
            status_code=401,
            detail=UNAUTHORIZED,
            headers={"WWW-Authenticate": AUTH_SCHEME},
        )

    guard = [Depends(_check_token)]
    app = FastAPI(
        title="crow-coinbase engine",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    # ------------------------------------------------ health (anonymous)
    @app.get("/health")
    def health() -> JSONResponse:
        """Is a cycle still getting through? Three keys, and no bot or balance."""
        at = now()
        age = _heartbeat_age(heartbeat_path, at)
        if age is None:
            # No heartbeat yet: fine while the engine is still starting up,
            # refused once the startup grace has passed without one.
            ok = at - created_at <= grace
            return JSONResponse(
                status_code=200 if ok else 503, content=_health_body(ok, None)
            )
        ok = age <= window
        return JSONResponse(
            status_code=200 if ok else 503, content=_health_body(ok, age)
        )

    # ------------------------------------------------ status
    @app.get("/status", dependencies=guard)
    def status() -> dict:
        """The halt flag, the heartbeat, the bots and the newest alerts."""
        stored = store.get("halted")
        reason = stored.get("reason") if isinstance(stored, dict) else None
        return {
            "halted": gateway.is_halted(),
            "halt_reason": reason,
            "heartbeat": _read_json_file(heartbeat_path),
            "bots": [_bot_brief(bot) for bot in store.list_bots()],
            "recent_alerts": _alert_rows(store),
        }

    # ------------------------------------------------ balances
    @app.get("/balances", dependencies=guard)
    def balances() -> dict:
        """The simulated account, each owner's holding, and what is unallocated."""
        totals = exchange.totals()
        owners = {
            bot["id"]: _holding_json(
                bot["product"], gateway.ledger.holding(bot["id"], bot["product"])
            )
            for bot in store.list_bots()
        }
        return {
            "totals": {cur: _text(value) for cur, value in totals.items()},
            "owners": owners,
            "unallocated": {
                cur: _text(value)
                for cur, value in gateway.ledger.unallocated(totals).items()
            },
        }

    # ------------------------------------------------ bots
    @app.get("/bots", dependencies=guard)
    def list_bots() -> list[dict]:
        """Every bot row, oldest first."""
        return [_bot_json(bot) for bot in store.list_bots()]

    @app.post("/bots", status_code=201, dependencies=guard)
    def create_bot(body: BotCreate) -> dict:
        """Create one dry-run bot and fund it, once, in the same transaction.

        The whole body runs under the cycle lock, and inside it one immediate
        transaction holds both the bot row and the simulated money that funds
        it: a failure after the funding rolls both back, so an id is never left
        half-created and a seed is never applied twice.
        """
        with gateway.lock:
            try:
                with store.tx():
                    quote, base = _check_new_bot(
                        store, limits, strategies, spec_for, price_for, body
                    )
                    row = store.create_bot(
                        body.id,
                        body.product,
                        body.strategy,
                        body.params,
                        quote,
                        base,
                    )
                    gateway.seed_dry(body.id, quote, base)
            except HTTPException:
                raise
            except Exception as error:  # noqa: BLE001 - reported, never swallowed
                log.exception("bot %s: creation failed", body.id)
                raise HTTPException(status_code=500, detail=str(error)) from None
        return _bot_json(row)

    @app.post("/bots/{bot_id}/pause", dependencies=guard)
    def pause_bot(bot_id: str) -> dict:
        """ACTIVE -> PAUSED; any other status is a conflict, nothing written."""
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] != ACTIVE:
                raise _conflict(f"bot {bot_id} is {bot['status']}, not {ACTIVE}")
            store.set_bot_status(bot_id, PAUSED)
            bot["status"] = PAUSED
            return _bot_json(bot)

    @app.post("/bots/{bot_id}/resume", dependencies=guard)
    def resume_bot(bot_id: str) -> dict:
        """PAUSED -> ACTIVE; a stopped bot is not resumed in P1, it is a conflict."""
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] != PAUSED:
                raise _conflict(f"bot {bot_id} is {bot['status']}, not {PAUSED}")
            store.set_bot_status(bot_id, ACTIVE)
            bot["status"] = ACTIVE
            return _bot_json(bot)

    @app.post("/bots/{bot_id}/stop", dependencies=guard)
    def stop_bot(bot_id: str) -> dict:
        """Sweep this bot's book off the exchange, then mark it STOPPED.

        The status is written only after the sweep went through: a failing
        sweep answers 502 and leaves the bot exactly as it was, so the stop can
        simply be retried.  A bot that is already stopped is answered, not swept.
        """
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] == STOPPED:
                return _bot_json(bot)
            try:
                gateway.cancel_all(scope="owner", owner=bot_id)
            except Exception as error:  # noqa: BLE001 - the status stays as it was
                log.warning("bot %s: stop could not sweep the book: %s", bot_id, error)
                raise _bad_gateway(f"could not cancel {bot_id}'s orders: {error}") from None
            store.set_bot_status(bot_id, STOPPED)
            bot["status"] = STOPPED
            return _bot_json(bot)

    @app.post("/bots/{bot_id}/recenter", dependencies=guard)
    def recenter_bot(bot_id: str, body: Recenter) -> dict:
        """Move a grid bot's center, then let the next cycle lay the new book.

        Only a strategy with a `recenter` (the grid) can be moved: a rebalancer
        has no center to move, so it is refused rather than silently ignored.
        """
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            strategy = strategies.get(bot["strategy"])
            if strategy is None or not hasattr(strategy, "recenter"):
                raise _invalid(
                    f"strategy {bot['strategy']!r} cannot be recentered"
                )
            center = _positive(body.center, "center")
            try:
                runner.recenter(bot_id, center)
            except ValueError as error:
                raise _invalid(str(error)) from None
            except RuntimeError as error:
                raise _conflict(str(error)) from None
            except Exception as error:  # noqa: BLE001 - the exchange failed the sweep
                log.warning("bot %s: recenter failed: %s", bot_id, error)
                raise _bad_gateway(f"could not recenter {bot_id}: {error}") from None
            return _bot_json(_require_bot(store, bot_id))

    # ------------------------------------------------ the kill switch
    @app.post("/kill", dependencies=guard)
    def kill() -> Response:
        """Halt first and without the lock, then sweep the book and stop every bot.

        The halt takes no lock by design, so a kill never queues behind a cycle
        that is holding it.  A sweep that fails still stops the bots and still
        answers that the engine is halted: the flag is what refuses every later
        order, and it is already set.
        """
        gateway.halt("kill switch")
        with gateway.lock:
            failure: Optional[BaseException] = None
            cancelled = 0
            try:
                cancelled = gateway.cancel_all(scope="all")
            except Exception as error:  # noqa: BLE001 - the bots stop regardless
                failure = error
                log.error("kill: the sweep failed: %s", error)
            stopped = _stop_every_bot(store)
        if failure is not None:
            return JSONResponse(
                status_code=502,
                content={"detail": str(failure), "halted": True},
            )
        return JSONResponse(
            status_code=200,
            content={"halted": True, "cancelled": cancelled, "stopped": stopped},
        )

    @app.post("/halt/clear", dependencies=guard)
    def clear_halt() -> dict:
        """Lower the halt.  A bot stopped by a kill is not restarted by this."""
        with gateway.lock:
            gateway.clear_halt()
        return {"halted": False}

    # ------------------------------------------------ fills
    @app.get("/bots/{bot_id}/fills", dependencies=guard)
    def bot_fills(bot_id: str) -> list[dict]:
        """Every fill booked against this bot, oldest trade first."""
        _require_bot(store, bot_id)
        rows = store.conn().execute(
            "SELECT * FROM fills WHERE owner=? ORDER BY trade_time, trade_id",
            (bot_id,),
        ).fetchall()
        return [_fill_json(row) for row in rows]

    @app.get("/export/fills.csv", dependencies=guard)
    def export_fills(year: Optional[str] = None) -> Response:
        """The fills as a CSV download, all of them or one calendar year's."""
        stamp = ALL_YEARS
        if year is not None:
            if not YEAR_RE.fullmatch(year):
                raise _invalid("year must be four digits, e.g. 2025")
            stamp = year
        rows = _fill_rows(store, year)
        return Response(
            content=_fills_csv(rows),
            media_type="text/csv",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{CSV_PREFIX}{stamp}{CSV_SUFFIX}"'
                )
            },
        )

    # ------------------------------------------------ profit and loss
    @app.get("/pnl", dependencies=guard)
    def pnl() -> dict:
        """Realized profit, fees, marked equity and the hold-the-mix shadow, per bot.

        A bot whose product has no snapshot has no mark, so its equity and its
        comparison against the benchmark are null rather than invented; the
        same is true of a bot whose benchmark was never started.
        """
        realized = realized_pnl(store)
        benchmark = Benchmark(store)
        entries: dict[str, dict] = {}
        for bot in store.list_bots():
            bot_id = bot["id"]
            product = bot["product"]
            equity: Optional[D] = None
            mid: Optional[D] = None
            snap = gateway.snapshots.get(product)
            if snap is not None:
                mid = (snap.bid + snap.ask) / 2
                equity = gateway.ledger.equity(bot_id, {product: mid}, product)
            vs_hold: Optional[D] = None
            if equity is not None and mid is not None:
                try:
                    vs_hold = benchmark.vs_hold(bot_id, equity, mid)
                except KeyError:
                    vs_hold = None
            entries[bot_id] = {
                "realized": _text(realized.get(bot_id, D(0))),
                "fees": _text(_fee_total(store, bot_id)),
                "equity": None if equity is None else _text(equity),
                "vs_hold": None if vs_hold is None else _text(vs_hold),
            }
        return {"bots": entries}

    return app


def _stop_every_bot(store: Store) -> list[str]:
    """Mark every bot STOPPED and answer their ids in the order they are stored."""
    stopped: list[str] = []
    for bot in store.list_bots():
        store.set_bot_status(bot["id"], STOPPED)
        stopped.append(bot["id"])
    return stopped