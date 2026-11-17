"""Pure grid math. No I/O, no network: everything here is unit-tested.

All money/size values are Decimal. Levels are integers: 0 is the center,
negative levels sit below it (buys), positive levels above it (sells).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal
from typing import Optional

D = Decimal
ONE = D(1)
HUNDRED = D(100)

BUY = "BUY"
SELL = "SELL"


@dataclass(frozen=True)
class ProductSpec:
    product_id: str
    price_increment: Decimal
    base_increment: Decimal
    quote_increment: Decimal
    base_min_size: Decimal
    quote_min_size: Decimal

    @classmethod
    def from_api(cls, p: dict) -> "ProductSpec":
        return cls(
            product_id=p["product_id"],
            price_increment=D(str(p["price_increment"])),
            base_increment=D(str(p["base_increment"])),
            quote_increment=D(str(p["quote_increment"])),
            base_min_size=D(str(p["base_min_size"])),
            quote_min_size=D(str(p["quote_min_size"])),
        )


# ---------------------------------------------------------------- rounding


def floor_to(x: Decimal, inc: Decimal) -> Decimal:
    return (x / inc).to_integral_value(rounding=ROUND_DOWN) * inc


def ceil_to(x: Decimal, inc: Decimal) -> Decimal:
    return (x / inc).to_integral_value(rounding=ROUND_UP) * inc


def round_to(x: Decimal, inc: Decimal) -> Decimal:
    return (x / inc).to_integral_value(rounding=ROUND_HALF_UP) * inc


# ---------------------------------------------------------------- fees / guard


def required_step_pct(
    maker_fee_pct: Decimal, margin_pct: Decimal = D("0.5")
) -> Decimal:
    """Minimum step: a round trip pays the maker fee twice, plus a safety margin."""
    return 2 * D(maker_fee_pct) + D(margin_pct)


def fee_guard(
    step_pct: Decimal, maker_fee_pct: Decimal, margin_pct: Decimal = D("0.5")
) -> tuple[bool, Decimal]:
    req = required_step_pct(maker_fee_pct, margin_pct)
    return D(step_pct) >= req, req


# ---------------------------------------------------------------- levels


def build_levels(
    center: Decimal, step_pct: Decimal, below: int, above: int, spec: ProductSpec
) -> dict[int, Decimal]:
    """Geometric levels: price_i = center * (1 + step)^i, rounded to the price tick."""
    if center <= 0:
        raise ValueError("center must be > 0")
    if below < 1 or above < 1:
        raise ValueError("need at least one level on each side")
    r = ONE + D(step_pct) / HUNDRED
    levels = {}
    for i in range(-below, above + 1):
        levels[i] = round_to(D(center) * (r**i), spec.price_increment)
    prices = [levels[i] for i in sorted(levels)]
    if any(b <= a for a, b in zip(prices, prices[1:])):
        raise ValueError("step too small for the price tick: levels collapse")
    return levels


def range_bounds(
    levels: dict[int, Decimal], step_pct: Decimal
) -> tuple[Decimal, Decimal]:
    """Price beyond these (one full step outside the outermost levels) => PAUSE."""
    r = ONE + D(step_pct) / HUNDRED
    return levels[min(levels)] / r, levels[max(levels)] * r


def out_of_range(
    low: Decimal, high: Decimal, bounds: tuple[Decimal, Decimal]
) -> Optional[str]:
    lo, hi = bounds
    if low < lo:
        return f"price traded {low} < lower bound {lo:.6f}"
    if high > hi:
        return f"price traded {high} > upper bound {hi:.6f}"
    return None


# ---------------------------------------------------------------- sizing


def buy_cost(size: Decimal, price: Decimal, fee_rate: Decimal) -> Decimal:
    """USDC a limit buy consumes incl. maker fee."""
    return size * price * (ONE + fee_rate)


def sell_net(size: Decimal, price: Decimal, fee_rate: Decimal) -> Decimal:
    """USDC a limit sell yields after maker fee."""
    return size * price * (ONE - fee_rate)


def buy_size_for_quote(
    quote: Decimal, price: Decimal, fee_rate: Decimal, spec: ProductSpec
) -> Decimal:
    """Largest base size whose cost (incl. fee) does not exceed `quote`."""
    return floor_to(D(quote) / (price * (ONE + fee_rate)), spec.base_increment)


def too_small(size: Decimal, price: Decimal, spec: ProductSpec) -> Optional[str]:
    if size <= 0:
        return "size is zero"
    if size < spec.base_min_size:
        return f"size {size} < base_min_size {spec.base_min_size}"
    if size * price < spec.quote_min_size:
        return f"notional {size * price:.4f} < quote_min_size {spec.quote_min_size}"
    return None


@dataclass(frozen=True)
class PlannedOrder:
    side: str
    level: int
    price: Decimal
    size: Decimal


@dataclass(frozen=True)
class SkippedLevel:
    side: str
    level: int
    reason: str


def plan_initial(
    levels: dict[int, Decimal],
    usdc_per_buy: Decimal,
    usdc_budget: Decimal,
    xrp_allocation: Decimal,
    xrp_per_sell: Optional[Decimal],
    fee_rate: Decimal,
    spec: ProductSpec,
) -> tuple[list[PlannedOrder], list[SkippedLevel]]:
    """Buys below center (nearest first, until the USDC budget runs out),
    sells above center (XRP split evenly unless xrp_per_sell is given)."""
    orders: list[PlannedOrder] = []
    skipped: list[SkippedLevel] = []
    remaining = D(usdc_budget)
    for i in sorted((i for i in levels if i < 0), reverse=True):
        price = levels[i]
        size = buy_size_for_quote(
            min(D(usdc_per_buy), remaining), price, fee_rate, spec
        )
        why = too_small(size, price, spec)
        if why:
            skipped.append(SkippedLevel(BUY, i, why + " (USDC budget/size)"))
            continue
        remaining -= buy_cost(size, price, fee_rate)
        orders.append(PlannedOrder(BUY, i, price, size))

    sell_levels = sorted(i for i in levels if i > 0)
    per = D(xrp_per_sell) if xrp_per_sell else D(xrp_allocation) / len(sell_levels)
    per = floor_to(per, spec.base_increment)
    xrp_left = D(xrp_allocation)
    for i in sell_levels:
        price = levels[i]
        size = min(per, floor_to(xrp_left, spec.base_increment))
        why = too_small(size, price, spec)
        if why:
            skipped.append(SkippedLevel(SELL, i, why + " (XRP allocation)"))
            continue
        xrp_left -= size
        orders.append(PlannedOrder(SELL, i, price, size))
    return orders, skipped


def opposite_order(
    side: str,
    level: int,
    filled_size: Decimal,
    net_quote: Decimal,
    levels: dict[int, Decimal],
    fee_rate: Decimal,
    spec: ProductSpec,
    rebuy_sizing: str = "proceeds",
    usdc_per_buy: Decimal = D(0),
) -> tuple[Optional[PlannedOrder], Optional[str]]:
    """The order to place after a fill.

    BUY filled at i  -> SELL at i+1 for the same XRP quantity.
    SELL filled at i -> BUY at i-1 for the same USDC amount:
        rebuy_sizing='proceeds': the USDC the sell actually produced (net of fee),
        rebuy_sizing='fixed':    usdc_per_buy from config.
    Returns (order, None) or (None, reason).
    """
    if side == BUY:
        target = level + 1
        if target not in levels:
            return None, f"no level {target} above"
        price = levels[target]
        size = floor_to(D(filled_size), spec.base_increment)
    elif side == SELL:
        target = level - 1
        if target not in levels:
            return None, f"no level {target} below"
        price = levels[target]
        quote = D(net_quote) if rebuy_sizing == "proceeds" else D(usdc_per_buy)
        size = buy_size_for_quote(quote, price, fee_rate, spec)
    else:
        raise ValueError(side)
    why = too_small(size, price, spec)
    if why:
        return None, why
    return PlannedOrder(BUY if side == SELL else SELL, target, price, size), None


# ---------------------------------------------------------------- post-only pricing


def maker_price(
    side: str, level_price: Decimal, best_bid: Decimal, best_ask: Decimal, tick: Decimal
) -> Decimal:
    """Never cross: a buy must rest below the ask, a sell above the bid.
    If the market already moved through the level, rest one tick inside our side
    (which is a *better* price than the level, never worse)."""
    if side == BUY:
        return min(level_price, best_ask - tick)
    return max(level_price, best_bid + tick)


def reprice_away(side: str, price: Decimal, tick: Decimal) -> Decimal:
    """After a post-only rejection: move one tick away from the market."""
    return price - tick if side == BUY else price + tick


# ---------------------------------------------------------------- P&L


def realized_on_sell(
    sell_size: Decimal, sell_net_usdc: Decimal, basis_per_xrp: Decimal
) -> Decimal:
    """Profit of a sell against the cost basis of the XRP it sold (basis incl. buy fee)."""
    return D(sell_net_usdc) - D(sell_size) * D(basis_per_xrp)
