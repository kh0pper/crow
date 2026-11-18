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
and only then takes the lock to sweep the book and stop the bots.  Clearing a
halt is an acknowledgement rather than a reset: the portfolio high-water mark is
written down to today's equity and every grid bot re-initialises its book, so the
drawdown the stop fired on cannot fire again on the next cycle.

Handlers are plain functions, so FastAPI runs them on worker threads; the store
hands every thread its own sqlite connection, so a handler can read while the
runner's thread writes.  Money is `Decimal` inside and a string in JSON.
"""

from __future__ import annotations

import csv
import hmac
import json
import logging
import math
import re
import tempfile
import time
from collections.abc import Callable, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationInfo, field_validator

from . import records
from .benchmark import KEY_PREFIX, Benchmark
from .gateway import NOT_BOT_OWNERS, PORTFOLIO_OWNER, OrderGateway
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
WHITESPACE_TOKEN = "CROW_COINBASE_ENGINE_TOKEN must not contain whitespace"
SHORT_TOKEN = "CROW_COINBASE_ENGINE_TOKEN is shorter than 32 characters"
# The shortest token this engine serves with.  A token is compared byte for
# byte, so it is never trimmed: whitespace in the configured value is a mistake
# to refuse, not one to repair into a different secret.
MIN_TOKEN_CHARS = 32

# The largest exponent an amount may carry: 1e16 and up is a typo or an attack,
# and it is refused before it reaches any arithmetic.
MAX_AMOUNT_EXPONENT = 15

# What a failed POST /bots says: the exception text goes to the log, not out.
CREATE_FAILED = "bot creation failed"

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

# The strategy that funds a target mix instead of buying a position: it keeps no
# cost basis, so it has no realized profit to report.
REBALANCE = "rebalance"


# ---------------------------------------------------------------- tokens


def token_or_refuse(token: Optional[str]) -> str:
    """The configured API token, or `StartupRefused` when it may not be served.

    Shared by `create_app` and the process wrapper: a blank token is not a
    running engine with unauthenticated routes, it is an engine that refuses to
    start.  Called before anything is opened or written.  The value is taken as
    it was configured — whitespace anywhere in it, or a token short enough to
    guess, is refused rather than trimmed into a different secret.
    """
    text = "" if token is None else str(token)
    if not text:
        raise StartupRefused(MISSING_TOKEN)
    if any(character.isspace() for character in text):
        raise StartupRefused(WHITESPACE_TOKEN)
    if len(text) < MIN_TOKEN_CHARS:
        raise StartupRefused(SHORT_TOKEN)
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


def _no_boolean(value: Any, where: str) -> Any:
    """A JSON number as it arrived, or a refusal when it is `true`/`false`.

    Pydantic would read a boolean as a number for a union field that admits
    `int`, turning `true` into a capital of 1; the check is on the raw body
    value, before that happens.
    """
    if isinstance(value, bool):
        raise ValueError(f"{where} must be a number, not a boolean")
    return value


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

    @field_validator("capital_quote", "capital_base", mode="before")
    @classmethod
    def _not_a_boolean(cls, value: Any, info: ValidationInfo) -> Any:
        return _no_boolean(value, str(info.field_name))


class Recenter(BaseModel):
    """The whole POST /bots/{id}/recenter body: one new center, nothing else."""

    model_config = ConfigDict(extra="forbid")

    center: str | int | float

    @field_validator("center", mode="before")
    @classmethod
    def _not_a_boolean(cls, value: Any, info: ValidationInfo) -> Any:
        return _no_boolean(value, str(info.field_name))


# What a route that re-bases a high-water mark says when it was not acknowledged:
# the write it makes and the body that authorises it.
HALT_CLEAR_ACK = (
    "clearing the halt re-bases the portfolio high-water mark to the current "
    'equity; send {"acknowledge_rebase": true} to acknowledge that and clear it'
)
RESUME_ACK = (
    "resuming re-bases the bot's high-water mark to its current equity; send "
    '{"acknowledge_rebase": true} to acknowledge that and resume it'
)
# What POST /halt/clear says when no product can be priced.
EQUITY_UNKNOWN = (
    "portfolio equity is unknown: a product cannot be priced, so the high-water "
    "mark cannot be re-based and the halt stays"
)


class Acknowledge(BaseModel):
    """The whole body of a route that re-bases a high-water mark: one explicit yes.

    `extra="forbid"` and the validator keep the acknowledgement literal: only a
    JSON `true` clears a halt or resumes a bot, never the string `"true"` and
    never a field this build does not know.
    """

    model_config = ConfigDict(extra="forbid")

    acknowledge_rebase: bool

    @field_validator("acknowledge_rebase", mode="before")
    @classmethod
    def _only_a_boolean(cls, value: Any) -> Any:
        if not isinstance(value, bool):
            raise ValueError("acknowledge_rebase must be true or false")
        return value


def _acknowledged(body: Optional[Acknowledge]) -> bool:
    """True only for a body that says so: no body is not an acknowledgement."""
    return body is not None and body.acknowledge_rebase is True


# ---------------------------------------------------------------- money parsing


def _amount(value: Any, field: str) -> D:
    """A non-negative finite `Decimal` from a JSON string or number.

    A number goes through `Decimal(str(value))`, never `Decimal(float)`, so no
    binary rounding is introduced on the way in.  A boolean is refused instead
    of being read as 1/0, NaN and infinity are refused here because every later
    comparison would answer false for them, and an amount whose leading digit
    sits past `MAX_AMOUNT_EXPONENT` is refused rather than carried into the cap
    and the ledger.
    """
    if isinstance(value, bool):
        raise _invalid(f"{field} must be a number, not a boolean")
    try:
        amount = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        raise _invalid(f"{field} must be a number") from None
    if not amount.is_finite():
        raise _invalid(f"{field} must be a finite number")
    if amount < 0:
        raise _invalid(f"{field} must be >= 0")
    if amount.adjusted() > MAX_AMOUNT_EXPONENT:
        raise _invalid(f"{field} is out of range")
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
        "trade_type": row["trade_type"],
    }


def _write_header(path: Path) -> None:
    """A file with the column header and no row: an empty export is still a table."""
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerow(records.COLUMNS)


def _fills_csv(rows: list[Any]) -> str:
    """The fills as CSV text, written by the one formatter that owns the columns.

    Each row goes through `records.append_fill` into a scratch file, so the web
    export and the on-disk trades file can never disagree about a column's
    formatting.  An empty selection still answers the header line.  The scratch
    file is fresh on every call, so no trade id remembered from an earlier export
    can suppress a row of this one, and its ids are dropped once it is read.
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
        text = path.read_text(encoding="utf-8")
    records.forget(path)
    return text


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
    means, and a garbled file must never read as a fresh one.  A `ts` that is a
    number but not finite comes back as a non-finite age — a stamp this clock
    cannot date, which is not the same thing as an absent one.
    """
    payload = _read_json_file(path)
    if not isinstance(payload, dict):
        return None
    stamp = payload.get("ts")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return None
    try:
        stamp_at = float(stamp)
    except (OverflowError, ValueError):
        return float("nan")
    if not math.isfinite(stamp_at):
        return float("nan")
    return float(at) - stamp_at


def _health_body(ok: bool, age: Optional[float]) -> dict:
    """The whole `/health` body: three keys, and never a balance or a bot."""
    return {"ok": bool(ok), "live_enabled": False, "heartbeat_age_s": age}


# ---------------------------------------------------------------- bot creation


def _check_new_bot(
    store: Store,
    limits: Limits,
    strategies: Mapping[str, Strategy],
    spec_for: Callable[[str], ProductSpec],
    body: BotCreate,
) -> tuple[D, D]:
    """Every refusal a new bot can earn before its capital is priced.

    Nothing is written here and nothing is fetched from the exchange: the caller
    runs this before it opens the transaction that writes the row and its one
    seed, and prices the capital afterwards with `_check_bot_capital`, so a
    refusal anywhere leaves the store exactly as it was.  Returns the parsed
    `(capital_quote, capital_base)`.
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
    return quote, base


def _check_bot_capital(
    limits: Limits,
    product: str,
    quote: D,
    base: D,
    price_for: Callable[[str], D],
) -> None:
    """Refuse capital over the cap, measured in quote terms.

    A base amount is valued at the product's price, which is a read of the
    exchange (or of the last poll's snapshot): it happens here, before the caller
    opens the transaction that writes the bot, so a slow or failing price never
    holds a write lock.  A price the exchange cannot give is a 503, the same
    answer as when the product cannot be priced at all.
    """
    value = quote
    if base > 0:
        try:
            price = price_for(product)
        except Exception as error:  # noqa: BLE001 - the price is the exchange's
            raise _unavailable(f"cannot price {product}: {error}") from None
        value += base * D(price)
    if value > limits.max_bot_capital_usd:
        raise _invalid(
            f"capital {value} is over the {limits.max_bot_capital_usd} USD cap"
        )


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
        if not math.isfinite(age):
            # A stamp that cannot be dated is stale, and the grace does not
            # cover it: only an absent stamp is what the grace is for.
            return JSONResponse(
                status_code=503, content=_health_body(False, None)
            )
        # A stamp too far ahead of this clock refutes it in the same way an old
        # one does, so both ends are a whole poll window.
        ok = -limits.poll_seconds <= age <= window
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

        The whole body runs under the cycle lock.  The check that reads the
        exchange for a price runs before the transaction, so a network call never
        holds a write lock; inside the one immediate transaction that follows,
        the bot row and the simulated money that funds it are written together: a
        failure after the funding rolls both back, so an id is never left
        half-created and a seed is never applied twice.
        """
        with gateway.lock:
            try:
                quote, base = _check_new_bot(
                    store, limits, strategies, spec_for, body
                )
                _check_bot_capital(limits, body.product, quote, base, price_for)
                with store.tx():
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
                log.exception("bot %s: creation failed: %s", body.id, error)
                raise HTTPException(status_code=500, detail=CREATE_FAILED) from None
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
    def resume_bot(bot_id: str, body: Optional[Acknowledge] = None) -> dict:
        """PAUSED -> ACTIVE, re-basing the bot's own high-water mark first.

        A bot paused by its own drawdown stop is resumed against a mark written
        down to its equity as of now, so the same drawdown does not pause it again
        on the next cycle; that is why the request carries an acknowledgement.
        The acknowledgement is checked first, then the status: a STOPPED bot is
        not resumed in P1, it is a conflict.  A book that cannot be priced answers
        503 and leaves the bot paused, since no mark can be written off it.
        """
        if not _acknowledged(body):
            raise _conflict(RESUME_ACK)
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] != PAUSED:
                raise _conflict(f"bot {bot_id} is {bot['status']}, not {PAUSED}")
            product = bot["product"]
            mid = runner._mid(product)
            if mid is None:
                raise _unavailable(
                    f"cannot price {product} for {bot_id}: its equity is unknown, "
                    "so the bot stays paused"
                )
            runner.rebase_hwm(
                bot_id, runner.ledger.equity(bot_id, {product: mid}, product)
            )
            store.set_bot_status(bot_id, ACTIVE)
            bot["status"] = ACTIVE
            return _bot_json(bot)

    @app.post("/bots/{bot_id}/stop", dependencies=guard)
    def stop_bot(bot_id: str) -> Response:
        """Sweep this bot's book off the exchange, then mark it STOPPED.

        The status is written whether or not the sweep went through: reconcile
        sweeps a STOPPED owner's book again, so a bot left stopped is exactly a
        bot whose leftover orders get retried, while a bot left ACTIVE would go
        on placing.  A failing sweep answers 502, with the status already
        written.  A bot that is already stopped is answered, not swept.
        """
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] == STOPPED:
                return _bot_json(bot)
            failure: Optional[BaseException] = None
            try:
                gateway.cancel_all(scope="owner", owner=bot_id)
            except Exception as error:  # noqa: BLE001 - the bot stops regardless
                failure = error
                log.error("bot %s: stop could not sweep the book: %s", bot_id, error)
            store.set_bot_status(bot_id, STOPPED)
            bot["status"] = STOPPED
            if failure is not None:
                return JSONResponse(
                    status_code=502,
                    content={
                        "detail": f"could not cancel {bot_id}'s orders: {failure}"
                    },
                )
            return _bot_json(bot)

    @app.post("/bots/{bot_id}/recenter", dependencies=guard)
    def recenter_bot(bot_id: str, body: Recenter) -> dict:
        """Move a grid bot's center, then let the next cycle lay the new book.

        Only a strategy with a `recenter` (the grid) can be moved: a rebalancer
        has no center to move, so it is refused rather than silently ignored.
        """
        with gateway.lock:
            bot = _require_bot(store, bot_id)
            if bot["status"] == STOPPED:
                raise _conflict(f"bot {bot_id} is {STOPPED}; it cannot be recentered")
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
        that is holding it.  No step of it may stop the ones after it: a halt
        that cannot be persisted, a sweep that fails and a bot whose status
        cannot be written are each remembered and logged, and the sweep and the
        stops happen anyway.  Any remembered failure answers 502 with the
        reasons and `halted` still true: the flag is what refuses every later
        order, and what could be done was done.
        """
        failures: list[str] = []
        try:
            gateway.halt("kill switch")
        except Exception as error:  # noqa: BLE001 - the sweep runs whatever happened
            failures.append(f"the halt flag could not be persisted: {error}")
            log.exception("kill: the halt failed")
        with gateway.lock:
            cancelled = 0
            try:
                cancelled = gateway.cancel_all(scope="all")
            except Exception as error:  # noqa: BLE001 - the bots stop regardless
                failures.append(f"the sweep failed: {error}")
                log.error("kill: the sweep failed: %s", error)
            stopped = _stop_every_bot(store, failures)
        if failures:
            return JSONResponse(
                status_code=502,
                content={"detail": "; ".join(failures), "halted": True},
            )
        return JSONResponse(
            status_code=200,
            content={"halted": True, "cancelled": cancelled, "stopped": stopped},
        )

    @app.post("/halt/clear", dependencies=guard)
    def clear_halt(body: Optional[Acknowledge] = None) -> dict:
        """Clear the halt, re-basing the portfolio mark and re-initialising grids.

        Clearing is an acknowledgement, not a reset: the portfolio high-water mark
        is written down to today's equity, so the same drawdown does not halt the
        engine again on the next cycle; the request has to say so.  Every grid bot
        that is not STOPPED re-initialises its book first, so the engine resumes
        with a live book rather than the one the halt left resting; if one of them
        cannot, nothing is re-based or cleared and the halt stays.  An equity that
        cannot be priced answers 503 and the halt stays with it.  A bot stopped by
        a kill is not restarted by this.
        """
        if not _acknowledged(body):
            raise _conflict(HALT_CLEAR_ACK)
        with gateway.lock:
            equity = gateway.portfolio_equity()
            if equity is None:
                raise _unavailable(EQUITY_UNKNOWN)
            reinitialised: list[str] = []
            for bot in store.list_bots():
                if bot["status"] == STOPPED:
                    continue
                strategy = strategies.get(bot["strategy"])
                if strategy is None or not hasattr(strategy, "recenter"):
                    continue
                try:
                    runner.reinit_bot(bot["id"])
                except Exception as error:  # noqa: BLE001 - the halt stays
                    log.warning(
                        "bot %s: re-init on clear failed: %s", bot["id"], error
                    )
                    raise _bad_gateway(
                        f"could not re-init {bot['id']}: {error}; the halt stays"
                    ) from None
                reinitialised.append(bot["id"])
            runner.rebase_hwm(PORTFOLIO_OWNER, equity)
            gateway.clear_halt()
        return {
            "halted": False,
            "rebased": {PORTFOLIO_OWNER: _text(equity)},
            "reinitialised": reinitialised,
        }

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
        """The authoritative tax export: one row per booked fill, all or one year's.

        Built from the database, so it carries every fill the engine booked; the
        `trades.csv` beside the database is a convenience copy that can in
        principle lag behind it.
        """
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

        A bot's equity is marked at the mid of a snapshot the gateway can price an
        order from (`runner._mid`), so a missing, stale or crossed book leaves its
        equity and its comparison against the benchmark null rather than marked
        off a book nothing could be checked against; the same is true of a bot
        whose benchmark was never started.  `realized` is null for a strategy that
        keeps no cost basis (a rebalancer funds a target mix instead of buying a
        position), and a decimal string otherwise.
        """
        realized = realized_pnl(store)
        benchmark = Benchmark(store)
        entries: dict[str, dict] = {}
        for bot in store.list_bots():
            bot_id = bot["id"]
            product = bot["product"]
            equity: Optional[D] = None
            vs_hold: Optional[D] = None
            mid = runner._mid(product)
            if mid is not None:
                equity = gateway.ledger.equity(bot_id, {product: mid}, product)
                try:
                    vs_hold = benchmark.vs_hold(bot_id, equity, mid)
                except KeyError:
                    vs_hold = None
            gained = (
                None
                if bot["strategy"] == REBALANCE
                else _text(realized.get(bot_id, D(0)))
            )
            entries[bot_id] = {
                "realized": gained,
                "fees": _text(_fee_total(store, bot_id)),
                "equity": None if equity is None else _text(equity),
                "vs_hold": None if vs_hold is None else _text(vs_hold),
            }
        return {"bots": entries}

    return app


def _stop_every_bot(store: Store, failures: list[str]) -> list[str]:
    """Mark every bot STOPPED and answer their ids in the order they are stored.

    One bot whose status cannot be written is logged into *failures* and the
    rest are still stopped: a kill that left half the bots able to place would
    be worse than one that reports the write it could not make.
    """
    stopped: list[str] = []
    for bot in store.list_bots():
        try:
            store.set_bot_status(bot["id"], STOPPED)
        except Exception as error:  # noqa: BLE001 - the next bot is still stopped
            failures.append(f"bot {bot['id']} could not be stopped: {error}")
            log.error("kill: could not stop bot %s: %s", bot["id"], error)
            continue
        stopped.append(bot["id"])
    return stopped