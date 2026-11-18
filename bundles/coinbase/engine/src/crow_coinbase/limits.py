"""Engine limits from the environment, and the windows the order caps read.

`Limits` is the parsed configuration: the twelve values the engine reads at
startup, their defaults and their validation in one table.  Every value is read
from an explicit mapping, never from `os.environ`, so the caller decides what a
process sees.  A missing or blank value means "the default"; an invalid one
raises `ValueError` naming the variable that carried it.  Money stays `Decimal`:
values are parsed with `Decimal(str(...))` and a non-finite number is refused.

`CapWindow` answers the two questions the order caps ask — how much notional was
already placed today (UTC day) and how many orders were placed in the last
rolling hour — by reading the `orders` table.  It counts the orders the engine
actually placed: a row the exchange rejected, or one that never reached it, does
not spend the budget, while a cancelled one does (it rested on the book).  The
state lives in the table rather than in a counter here, so the caps survive a
restart.

A product is an upper-case BASE-QUOTE pair, each side 2-15 characters of A-Z0-9,
and the quote must be USDC or USD: the caps are denominated in USD, so any other
quote would route notional past them.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from .store import FAILED, REJECTED, Store

D = Decimal
ZERO = D(0)
HUNDRED = D(100)

# ---------------------------------------------------------------- env names
ENV_POLL_SECONDS = "CROW_COINBASE_POLL_SECONDS"
ENV_MAKER_FEE_PCT = "CROW_COINBASE_MAKER_FEE_PCT"
ENV_PRODUCTS = "CROW_COINBASE_PRODUCTS"
ENV_DAILY_NOTIONAL_USD = "CROW_COINBASE_DAILY_NOTIONAL_USD"
ENV_ORDERS_PER_HOUR = "CROW_COINBASE_ORDERS_PER_HOUR"
ENV_PORTFOLIO_DRAWDOWN_PCT = "CROW_COINBASE_PORTFOLIO_DRAWDOWN_PCT"
ENV_BOT_MAX_ORDER_USD = "CROW_COINBASE_BOT_MAX_ORDER_USD"
ENV_MAX_BOT_CAPITAL_USD = "CROW_COINBASE_MAX_BOT_CAPITAL_USD"
ENV_AI_MAX_ORDER_USD = "CROW_COINBASE_AI_MAX_ORDER_USD"
ENV_AI_DAILY_NOTIONAL_USD = "CROW_COINBASE_AI_DAILY_NOTIONAL_USD"
ENV_AI_ORDERS_PER_HOUR = "CROW_COINBASE_AI_ORDERS_PER_HOUR"
ENV_WATCHDOG_POLICY = "CROW_COINBASE_WATCHDOG_POLICY"

# ---------------------------------------------------------------- defaults
DEFAULT_POLL_SECONDS = 60
DEFAULT_MAKER_FEE_PCT = D("0.5")
DEFAULT_PRODUCTS = ("BTC-USDC", "ETH-USDC", "XRP-USDC")
DEFAULT_DAILY_NOTIONAL_USD = D("200")
DEFAULT_ORDERS_PER_HOUR = 30
DEFAULT_PORTFOLIO_DRAWDOWN_PCT = D("20")
DEFAULT_BOT_MAX_ORDER_USD = D("50")
DEFAULT_MAX_BOT_CAPITAL_USD = D("100")
DEFAULT_AI_MAX_ORDER_USD = D("25")
DEFAULT_AI_DAILY_NOTIONAL_USD = D("50")
DEFAULT_AI_ORDERS_PER_HOUR = 10
DEFAULT_WATCHDOG_POLICY = "leave"

# what the watchdog may do with a stale heartbeat: alert only, or cancel too
WATCHDOG_POLICIES = ("leave", "cancel")

PRODUCT_SPLIT_RE = re.compile(r"^([A-Z0-9]{2,15})-([A-Z0-9]{2,15})$")

# The quote half of a product must be USD-denominated: the daily cap is a USD
# amount, so a pair quoted in anything else would spend budget it is not
# measured against.
ALLOWED_QUOTES = ("USDC", "USD")


# ---------------------------------------------------------------- value parsing
def _text(env: Mapping[str, str], name: str) -> Optional[str]:
    """The mapping's value for *name* with padding stripped, or None if blank."""
    raw = env.get(name)
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _decimal(name: str, text: str) -> Decimal:
    """A finite Decimal, parsed from its string form (never through float)."""
    try:
        value = D(text)
    except (ArithmeticError, ValueError):
        raise ValueError(f"{name} must be a number, got {text!r}") from None
    if not value.is_finite():
        raise ValueError(f"{name} must be a finite number, got {text!r}")
    return value


def _money(name: str, text: str) -> Decimal:
    """A strictly positive amount of money."""
    value = _decimal(name, text)
    if value <= ZERO:
        raise ValueError(f"{name} must be greater than 0, got {text!r}")
    return value


def _pct(
    name: str,
    text: str,
    low: Decimal,
    high: Decimal,
    *,
    low_inclusive: bool = True,
    high_inclusive: bool = True,
) -> Decimal:
    """A percentage inside the given range; inclusive unless told otherwise."""
    value = _decimal(name, text)
    above_low = value >= low if low_inclusive else value > low
    below_high = value <= high if high_inclusive else value < high
    if not (above_low and below_high):
        bounds = (
            "[" if low_inclusive else "(",
            "]" if high_inclusive else ")",
        )
        raise ValueError(
            f"{name} must be a percentage within "
            f"{bounds[0]}{low}, {high}{bounds[1]}, got {text!r}"
        )
    return value


def _fee_pct(name: str, text: str) -> Decimal:
    """A maker fee percent: 0 is free, 100 is refused."""
    return _pct(name, text, ZERO, HUNDRED, high_inclusive=False)


def _drawdown_pct(name: str, text: str) -> Decimal:
    """A drawdown threshold: some drawdown must be possible to trip it."""
    return _pct(name, text, ZERO, HUNDRED, low_inclusive=False)


def _positive_int(name: str, text: str) -> int:
    """A whole number of at least 1."""
    try:
        value = int(text)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a whole number, got {text!r}") from None
    if value <= 0:
        raise ValueError(f"{name} must be greater than 0, got {text!r}")
    return value


def _products(name: str, text: str) -> tuple[str, ...]:
    """A comma-separated product list, order kept, padding stripped.

    Each entry is an upper-case BASE-QUOTE pair — each side 2-15 characters of
    A-Z0-9 — whose quote is USDC or USD, because the caps are USD amounts and a
    pair quoted in another currency would slip past them.
    """
    parts = [part.strip() for part in text.split(",")]
    if any(not part for part in parts):
        raise ValueError(
            f"{name} must be a comma-separated list of products, got {text!r}"
        )
    quotes = " or ".join(ALLOWED_QUOTES)
    for part in parts:
        match = PRODUCT_SPLIT_RE.match(part)
        if match is None or match.group(2) not in ALLOWED_QUOTES:
            raise ValueError(
                f"{name} has an invalid product {part!r}; expected an upper-case "
                f"BASE-QUOTE pair quoted in {quotes} such as BTC-USDC, with each "
                f"side 2-15 characters of A-Z0-9"
            )
    if len(set(parts)) != len(parts):
        raise ValueError(f"{name} lists the same product more than once: {text!r}")
    return tuple(parts)


def _policy(name: str, text: str) -> str:
    """One of the known watchdog policies."""
    if text not in WATCHDOG_POLICIES:
        raise ValueError(
            f"{name} must be one of {', '.join(WATCHDOG_POLICIES)}, got {text!r}"
        )
    return text


# field name, env name, default, parser — one row per value, in the order the
# engine reads them.  `from_env` walks this table and nothing else.
_SPECS: tuple[tuple[str, str, Any, Callable[[str, str], Any]], ...] = (
    ("poll_seconds", ENV_POLL_SECONDS, DEFAULT_POLL_SECONDS, _positive_int),
    ("maker_fee_pct", ENV_MAKER_FEE_PCT, DEFAULT_MAKER_FEE_PCT, _fee_pct),
    ("products", ENV_PRODUCTS, DEFAULT_PRODUCTS, _products),
    ("daily_notional_usd", ENV_DAILY_NOTIONAL_USD, DEFAULT_DAILY_NOTIONAL_USD, _money),
    ("orders_per_hour", ENV_ORDERS_PER_HOUR, DEFAULT_ORDERS_PER_HOUR, _positive_int),
    (
        "portfolio_drawdown_pct",
        ENV_PORTFOLIO_DRAWDOWN_PCT,
        DEFAULT_PORTFOLIO_DRAWDOWN_PCT,
        _drawdown_pct,
    ),
    ("bot_max_order_usd", ENV_BOT_MAX_ORDER_USD, DEFAULT_BOT_MAX_ORDER_USD, _money),
    (
        "max_bot_capital_usd",
        ENV_MAX_BOT_CAPITAL_USD,
        DEFAULT_MAX_BOT_CAPITAL_USD,
        _money,
    ),
    ("ai_max_order_usd", ENV_AI_MAX_ORDER_USD, DEFAULT_AI_MAX_ORDER_USD, _money),
    (
        "ai_daily_notional_usd",
        ENV_AI_DAILY_NOTIONAL_USD,
        DEFAULT_AI_DAILY_NOTIONAL_USD,
        _money,
    ),
    (
        "ai_orders_per_hour",
        ENV_AI_ORDERS_PER_HOUR,
        DEFAULT_AI_ORDERS_PER_HOUR,
        _positive_int,
    ),
    ("watchdog_policy", ENV_WATCHDOG_POLICY, DEFAULT_WATCHDOG_POLICY, _policy),
)


@dataclass(frozen=True)
class Limits:
    """The engine's configured bounds. Frozen: parsed once, then read-only."""

    poll_seconds: int = DEFAULT_POLL_SECONDS
    maker_fee_pct: Decimal = DEFAULT_MAKER_FEE_PCT
    products: tuple[str, ...] = DEFAULT_PRODUCTS
    daily_notional_usd: Decimal = DEFAULT_DAILY_NOTIONAL_USD
    orders_per_hour: int = DEFAULT_ORDERS_PER_HOUR
    portfolio_drawdown_pct: Decimal = DEFAULT_PORTFOLIO_DRAWDOWN_PCT
    bot_max_order_usd: Decimal = DEFAULT_BOT_MAX_ORDER_USD
    max_bot_capital_usd: Decimal = DEFAULT_MAX_BOT_CAPITAL_USD
    ai_max_order_usd: Decimal = DEFAULT_AI_MAX_ORDER_USD
    ai_daily_notional_usd: Decimal = DEFAULT_AI_DAILY_NOTIONAL_USD
    ai_orders_per_hour: int = DEFAULT_AI_ORDERS_PER_HOUR
    watchdog_policy: str = DEFAULT_WATCHDOG_POLICY

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Limits":
        """Parse *env* into Limits. Only *env* is read; blank means the default."""
        values: dict[str, Any] = {}
        for field_name, name, default, parse in _SPECS:
            text = _text(env, name)
            values[field_name] = default if text is None else parse(name, text)
        return cls(**values)


# ---------------------------------------------------------------- cap windows
HOUR_SECONDS = 3600.0

# An order the exchange refused, or one that never reached it, spent nothing.
EXCLUDED_STATUSES = (REJECTED, FAILED)


class CapWindow:
    """The two order caps, read from the `orders` table on every call.

    It holds no counters: the rows are the state, so a restart (or a second
    process) sees exactly the same budget.  `now` is injected so a caller can
    move the clock.

    What a row spends: a CANCELLED order counts.  It was accepted and rested on
    the book, and counting it blocks cap-gaming by placing then cancelling.  An
    order that partially filled and was then cancelled counts its FULL submitted
    size (`price * size`), not just the filled part.  Only REJECTED (a post-only
    refusal) and FAILED (never reached the exchange) are excluded.  A row whose
    status is NULL counts too.
    """

    def __init__(self, store: Store, now: Callable[[], float]):
        self.store = store
        self.now = now

    # ------------------------------------------------ public API
    def daily_notional(self, source: Optional[str] = None) -> Decimal:
        """Notional placed since this UTC day's midnight.

        Only the lower bound is applied, so a row dated after the clock counts
        too: a future-dated row can never buy budget (fail closed).  `price` and
        `size` are TEXT, so the sum is taken in Decimal, never in float.  A
        source of None counts every row.
        """
        start = self._utc_day_start()
        rows = self._fetch(
            "price, size",
            "created_at >= ?",
            (start,),
            source,
        )
        priced = (D(row["price"] or "0") * D(row["size"] or "0") for row in rows)
        return sum(priced, D(0))

    def orders_last_hour(self, source: Optional[str] = None) -> int:
        """How many orders were placed in the rolling hour before `now()`.

        The window is relative to the clock, not to the clock hour: anything
        strictly newer than `now() - 3600` counts.
        """
        cutoff = self.now() - HOUR_SECONDS
        rows = self._fetch(
            "COUNT(*) AS placed",
            "created_at > ?",
            (cutoff,),
            source,
        )
        row = rows.fetchone()
        return int(row["placed"]) if row is not None else 0

    # ------------------------------------------------ internals
    def _utc_day_start(self) -> float:
        """The epoch seconds of this UTC day's midnight, and nothing beyond it."""
        day = datetime.fromtimestamp(self.now(), timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return day.timestamp()

    def _fetch(
        self,
        columns: str,
        where: str,
        args: tuple,
        source: Optional[str],
    ) -> sqlite3.Cursor:
        """Run one read over the counted rows; every value is a bound parameter.

        `COALESCE(status, '')` makes a row with a NULL status count: an unknown
        status must never look like an excluded one (fail closed).
        """
        marks = ",".join("?" * len(EXCLUDED_STATUSES))
        sql = (
            f"SELECT {columns} FROM orders "
            f"WHERE {where} AND COALESCE(status, '') NOT IN ({marks})"
        )
        params: list[Any] = list(args) + list(EXCLUDED_STATUSES)
        if source is not None:
            sql += " AND source = ?"
            params.append(source)
        return self.store.conn().execute(sql, params)