"""grid.py: the level grid strategy, decided from a hand-built view.

The strategy keeps no levels and no order book of its own: levels are always
re-derived from its params with `money.build_levels`, the initial book is
`money.plan_initial`, and every opposite order is `money.opposite_order`.  This
module reads a `BotView` / `MarketSnapshot` and answers a `Decision`; it places
nothing, cancels nothing and never touches a store, so it stays pure and a tick
can be replayed.

Params arrive from JSON, so any number may be a str, an int, a float or a
Decimal; every one of them is read through `_dec` (`Decimal(str(x))`) and a
value that will not parse is a `ValueError`, never a `decimal.InvalidOperation`.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from .. import money
from ..money import ProductSpec
from .base import BotView, Decision, MarketSnapshot, OrderIntent

D = Decimal

# Rebuy sizing after a sell: the USDC the sell produced, or a fixed budget.
REBUY_PROCEEDS = "proceeds"
REBUY_FIXED = "fixed"
REBUY_SIZINGS = (REBUY_PROCEEDS, REBUY_FIXED)

# An order in one of these statuses still holds its level (it may yet land).
LIVE_STATUSES = ("PENDING_SUBMIT", "OPEN")

# The pause reason for a poll window that carries no low/high at all.
NO_RANGE_DATA = "no range data"

# The only sides a fill row may carry.
FILL_SIDES = (money.BUY, money.SELL)

_REQUIRED = (
    "center",
    "step_pct",
    "levels_below",
    "levels_above",
    "quote_per_buy",
    "rebuy_sizing",
)


# ---------------------------------------------------------------- parsing


def _dec(value, field: str) -> D:
    """`Decimal(str(value))` with a `ValueError` instead of a decimal error."""
    if isinstance(value, Decimal):
        out = value
        if not out.is_finite():
            raise ValueError(f"{field} must be a finite number, got {value!r}")
        return out
    try:
        out = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        raise ValueError(f"{field} must be a number, got {value!r}") from None
    if not out.is_finite():
        raise ValueError(f"{field} must be a finite number, got {value!r}")
    return out


def _dec_or_none(value) -> Optional[D]:
    """Best-effort read of a column that may be absent or malformed."""
    if value is None:
        return None
    try:
        out = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return None
    return out if out.is_finite() else None


def _count(value, field: str) -> int:
    """A whole count (levels below/above): `3`, `3.0` and `"3"` all mean three,
    while a fractional value is refused instead of quietly truncated."""
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a whole number, got {value!r}")
    try:
        out = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        raise ValueError(f"{field} must be a whole number, got {value!r}") from None
    if not out.is_finite() or out != out.to_integral_value():
        raise ValueError(f"{field} must be a whole number, got {value!r}")
    return int(out)


def _num(value: D) -> str:
    """A Decimal in plain notation, for a human-readable reason string."""
    return format(D(value).normalize(), "f")


def _parse(params: dict) -> dict:
    """The params as Decimals/ints, or a `ValueError` naming the bad one.

    Unknown keys are ignored, so a params dict may carry a run's own bookkeeping
    without the strategy refusing it.
    """
    raw = params if isinstance(params, dict) else {}
    missing = [name for name in _REQUIRED if name not in raw]
    if missing:
        raise ValueError("grid params missing: " + ", ".join(missing))

    center = _dec(raw["center"], "center")
    if center <= 0:
        raise ValueError(f"center must be > 0, got {_num(center)}")

    step_pct = _dec(raw["step_pct"], "step_pct")
    if step_pct <= 0:
        raise ValueError(f"step_pct must be > 0, got {_num(step_pct)}")

    quote_per_buy = _dec(raw["quote_per_buy"], "quote_per_buy")
    if quote_per_buy <= 0:
        raise ValueError(f"quote_per_buy must be > 0, got {_num(quote_per_buy)}")

    below = _count(raw["levels_below"], "levels_below")
    if below < 1:
        raise ValueError(f"levels_below must be >= 1, got {below}")
    above = _count(raw["levels_above"], "levels_above")
    if above < 1:
        raise ValueError(f"levels_above must be >= 1, got {above}")

    rebuy_sizing = str(raw["rebuy_sizing"]).strip().lower()
    if rebuy_sizing not in REBUY_SIZINGS:
        raise ValueError(
            f"rebuy_sizing must be one of {', '.join(REBUY_SIZINGS)}, "
            f"got {raw['rebuy_sizing']!r}"
        )

    return {
        "center": center,
        "step_pct": step_pct,
        "levels_below": below,
        "levels_above": above,
        "quote_per_buy": quote_per_buy,
        "rebuy_sizing": rebuy_sizing,
    }


def _levels(p: dict, spec: ProductSpec) -> dict[int, D]:
    return money.build_levels(
        p["center"], p["step_pct"], p["levels_below"], p["levels_above"], spec
    )


# ---------------------------------------------------------------- fill rows


def _fill_id(row: dict) -> Optional[str]:
    """The id that retires this fill: always its `client_order_id`.

    A row with no client order id (missing, None or empty) has no id anything
    could retire, so it yields None and is ignored.
    """
    cid = row.get("client_order_id")
    if cid is None:
        return None
    cid = str(cid)
    return cid or None


def _row_level(row: dict) -> Optional[int]:
    value = row.get("level")
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _occupied_levels(open_orders: list[dict]) -> set[int]:
    """The levels a resting (or possibly-landing) order already holds."""
    held: set[int] = set()
    for row in open_orders or ():
        if str(row.get("status") or "").upper() not in LIVE_STATUSES:
            continue
        level = _row_level(row)
        if level is not None:
            held.add(level)
    return held


# ---------------------------------------------------------------- the strategy


class GridStrategy:
    """A geometric level grid: buys below the center, sells above it.

    `init_intents` lays down the first book, `decide` answers the fills that
    book produced, and a poll window leaving the range pauses everything.
    """

    name = "grid"

    # ------------------------------------------------ params
    def validate(self, params: dict, spec: Optional[ProductSpec] = None) -> None:
        """Raise `ValueError` unless *params* can build a grid.

        With a *spec* the levels are also built against the product's price
        tick, so a step that collapses the levels is refused here rather than
        mid-tick.
        """
        p = _parse(params)
        if spec is None:
            return
        try:
            _levels(p, spec)
        except ValueError as exc:
            raise ValueError(
                f"grid params do not fit {spec.product_id}: {exc}"
            ) from None

    def fee_guard(self, params: dict, maker_fee_pct: D) -> Optional[str]:
        """Why this step cannot pay the maker fee twice, or None when it can."""
        step_pct = _dec((params or {}).get("step_pct"), "step_pct")
        maker = _dec(maker_fee_pct, "maker_fee_pct")
        ok, required = money.fee_guard(step_pct, maker)
        if ok:
            return None
        margin = required - 2 * maker
        return (
            f"step {_num(step_pct)}% is below the required minimum "
            f"{_num(required)}% (2 x maker fee {_num(maker)}% + "
            f"{_num(margin)}% margin)"
        )

    def recenter(self, params: dict, new_center: D) -> dict:
        """A copy of *params* centered on *new_center*; the input is left alone."""
        center = _dec(new_center, "center")
        if center <= 0:
            raise ValueError(f"center must be > 0, got {_num(center)}")
        out = dict(params or {})
        out["center"] = str(center)
        return out

    # ------------------------------------------------ first book
    def init_intents(self, snap: MarketSnapshot, view: BotView) -> Decision:
        """The initial grid: buys nearest-first from the quote budget, sells from
        the base allocation.  A level the sizing cannot fund is simply left out."""
        p = _parse(view.params)
        lv = _levels(p, view.spec)

        # The first book is laid down around the top of book, so it only makes
        # sense while that mid sits inside the grid's own band.
        mid = (D(snap.bid) + D(snap.ask)) / 2
        why = money.out_of_range(mid, mid, money.range_bounds(lv, p["step_pct"]))
        if why:
            return Decision([], pause_reason=why)

        planned, _skipped = money.plan_initial(
            lv,
            p["quote_per_buy"],
            usdc_budget=view.holding.available_quote,
            xrp_allocation=view.holding.available_base,
            xrp_per_sell=None,
            fee_rate=view.fee_rate,
            spec=view.spec,
        )
        intents = [
            OrderIntent(
                action="place",
                side=order.side,
                size=order.size,
                limit_price=order.price,
                level=order.level,
                cancel_cid=None,
                reason=f"init L{order.level}",
            )
            for order in planned
        ]
        return Decision(intents)

    # ------------------------------------------------ one tick
    def decide(self, snap: MarketSnapshot, view: BotView) -> Decision:
        """One tick: a range exit pauses, otherwise each fill gets its opposite."""
        p = _parse(view.params)
        lv = _levels(p, view.spec)

        # 1. Without a poll window there is no telling whether the price left
        #    the grid, so nothing is placed blind.
        if snap.low is None or snap.high is None:
            return Decision([], pause_reason=NO_RANGE_DATA)

        #    A poll window outside the band pauses the whole bot: nothing is
        #    placed for any fill, so the book is left exactly as it is.
        why = money.out_of_range(
            snap.low, snap.high, money.range_bounds(lv, p["step_pct"])
        )
        if why:
            return Decision([], pause_reason=why)

        # 2. Every fill still awaiting its opposite order, in the order given.
        held = _occupied_levels(view.open_orders)
        claimed: set[int] = set()
        intents: list[OrderIntent] = []
        skipped: list[str] = []

        for row in view.pending_fills or ():
            # Only a client order id can retire a fill: a row without one is
            # left alone, there is nothing to retire.
            fill_id = _fill_id(row)
            if fill_id is None:
                continue

            side = str(row.get("side") or "").strip().upper()
            if side not in FILL_SIDES:
                skipped.append(fill_id)
                continue

            level = _row_level(row)
            size = _dec_or_none(row.get("filled_size"))
            value = _dec_or_none(row.get("filled_value"))
            fees = _dec_or_none(row.get("fees"))
            if level is None or size is None or value is None:
                skipped.append(fill_id)
                continue

            plan, _why = money.opposite_order(
                side,
                level,
                size,
                value - (D(0) if fees is None else fees),
                lv,
                view.fee_rate,
                view.spec,
                p["rebuy_sizing"],
                p["quote_per_buy"],
            )
            if plan is None:
                # Off the grid, or too small to be worth an order: retire it.
                skipped.append(fill_id)
                continue

            if plan.level in held or plan.level in claimed:
                # Don't stack: the fill stays pending and is retried next cycle.
                continue

            claimed.add(plan.level)
            intents.append(
                OrderIntent(
                    action="place",
                    side=plan.side,
                    size=plan.size,
                    limit_price=plan.price,
                    level=plan.level,
                    cancel_cid=None,
                    reason=f"opposite of {fill_id}",
                    consumes_fill=fill_id,
                )
            )

        return Decision(intents, skipped_fills=skipped)