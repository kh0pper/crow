"""rebalance.py: the weight-band rebalancer, decided from a hand-built view.

A rebalancer holds a fixed split between base and quote instead of a ladder of
levels.  It reads the account's weight, and when that weight has drifted
further than `band_pts` from `target_base_pct` it answers a single post-only
order sized to land on the target after the fill, the maker fee included.  It
keeps no book of its own: every answer is derived from the `BotView` and the
`MarketSnapshot`, nothing here places or cancels or stores anything, so a tick
can be replayed.

The weight is read from the holding's TOTALS (`base` and `quote`), never from
the available figures.  A resting order only reserves funds, so `reserved_*`
rises and `available_*` falls while the totals stay put; a weight taken from the
available figures would jump the moment our own rebalance order rested and the
strategy would chase itself.  Sizing is the other way round: what an order may
commit is capped by the AVAILABLE funds — `available_quote` for a buy
(inclusive of the maker fee), `available_base` for a sell — because that is what
the exchange lets it hold.  A stale resting order is cancelled on its own: a
decision that cancels never places, and the replacement is a later tick's
answer, once the cancellation has freed what the order held.

Params arrive from JSON, so any number may be a str, an int, a float or a
Decimal; each is read through `_dec` (`Decimal(str(x))`), a value that will not
parse is a `ValueError`, never a `decimal.InvalidOperation`, and a bool is
refused because `True` is not a number here.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from .. import money
from ..money import ProductSpec
from .base import BotView, Decision, MarketSnapshot, OrderIntent

D = Decimal
ONE = D(1)
HUNDRED = D(100)
ZERO = D(0)

# An order in one of these statuses still holds funds (it may yet land).
LIVE_STATUSES = ("PENDING_SUBMIT", "OPEN")

# Only an order that is on the book can be taken off it; one that may still land
# cannot.
OPEN_STATUS = "OPEN"

# The pause reason for a top of book that cannot be traded against.
NO_BOOK = "no usable book"

BUY = money.BUY
SELL = money.SELL

# The params, and what they mean without one.
DEFAULT_TARGET_PCT = D("50")
DEFAULT_BAND_PTS = D("7.5")
DEFAULT_MIN_TRADE_QUOTE = D("2")
DEFAULT_REPRICE_AFTER_S = D("600")

# The band is bounded: a tighter one would trade on noise, a wider one would
# never trade at all.
BAND_MIN_PTS = D("5")
BAND_MAX_PTS = D("10")


# ---------------------------------------------------------------- parsing


def _dec(value, field: str) -> D:
    """`Decimal(str(value))` with a `ValueError` instead of a decimal error."""
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number, got {value!r}")
    if isinstance(value, Decimal):
        out = value
    else:
        try:
            out = D(str(value))
        except (ArithmeticError, ValueError, TypeError):
            raise ValueError(f"{field} must be a number, got {value!r}") from None
    if not out.is_finite():
        raise ValueError(f"{field} must be a finite number, got {value!r}")
    return out


def _dec_or_none(value) -> Optional[D]:
    """Best-effort read of a column that may be absent or malformed."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = D(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return None
    return out if out.is_finite() else None


def _num(value: D) -> str:
    """A Decimal in plain notation, for a human-readable reason string."""
    return format(D(value).normalize(), "f")


def _pct(weight: D) -> D:
    """A weight as a percentage, rounded to a tenth for a reason string."""
    return (D(weight) * HUNDRED).quantize(D("0.1"), rounding=ROUND_HALF_UP)


def _parse(params: dict) -> dict:
    """The params as Decimals, or a `ValueError` naming the bad one.

    Unknown keys are ignored, so a params dict may carry a run's own bookkeeping
    without the strategy refusing it.
    """
    raw = params if isinstance(params, dict) else {}

    target = _dec(
        raw.get("target_base_pct", DEFAULT_TARGET_PCT), "target_base_pct"
    )
    if not ZERO < target < HUNDRED:
        raise ValueError(f"target_base_pct must be > 0 and < 100, got {_num(target)}")

    band = _dec(raw.get("band_pts", DEFAULT_BAND_PTS), "band_pts")
    if not BAND_MIN_PTS <= band <= BAND_MAX_PTS:
        raise ValueError(
            f"band_pts must be between {_num(BAND_MIN_PTS)} and "
            f"{_num(BAND_MAX_PTS)}, got {_num(band)}"
        )

    min_trade = _dec(
        raw.get("min_trade_quote", DEFAULT_MIN_TRADE_QUOTE), "min_trade_quote"
    )
    if min_trade <= 0:
        raise ValueError(f"min_trade_quote must be > 0, got {_num(min_trade)}")

    reprice = _dec(
        raw.get("reprice_after_s", DEFAULT_REPRICE_AFTER_S), "reprice_after_s"
    )
    if reprice <= 0:
        raise ValueError(f"reprice_after_s must be > 0, got {_num(reprice)}")

    return {
        "target_base_pct": target,
        "band_pts": band,
        "min_trade_quote": min_trade,
        "reprice_after_s": reprice,
    }


# ---------------------------------------------------------------- rows


def _fill_id(row: dict) -> Optional[str]:
    """The id that retires this fill: always its `client_order_id`.

    A row with no client order id (missing, None or empty) has no id anything
    could retire, so it yields None.
    """
    cid = row.get("client_order_id")
    if cid is None:
        return None
    cid = str(cid)
    return cid or None


def _row_status(row: dict) -> str:
    return str(row.get("status") or "").strip().upper()


def _row_side(row: dict) -> str:
    return str(row.get("side") or "").strip().upper()


def _live_rows(open_orders) -> list[dict]:
    """The rows that still hold funds: they may yet land, or already rest."""
    return [row for row in (open_orders or ()) if _row_status(row) in LIVE_STATUSES]


def _is_stale(row: dict, now: D, after: D) -> bool:
    """True for a resting order older than the reprice age.

    The age is read from `created_at`, falling back to `updated_at` when that
    column is missing, None or unparseable.  A row with no usable age at all
    cannot be shown to be young, so a resting one counts as stale.  A row that
    may still land (`PENDING_SUBMIT`) is never re-priced, whatever its age.
    """
    if _row_status(row) != OPEN_STATUS:
        return False
    age_from = _dec_or_none(row.get("created_at"))
    if age_from is None:
        age_from = _dec_or_none(row.get("updated_at"))
    if age_from is None:
        return True
    return now - age_from > after


def _skipped_fills(pending_fills) -> list[str]:
    """Every fill id the runner should retire, in the order given, once each.

    A rebalancer never follows a fill up with an order of its own: the next
    tick's weight already includes what the fill did, so the fill is retired
    rather than answered.  A row without an id is ignored.
    """
    out: list[str] = []
    seen: set[str] = set()
    for row in pending_fills or ():
        cid = _fill_id(row)
        if cid is None or cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
    return out


# ---------------------------------------------------------------- the book


def _read_book(snap: MarketSnapshot) -> tuple[Optional[tuple[D, D]], Optional[str]]:
    """`((bid, ask), None)`, or `(None, why the book cannot be traded)`."""
    bid = _dec_or_none(snap.bid)
    ask = _dec_or_none(snap.ask)
    if bid is None or ask is None:
        return None, (
            f"{NO_BOOK}: bid is {'missing' if bid is None else _num(bid)}, "
            f"ask is {'missing' if ask is None else _num(ask)}"
        )
    if bid <= 0 or ask <= 0:
        return None, f"{NO_BOOK}: bid {_num(bid)}, ask {_num(ask)} are not positive"
    if bid >= ask:
        return None, f"{NO_BOOK}: bid {_num(bid)} is not below ask {_num(ask)}"
    return (bid, ask), None


# ---------------------------------------------------------------- sizing


def _size_for_target(
    base: D,
    quote: D,
    mid: D,
    target_pct: D,
    side: str,
    price: D,
    fee_rate: D,
    spec: ProductSpec,
) -> Optional[D]:
    """The base size whose fill at *price* lands the weight on the target.

    Solved on the post-fill balances at *mid*: a buy raises base and spends
    `price*(1+fee)` per unit, a sell lowers base and gains `price*(1-fee)`.
    Rounded down to the base increment; None when the equation has no positive
    answer.
    """
    t = D(target_pct) / HUNDRED
    value = base * mid + quote
    if side == BUY:
        c = price * (ONE + fee_rate) - mid
        denominator = mid + t * c
        numerator = t * value - base * mid
    else:
        c = mid - price * (ONE - fee_rate)
        denominator = mid - t * c
        numerator = base * mid - t * value
    if denominator <= 0 or numerator <= 0:
        return None
    return money.floor_to(numerator / denominator, spec.base_increment)


def _cap_by_available(
    size: D, side: str, budget: D, price: D, fee_rate: D, spec: ProductSpec
) -> D:
    """The size an order may actually commit out of *budget*.

    A buy is capped so that its cost *including* the maker fee fits in the
    quote budget; a sell is capped by the base budget alone.
    """
    if side == BUY:
        affordable = money.buy_size_for_quote(budget, price, fee_rate, spec)
    else:
        affordable = money.floor_to(budget, spec.base_increment)
    return min(size, affordable)


# ---------------------------------------------------------------- intents


def _cancel_intent(cid: str, row: dict, after: D) -> OrderIntent:
    side = _row_side(row) or "resting"
    return OrderIntent(
        action="cancel",
        side=None,
        size=None,
        limit_price=None,
        level=None,
        cancel_cid=cid,
        reason=f"rebalance: {side} order not filled in {_num(after)}s",
    )


def _place_intent(
    base: D,
    quote: D,
    mid: D,
    bid: D,
    ask: D,
    p: dict,
    available_quote: D,
    available_base: D,
    fee_rate: D,
    spec: ProductSpec,
) -> Optional[OrderIntent]:
    """The one order that would put the weight back on target, or None.

    None covers every reason not to trade: the weight is inside the band, the
    account holds nothing to value, the sized trade is below the product's own
    minimums, or it is worth less than `min_trade_quote`.
    """
    target = p["target_base_pct"]
    value = base * mid + quote
    if value <= 0:
        return None

    weight = base * mid / value
    drift = weight * HUNDRED - target
    if abs(drift) <= p["band_pts"]:
        return None

    if drift > 0:
        side = SELL
        # Ask side: at the ask, never at or below the bid.
        price = money.maker_price(SELL, ask, bid, ask, spec.price_increment)
        budget = available_base
    else:
        side = BUY
        # Bid side: at the bid, never above it and never at or above the ask.
        price = money.maker_price(BUY, bid, bid, ask, spec.price_increment)
        budget = available_quote
    if price <= 0:
        return None

    size = _size_for_target(base, quote, mid, target, side, price, fee_rate, spec)
    if size is None:
        return None
    size = _cap_by_available(size, side, budget, price, fee_rate, spec)
    if size <= 0:
        return None

    if money.too_small(size, price, spec) is not None:
        return None
    if size * price < p["min_trade_quote"]:
        return None

    return OrderIntent(
        action="place",
        side=side,
        size=size,
        limit_price=price,
        level=None,
        cancel_cid=None,
        reason=(
            f"rebalance {side} to {_num(target)}% "
            f"(weight {_num(_pct(weight))}%)"
        ),
    )


# ---------------------------------------------------------------- the strategy


class RebalanceStrategy:
    """Hold a target base/quote weight, trading only when it drifts out of band.

    One order at a time: while any order is live the weight is that order's
    business, and only resting orders that have all gone stale are taken off the
    book — alone, with no replacement in the same decision.  The weight is read
    from the totals; sizing is capped by the available funds, so the replacement
    lands on a later tick, once the cancellations have freed what those orders
    held.
    """

    name = "rebalance"

    # ------------------------------------------------ params
    def validate(self, params: dict, spec: Optional[ProductSpec] = None) -> None:
        """Raise `ValueError` unless *params* can drive a rebalancer.

        A *spec* is accepted and unused: the weight bands are product-agnostic,
        and sizing against a spec happens per tick.
        """
        _parse(params)

    def fee_guard(self, params: dict, maker_fee_pct: D) -> Optional[str]:
        """None: a rebalancer turns over so little that the maker fee is moot."""
        return None

    # ------------------------------------------------ first book
    def init_intents(self, snap: MarketSnapshot, view: BotView) -> Decision:
        """A rebalancer has no initial book: its first tick is its first answer."""
        return self.decide(snap, view)

    # ------------------------------------------------ one tick
    def decide(self, snap: MarketSnapshot, view: BotView) -> Decision:
        """One tick: pause without a book, else cancel stale orders or trade once."""
        p = _parse(view.params)

        book, why = _read_book(snap)
        if book is None:
            # Nothing may be placed against a book that cannot be traded, and a
            # pending fill is the next tick's business.
            return Decision([], pause_reason=why)
        bid, ask = book
        mid = (bid + ask) / 2

        held = view.holding
        base, quote = D(held.base), D(held.quote)
        fee_rate = D(view.fee_rate)
        skipped = _skipped_fills(view.pending_fills)

        live = _live_rows(view.open_orders)
        if live:
            now = _dec(view.now, "now")
            if not all(
                _is_stale(row, now, p["reprice_after_s"]) for row in live
            ):
                # A young order, or one that may still land, already handles the
                # weight: stacking a second order on top would double the trade.
                return Decision([], skipped_fills=skipped)

            cids = [_fill_id(row) for row in live]
            if any(cid is None for cid in cids):
                # An order with no id cannot be taken off the book, so it is
                # left to settle rather than replaced blindly.
                return Decision([], skipped_fills=skipped)

            # Stale orders are cancelled alone.  The replacement is a later
            # tick's answer, after reconcile has freed what they held, so the
            # free funds it sizes against are real rather than assumed.
            return Decision(
                [
                    _cancel_intent(cid, row, p["reprice_after_s"])
                    for cid, row in zip(cids, live)
                ],
                skipped_fills=skipped,
            )

        place = _place_intent(
            base,
            quote,
            mid,
            bid,
            ask,
            p,
            D(held.available_quote),
            D(held.available_base),
            fee_rate,
            view.spec,
        )
        if place is None:
            return Decision([], skipped_fills=skipped)

        return Decision([place], skipped_fills=skipped)