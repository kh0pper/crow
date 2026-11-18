"""rebalance.py: the weight-band rebalancer, decided from a hand-built view.

The expectations here are derived from the strategy contract and `money.py`, not
from the strategy's own code.  Sizes come from solving
`base*mid / (base*mid + quote) == target` for the fill at the limit price, fees
included; the post-trade weight is recomputed from the post-fill *balances*, so
it does not depend on how the strategy's algebra was written; prices come from
`money.maker_price`.  No exchange, no store: a BotView and a MarketSnapshot are
plain dataclasses.

Every decision in this file goes through `decide()`, which checks the shape
rules the contract puts on every tick: at most one place intent, never a place
in the same decision as a cancel, no `consumes_fill` on a rebalance's orders, no
`level`, and a cancel intent that names the row it cancels.
"""

from __future__ import annotations

import copy
from decimal import Decimal as D

import pytest

from crow_coinbase import money
from crow_coinbase.ledger import Holding
from crow_coinbase.strategies.base import BotView, MarketSnapshot
from crow_coinbase.strategies.rebalance import RebalanceStrategy

SPEC = money.ProductSpec(
    "XRP-USDC", D("0.0001"), D("0.000001"), D("0.0001"), D("0.000001"), D("1")
)
FEE = D("0.005")
PRODUCT = "XRP-USDC"
TS = 1_700_000_000.0

BID = D("0.9640")
ASK = D("0.9650")
MID = (BID + ASK) / 2  # 0.9645
TARGET = D("0.5")  # the default target_base_pct, as a fraction
BAND = D("7.5")  # the default band_pts


# ---------------------------------------------------------------- fixtures


def params(**over) -> dict:
    """The default rebalance config: an empty dict, so the strategy's own
    defaults (50 / 7.5 / 2 / 600) apply; keywords add single fields."""
    return dict(over)


def holding(
    quote="0", base="0", reserved_quote="0", reserved_base="0"
) -> Holding:
    return Holding(
        D(str(quote)), D(str(base)), D(str(reserved_quote)), D(str(reserved_base))
    )


def holding_at(
    pct, scale="1", mid=MID, reserved_quote="0", reserved_base="0"
) -> Holding:
    """A holding whose weight on its TOTALS is exactly *pct* percent.

    `quote / (base*mid)` is `(100-pct)/pct` by construction, so the weight is
    exact rather than rounded — which is what makes a band-edge fixture mean
    something.  `scale` shrinks or grows the account without changing the split.
    """
    p, k, m = D(str(pct)), D(str(scale)), D(str(mid))
    return holding(
        quote=D(10) * m * (D(100) - p) * k,
        base=D(10) * p * k,
        reserved_quote=reserved_quote,
        reserved_base=reserved_base,
    )


def view(pending=(), open_orders=(), hold=None, p=None, state=None, now=TS) -> BotView:
    return BotView(
        bot_id="b1",
        product=PRODUCT,
        params=params() if p is None else p,
        state={} if state is None else state,
        holding=holding("100", "100") if hold is None else hold,
        open_orders=list(open_orders),
        pending_fills=list(pending),
        fee_rate=FEE,
        spec=SPEC,
        now=TS if now is None else now,
    )


def snap(bid=BID, ask=ASK, low="0.9600", high="0.9700") -> MarketSnapshot:
    """A poll window whose low/high sit near the mid of the top of book."""
    return MarketSnapshot(
        product=PRODUCT,
        bid=None if bid is None else D(str(bid)),
        ask=None if ask is None else D(str(ask)),
        low=None if low is None else D(str(low)),
        high=None if high is None else D(str(high)),
        ts=TS,
    )


def order(cid, side, price, size, status="OPEN", created_at=None, **extra) -> dict:
    """One row shaped as `store.orders()` hands it over for open orders."""
    o = {
        "client_order_id": cid,
        "side": side,
        "status": status,
        "price": D(str(price)),
        "size": D(str(size)),
    }
    if created_at is not None:
        o["created_at"] = created_at
    o.update(extra)
    return o


def fill(cid, side, size, value, fees="0", price=BID, **extra) -> dict:
    """One fill row still awaiting its place in the runner's ledger."""
    f = {
        "client_order_id": cid,
        "side": side,
        "price": D(str(price)),
        "filled_size": D(str(size)),
        "filled_value": D(str(value)),
        "fees": D(str(fees)),
    }
    f.update(extra)
    return f


# ---------------------------------------------------------------- the weight


def weight(base, quote, mid=MID) -> D:
    """The weight at *mid* of a base/quote pair, as a fraction of the totals."""
    m = D(mid)
    value = D(base) * m + D(quote)
    return D(0) if value == 0 else D(base) * m / value


def after_fill(h, side, size, price):
    """`(base', quote')` once *size* fills at *price*, the maker fee included."""
    size, price = D(size), D(price)
    if side == money.BUY:
        return h.base + size, h.quote - money.buy_cost(size, price, FEE)
    return h.base - size, h.quote + money.sell_net(size, price, FEE)


def weight_after(h, side, size, price, mid=MID) -> D:
    """The weight at *mid* after the fill, from the post-fill balances.

    Nothing here repeats the strategy's sizing algebra: it is the definition of
    the weight applied to what the account would hold afterwards.
    """
    base, quote = after_fill(h, side, size, price)
    return weight(base, quote, mid)


def assert_weight_at_target(h, side, size, price, mid=MID):
    """The fill lands on the target weight, within one base increment.

    One increment of size moves the weight by `inc*mid*(1-w)/V'`, which is
    smaller than `inc*mid/V'`, so that is the bound used.
    """
    base, quote = after_fill(h, side, size, price)
    value = base * D(mid) + quote
    tolerance = SPEC.base_increment * D(mid) / value
    assert abs(weight(base, quote, mid) - TARGET) <= tolerance


def solve_size(h, pct, side, price, mid=MID) -> D:
    """The contract's size, before the available-funds cap, floored to the tick.

    BUY  c = p*(1+fee) - mid   size = (t*V - base*mid) / (mid + t*c)
    SELL c = mid - p*(1-fee)   size = (base*mid - t*V) / (mid - t*c)
    """
    t = D(str(pct)) / D(100)
    mid, price = D(mid), D(price)
    value = h.base * mid + h.quote
    if side == money.BUY:
        c = price * (D(1) + FEE) - mid
        raw = (t * value - h.base * mid) / (mid + t * c)
    else:
        c = mid - price * (D(1) - FEE)
        raw = (h.base * mid - t * value) / (mid - t * c)
    return money.floor_to(raw, SPEC.base_increment)


# ---------------------------------------------------------------- the answer


def places(d) -> list:
    return [i for i in d.intents if i.action == "place"]


def cancels(d) -> list:
    return [i for i in d.intents if i.action == "cancel"]


def decide(strat, s, v):
    """One tick, with the contract's shape rules checked in every test."""
    d = strat.decide(s, v)
    assert len(places(d)) <= 1, d.intents  # never more than one order
    if cancels(d):
        # Taking a row off the book and placing its replacement are two ticks.
        assert places(d) == [], d.intents
    for i in d.intents:
        if i.action == "place":
            assert i.side in (money.BUY, money.SELL)
            assert i.level is None
            assert i.consumes_fill is None
            assert i.size is not None and i.size > 0
            assert i.limit_price is not None and i.limit_price > 0
        else:
            assert i.action == "cancel"
            assert i.cancel_cid
    return d


# ---------------------------------------------------------------- in the band


def test_inside_band_no_trade():
    strat = RebalanceStrategy()

    # The fixture really is at 55%: the weight is exact, not rounded.
    h = holding_at("55")
    assert weight(h.base, h.quote) == D("0.55")

    for pct in ("50", "55", "57.5", "42.5", "45"):
        d = decide(strat, snap(), view(hold=holding_at(pct)))
        assert d.intents == [], pct
        assert d.pause_reason is None
        assert d.skipped_fills == []

    # Exactly on the band edge (|57.5 - 50| == 7.5) is still inside it, and so
    # is the edge a narrower band is configured with.
    for pct in ("57.5", "42.5"):
        h = holding_at(pct)
        assert weight(h.base, h.quote) == D(pct) / D(100)
        d = decide(strat, snap(), view(hold=h))
        assert d.intents == []
        assert d.pause_reason is None

    d = decide(strat, snap(), view(hold=holding_at("55"), p=params(band_pts=5)))
    assert d.intents == []
    assert d.pause_reason is None


# ---------------------------------------------------------------- out of it


def test_above_band_sells_back_to_target():
    strat = RebalanceStrategy()
    h = holding_at("70")
    assert weight(h.base, h.quote) == D("0.70")
    assert abs(weight(h.base, h.quote) * 100 - D("50")) > BAND

    d = decide(strat, snap(), view(hold=h))

    assert d.pause_reason is None
    assert d.skipped_fills == []
    assert len(d.intents) == 1
    i = d.intents[0]
    assert i.action == "place"
    assert i.side == money.SELL
    assert i.limit_price == ASK
    assert i.size == solve_size(h, "50", money.SELL, ASK)
    assert money.floor_to(i.size, SPEC.base_increment) == i.size
    assert i.size <= h.available_base

    # What is left is the target split, to within one base increment of size.
    assert_weight_at_target(h, money.SELL, i.size, i.limit_price)
    assert abs(weight_after(h, money.SELL, i.size, i.limit_price) * 100 - D("50")) < D(
        "0.01"
    )


def test_below_band_buys():
    strat = RebalanceStrategy()
    h = holding_at("30")
    assert weight(h.base, h.quote) == D("0.30")

    d = decide(strat, snap(), view(hold=h))

    assert d.pause_reason is None
    assert d.skipped_fills == []
    assert len(d.intents) == 1
    i = d.intents[0]
    assert i.action == "place"
    assert i.side == money.BUY
    assert i.limit_price == BID
    assert i.size == solve_size(h, "50", money.BUY, BID)
    assert money.floor_to(i.size, SPEC.base_increment) == i.size
    assert money.buy_cost(i.size, i.limit_price, FEE) <= h.available_quote

    assert_weight_at_target(h, money.BUY, i.size, i.limit_price)


def test_zero_holdings():
    strat = RebalanceStrategy()

    # Nothing in base, all in quote: the weight is 0, so it is a buy, and it may
    # not spend more quote than the account holds.
    only_quote = holding(quote="100")
    assert only_quote.base == 0
    d = decide(strat, snap(), view(hold=only_quote))
    assert d.pause_reason is None
    assert [i.action for i in d.intents] == ["place"]
    buy = d.intents[0]
    assert buy.side == money.BUY
    assert buy.limit_price == BID
    assert buy.size == solve_size(only_quote, "50", money.BUY, BID)
    assert money.buy_cost(buy.size, buy.limit_price, FEE) <= D("100")

    # Nothing in quote, all in base: the weight is 100%, so it is a sell, and it
    # may not sell more base than the account holds.
    only_base = holding(base="100")
    assert only_base.quote == 0
    d2 = decide(strat, snap(), view(hold=only_base))
    assert d2.pause_reason is None
    assert [i.action for i in d2.intents] == ["place"]
    sell = d2.intents[0]
    assert sell.side == money.SELL
    assert sell.limit_price == ASK
    assert sell.size == solve_size(only_base, "50", money.SELL, ASK)
    assert sell.size <= D("100")

    # Nothing at all: there is no weight to bring back, and nothing to pause on.
    d3 = decide(strat, snap(), view(hold=holding()))
    assert d3.intents == []
    assert d3.pause_reason is None
    assert d3.skipped_fills == []


def test_small_trade_skipped():
    strat = RebalanceStrategy()

    # 60% is 10 points out of band, but on this account the trade to 50% is
    # worth less than the 2 USDC floor, so nothing is placed and nothing pauses.
    tiny = holding_at("60", scale="0.02")
    expected = solve_size(tiny, "50", money.SELL, ASK)
    assert expected > 0
    assert expected * ASK < D("2")
    # The product's own minimums are met: it is min_trade_quote that skips this.
    assert money.too_small(expected, ASK, SPEC) is None

    d = decide(strat, snap(), view(hold=tiny))
    assert d.intents == []
    assert d.pause_reason is None
    assert d.skipped_fills == []

    # The same shape of account, one notch larger, clears the floor and trades.
    just_over = holding_at("60", scale="0.021")
    expected2 = solve_size(just_over, "50", money.SELL, ASK)
    assert expected2 * ASK > D("2")

    d2 = decide(strat, snap(), view(hold=just_over))
    assert d2.pause_reason is None
    assert [i.side for i in d2.intents] == [money.SELL]
    assert d2.intents[0].size == expected2
    assert_weight_at_target(just_over, money.SELL, d2.intents[0].size, ASK)


# ---------------------------------------------------------------- open orders


def test_one_open_order_at_most():
    strat = RebalanceStrategy()
    h = holding_at("70")
    assert abs(weight(h.base, h.quote) * 100 - D("50")) > BAND

    young = order("cb-r-1", money.SELL, ASK, "150", created_at=TS - 60)
    d = decide(strat, snap(), view(hold=h, open_orders=[young]))
    assert d.intents == []
    assert d.pause_reason is None

    # A row that may still land is never re-priced, however old it is.
    pending = order(
        "cb-r-2", money.SELL, ASK, "150", status="PENDING_SUBMIT", created_at=TS - 60
    )
    d2 = decide(strat, snap(), view(hold=h, open_orders=[pending]))
    assert d2.intents == []

    old_pending = order(
        "cb-r-3", money.SELL, ASK, "150", status="PENDING_SUBMIT", created_at=TS - 601
    )
    d3 = decide(strat, snap(), view(hold=h, open_orders=[old_pending]))
    assert d3.intents == []

    # Two live rows are still at most nothing here: the weight is handled by
    # whatever is resting, so no second order is stacked on top.
    other = order("cb-r-4", money.SELL, ASK, "150", created_at=TS - 60)
    d4 = decide(strat, snap(), view(hold=h, open_orders=[young, other]))
    assert d4.intents == []

    # A dead row holds nothing: the rebalance goes ahead, once.
    dead = order("cb-r-5", money.SELL, ASK, "150", status="CANCELLED")
    d5 = decide(strat, snap(), view(hold=h, open_orders=[dead]))
    assert [i.side for i in places(d5)] == [money.SELL]
    assert cancels(d5) == []

    # A live row with no created_at and no updated_at cannot be shown to be
    # young, so it is stale: the cancel is free and nothing is placed yet.
    undated = order("cb-r-6", money.SELL, ASK, "150")
    d6 = decide(strat, snap(), view(hold=h, open_orders=[undated]))
    assert [i.action for i in d6.intents] == ["cancel"]
    assert d6.intents[0].cancel_cid == "cb-r-6"
    assert d6.pause_reason is None


def test_stale_order_by_age_cancel_and_repropose():
    strat = RebalanceStrategy()
    h = holding_at("70", reserved_base="300")
    assert h.available_base == D("400")
    stale = order("cb-r-sell-1", money.SELL, ASK, "300", created_at=TS - 601)

    d = decide(strat, snap(), view(hold=h, open_orders=[stale]))
    assert d.pause_reason is None
    # A stale row is taken off the book and nothing else: the replacement is a
    # later tick's answer, once the cancellation has freed what the row held.
    assert [i.action for i in d.intents] == ["cancel"]
    assert d.intents[0].cancel_cid == "cb-r-sell-1"
    assert places(d) == []

    # Exactly reprice_after_s old is not stale: 600 > 600 is false.
    for age in (600, 599, 1, 0):
        edge = order("cb-r-sell-2", money.SELL, ASK, "300", created_at=TS - age)
        d2 = decide(strat, snap(), view(hold=h, open_orders=[edge]))
        assert d2.intents == [], age
        assert d2.pause_reason is None

    # One second past reprice_after_s is stale.
    just_stale = order("cb-r-sell-2", money.SELL, ASK, "300", created_at=TS - 601)
    d_edge = decide(strat, snap(), view(hold=h, open_orders=[just_stale]))
    assert [i.action for i in d_edge.intents] == ["cancel"]
    assert d_edge.intents[0].cancel_cid == "cb-r-sell-2"

    # A stale row whose weight has since come back into the band: cancel only.
    inside = holding_at("55", reserved_base="300")
    d3 = decide(strat, snap(), view(hold=inside, open_orders=[stale]))
    assert [i.action for i in d3.intents] == ["cancel"]
    assert d3.intents[0].cancel_cid == "cb-r-sell-1"
    assert d3.pause_reason is None

    # Two stale rows: a cancel for each, in the order they came in, and no
    # replacement on this tick.
    second = order("cb-r-sell-3", money.SELL, ASK, "100", created_at=TS - 900)
    first = order("cb-r-sell-4", money.SELL, ASK, "100", created_at=TS - 700)
    two = holding_at("70", reserved_base="200")
    d4 = decide(strat, snap(), view(hold=two, open_orders=[first, second]))
    assert [i.action for i in d4.intents] == ["cancel", "cancel"]
    assert [i.cancel_cid for i in cancels(d4)] == ["cb-r-sell-4", "cb-r-sell-3"]
    assert places(d4) == []

    # A row with no created_at and no updated_at cannot be shown to be young, so
    # it counts as stale, and a cancel costs nothing.
    undated = order("cb-r-sell-5", money.SELL, ASK, "300")
    for row in (undated, dict(undated, created_at=None)):
        d5 = decide(strat, snap(), view(hold=h, open_orders=[row]))
        assert [i.action for i in d5.intents] == ["cancel"]
        assert d5.intents[0].cancel_cid == "cb-r-sell-5"
        assert d5.pause_reason is None


def test_stale_age_falls_back_to_updated_at():
    strat = RebalanceStrategy()
    h = holding_at("70", reserved_base="300")

    # Only updated_at: that column is the row's age.
    old = order("cb-r-u-1", money.SELL, ASK, "300", updated_at=TS - 601)
    assert "created_at" not in old
    d = decide(strat, snap(), view(hold=h, open_orders=[old]))
    assert [i.action for i in d.intents] == ["cancel"]
    assert d.intents[0].cancel_cid == "cb-r-u-1"

    # A null created_at is a missing one, so the updated_at age is used.
    nulled = dict(
        order("cb-r-u-2", money.SELL, ASK, "300", created_at=None),
        updated_at=TS - 601,
    )
    d_nulled = decide(strat, snap(), view(hold=h, open_orders=[nulled]))
    assert [i.action for i in d_nulled.intents] == ["cancel"]
    assert d_nulled.intents[0].cancel_cid == "cb-r-u-2"

    young = order("cb-r-u-3", money.SELL, ASK, "300", updated_at=TS - 60)
    d2 = decide(strat, snap(), view(hold=h, open_orders=[young]))
    assert d2.intents == []
    assert d2.pause_reason is None

    # created_at wins when both are present: a young created_at is not stale,
    # however old the last update is.
    mixed = order(
        "cb-r-u-4",
        money.SELL,
        ASK,
        "300",
        created_at=TS - 60,
        updated_at=TS - 900,
    )
    d3 = decide(strat, snap(), view(hold=h, open_orders=[mixed]))
    assert d3.intents == []
    assert d3.pause_reason is None

    # Neither column present: stale, and the cancel is free.
    bare = order("cb-r-u-5", money.SELL, ASK, "300")
    assert "created_at" not in bare and "updated_at" not in bare
    d4 = decide(strat, snap(), view(hold=h, open_orders=[bare]))
    assert [i.action for i in d4.intents] == ["cancel"]
    assert d4.intents[0].cancel_cid == "cb-r-u-5"

    # A row that may still land is never re-priced, whatever its age columns
    # say.
    for extra in (
        {},
        {"created_at": TS - 900},
        {"updated_at": TS - 900},
        {"created_at": TS - 900, "updated_at": TS - 900},
    ):
        pending = order(
            "cb-r-u-6", money.SELL, ASK, "300", status="PENDING_SUBMIT", **extra
        )
        d5 = decide(strat, snap(), view(hold=h, open_orders=[pending]))
        assert d5.intents == [], extra
        assert d5.pause_reason is None


# ---------------------------------------------------------------- params


VALIDATE_CASES = [
    # ---- the band is 5..10 points, inclusive
    ("band_4_99", params(band_pts="4.99"), True),
    ("band_10_01", params(band_pts="10.01"), True),
    ("band_0", params(band_pts="0"), True),
    ("band_negative", params(band_pts="-7.5"), True),
    ("band_unparseable", params(band_pts="abc"), True),
    ("band_nan", params(band_pts="nan"), True),
    ("band_inf", params(band_pts="inf"), True),
    ("band_list", params(band_pts=["7.5"]), True),
    ("band_true", params(band_pts=True), True),
    ("band_false", params(band_pts=False), True),
    ("band_5_int", params(band_pts=5), False),
    ("band_10_int", params(band_pts=10), False),
    ("band_7_5_str", params(band_pts="7.5"), False),
    ("band_7_5_float", params(band_pts=7.5), False),
    ("band_7_5_decimal", params(band_pts=D("7.5")), False),
    # ---- the target is strictly between 0 and 100
    ("target_0", params(target_base_pct=0), True),
    ("target_100", params(target_base_pct=100), True),
    ("target_negative", params(target_base_pct=-5), True),
    ("target_over", params(target_base_pct=150), True),
    ("target_unparseable", params(target_base_pct="abc"), True),
    ("target_true", params(target_base_pct=True), True),
    ("target_small", params(target_base_pct="0.01"), False),
    ("target_large", params(target_base_pct=99.99), False),
    ("target_str", params(target_base_pct="50"), False),
    ("target_int", params(target_base_pct=50), False),
    ("target_decimal", params(target_base_pct=D("50")), False),
    # ---- the trade floor is positive
    ("min_trade_0", params(min_trade_quote=0), True),
    ("min_trade_negative", params(min_trade_quote="-1"), True),
    ("min_trade_unparseable", params(min_trade_quote="abc"), True),
    ("min_trade_true", params(min_trade_quote=True), True),
    ("min_trade_small", params(min_trade_quote="0.5"), False),
    ("min_trade_str", params(min_trade_quote="2"), False),
    ("min_trade_int", params(min_trade_quote=2), False),
    # ---- the reprice age is positive
    ("reprice_0", params(reprice_after_s=0), True),
    ("reprice_negative", params(reprice_after_s=-600), True),
    ("reprice_unparseable", params(reprice_after_s="abc"), True),
    ("reprice_true", params(reprice_after_s=True), True),
    ("reprice_false", params(reprice_after_s=False), True),
    ("reprice_fractional", params(reprice_after_s="0.5"), False),
    ("reprice_str", params(reprice_after_s="60"), False),
    ("reprice_int", params(reprice_after_s=60), False),
    # ---- defaults, and unknown keys carried along
    ("empty", params(), False),
    ("unknown_key", params(foo="bar", band_pts="6"), False),
]


@pytest.mark.parametrize(
    "case,p,raises", VALIDATE_CASES, ids=[c[0] for c in VALIDATE_CASES]
)
def test_band_outside_5_10_rejected(case, p, raises):
    strat = RebalanceStrategy()
    if raises:
        with pytest.raises(ValueError):
            strat.validate(p)
        with pytest.raises(ValueError):
            strat.validate(p, SPEC)
    else:
        strat.validate(p)
        strat.validate(p, SPEC)


# ---------------------------------------------------------------- never crossing


BOOK_CASES = [
    ("default", "0.9640", "0.9650"),
    ("one_tick_spread", "0.9640", "0.9641"),
    ("wide", "0.9500", "0.9800"),
    ("wide_low", "0.9400", "0.9700"),
]


@pytest.mark.parametrize(
    "case,bid,ask", BOOK_CASES, ids=[c[0] for c in BOOK_CASES]
)
def test_never_crosses(case, bid, ask):
    bid, ask = D(bid), D(ask)
    mid = (bid + ask) / 2
    strat = RebalanceStrategy()

    for pct, side in (("30", money.BUY), ("70", money.SELL)):
        h = holding_at(pct, mid=mid)
        assert weight(h.base, h.quote, mid) == D(pct) / D(100)

        d = decide(strat, snap(bid=bid, ask=ask, low=bid, high=ask), view(hold=h))
        assert d.pause_reason is None
        placed = places(d)
        assert len(placed) == 1
        i = placed[0]
        assert i.side == side
        # The contract's own post-only price for that side, on this book.
        level_price = bid if side == money.BUY else ask
        assert i.limit_price == money.maker_price(
            side, level_price, bid, ask, SPEC.price_increment
        )
        if side == money.BUY:
            assert i.limit_price <= bid
            assert i.limit_price < ask
        else:
            assert i.limit_price >= ask
            assert i.limit_price > bid
        # The same price is the one the size was solved at, so the fill lands
        # on the target weight rather than somewhere past it.
        assert_weight_at_target(h, side, i.size, i.limit_price, mid=mid)


# ---------------------------------------------------------------- funding


def test_buy_affordable_including_fee():
    strat = RebalanceStrategy()

    # 675.15 USDC of totals, most of it reserved: only 75.15 is free to spend.
    h = holding_at("30", reserved_quote="600")
    assert h.quote == D("675.15")
    assert h.available_quote == D("75.15")

    uncapped = solve_size(h, "50", money.BUY, BID)
    assert money.buy_cost(uncapped, BID, FEE) > h.available_quote

    d = decide(strat, snap(), view(hold=h))
    i = places(d)[0]
    assert i.side == money.BUY
    assert i.limit_price == BID
    assert i.size == money.buy_size_for_quote(h.available_quote, BID, FEE, SPEC)
    assert i.size < uncapped
    assert money.buy_cost(i.size, i.limit_price, FEE) <= h.available_quote
    assert d.pause_reason is None

    # With nothing reserved the same account is not capped at all.
    free = holding_at("30")
    d2 = decide(strat, snap(), view(hold=free))
    assert places(d2)[0].size == solve_size(free, "50", money.BUY, BID)
    assert_weight_at_target(free, money.BUY, places(d2)[0].size, BID)


def test_stale_cancel_then_place_next_tick():
    strat = RebalanceStrategy()

    # A stale buy for 500 XRP holds 484.41 USDC of the 675.15: on the free
    # funds alone the rebalance would have to buy a smaller lot.
    h = holding_at("30", reserved_quote="484.41")
    assert h.available_quote == D("190.74")

    stale = order("cb-r-buy-1", money.BUY, BID, "500", created_at=TS - 700)
    assert "filled_size" not in stale  # a row without it reserves the whole size

    uncapped = solve_size(h, "50", money.BUY, BID)
    capped_size = money.buy_size_for_quote(h.available_quote, BID, FEE, SPEC)
    assert capped_size < uncapped  # the free funds alone would give a smaller buy

    # Tick 1: the stale row comes off the book, and nothing is placed with it.
    d = decide(strat, snap(), view(hold=h, open_orders=[stale]))
    assert [i.action for i in d.intents] == ["cancel"]
    assert d.intents[0].cancel_cid == "cb-r-buy-1"
    assert places(d) == []
    assert d.pause_reason is None

    # Tick 2: the row is cancelled and its funds are free, so the full size goes.
    freed = holding_at("30")
    assert freed.quote == h.quote
    assert freed.available_quote == h.quote
    gone = dict(stale, status="CANCELLED")
    d2 = decide(strat, snap(), view(hold=freed, open_orders=[gone]))
    assert cancels(d2) == []
    assert [i.action for i in d2.intents] == ["place"]
    place = d2.intents[0]
    assert place.side == money.BUY
    assert place.limit_price == BID
    assert place.size == uncapped
    assert place.size == solve_size(freed, "50", money.BUY, BID)
    assert money.buy_cost(place.size, place.limit_price, FEE) <= freed.available_quote
    assert_weight_at_target(freed, money.BUY, place.size, place.limit_price)


# ---------------------------------------------------------------- pending fills


def test_pending_fills_all_skipped():
    strat = RebalanceStrategy()

    first = fill("cb-f-1", money.BUY, "5", "4.8200")
    second = fill("cb-f-2", money.SELL, "5", "4.8250")
    keyless = fill("cb-f-3", money.BUY, "5", "4.8200")
    keyless.pop("client_order_id")
    rows = [first, keyless, second]

    for pct, scale in (("55", "1"), ("70", "1"), ("60", "0.02")):
        d = decide(strat, snap(), view(hold=holding_at(pct, scale=scale), pending=rows))
        assert d.pause_reason is None
        assert d.skipped_fills == ["cb-f-1", "cb-f-2"], pct
        assert all(i.consumes_fill is None for i in d.intents)

    # The same row twice is retired once.
    duplicate = [first, dict(first), keyless, second]
    d = decide(strat, snap(), view(hold=holding_at("55"), pending=duplicate))
    assert d.skipped_fills == ["cb-f-1", "cb-f-2"]

    # A pause retires nothing: the fills are the next tick's business.
    crossed = snap(bid="0.9650", ask="0.9640")
    d = decide(strat, crossed, view(hold=holding_at("70"), pending=rows))
    assert d.intents == []
    assert d.pause_reason is not None
    assert d.skipped_fills == []


# ---------------------------------------------------------------- the book


BOOK_PAUSES = [
    ("no_bid", None, "0.9650"),
    ("no_ask", "0.9640", None),
    ("zero_bid", "0", "0.9650"),
    ("zero_ask", "0.9640", "0"),
    ("negative_bid", "-1", "0.9650"),
    ("equal", "0.9645", "0.9645"),
    ("crossed", "0.9650", "0.9640"),
]


@pytest.mark.parametrize(
    "case,bid,ask", BOOK_PAUSES, ids=[c[0] for c in BOOK_PAUSES]
)
def test_missing_or_crossed_book_pauses(case, bid, ask):
    h = holding_at("70")
    d = decide(RebalanceStrategy(), snap(bid=bid, ask=ask), view(hold=h))

    assert d.intents == []
    assert isinstance(d.pause_reason, str) and d.pause_reason
    assert d.skipped_fills == []


# ---------------------------------------------------------------- totals, not free funds


def test_weight_uses_total_not_available():
    strat = RebalanceStrategy()

    # Totals are at 55%, inside the band.  With 400 USDC reserved elsewhere the
    # free funds alone would read ~94%, which would want a sell.
    h = holding_at("55", reserved_quote="400")
    assert weight(h.base, h.quote) == D("0.55")
    assert weight(h.available_base, h.available_quote) > D("0.575")

    d = decide(strat, snap(), view(hold=h))
    assert d.intents == []
    assert d.pause_reason is None

    # The reverse: totals at 70% (out of band, a sell) while the free funds
    # alone read exactly 50% and would have said there is nothing to do.
    h2 = holding_at("70", reserved_base="400")
    assert weight(h2.base, h2.quote) == D("0.70")
    assert weight(h2.available_base, h2.available_quote) == D("0.50")

    d2 = decide(strat, snap(), view(hold=h2))
    assert d2.pause_reason is None
    assert [i.side for i in places(d2)] == [money.SELL]
    assert_weight_at_target(h2, money.SELL, places(d2)[0].size, ASK)


# ---------------------------------------------------------------- guard / init


def test_fee_guard_none_and_init_matches_decide():
    strat = RebalanceStrategy()
    assert strat.name == "rebalance"

    # A rebalancer turns over little, so any maker fee is acceptable.
    for maker in ("0", "0.005", "0.25", "0.5", "1.5", "5", 0.1, D("2")):
        assert strat.fee_guard(params(), D(str(maker))) is None, maker
        assert strat.fee_guard(params(band_pts="5"), D(str(maker))) is None, maker

    out_of_band = view(hold=holding_at("70"))
    s = snap()
    init = strat.init_intents(s, out_of_band)
    assert init == strat.decide(s, out_of_band)
    assert [i.action for i in init.intents] == ["place"]

    # Nothing to do is the same answer both ways too.
    inside = view(hold=holding_at("55"))
    assert strat.init_intents(s, inside) == strat.decide(s, inside)
    assert strat.init_intents(s, inside).intents == []


# ---------------------------------------------------------------- purity


def test_decide_is_pure():
    strat = RebalanceStrategy()
    stale = order("cb-r-sell-9", money.SELL, ASK, "100", created_at=TS - 900)
    rows = [fill("cb-f-9", money.SELL, "5", "4.8250")]
    v = view(
        hold=holding_at("70", reserved_base="100"),
        open_orders=[stale],
        pending=rows,
        p=params(band_pts="6", target_base_pct="60"),
    )
    s = snap()

    before = copy.deepcopy(
        (v.holding, v.open_orders, v.pending_fills, v.params, v.state)
    )

    first = strat.decide(s, v)
    second = strat.decide(s, v)

    assert first == second
    assert first.intents != []  # there is something to be equal about
    assert first.state_update is None
    assert first.skipped_fills == ["cb-f-9"]
    assert (v.holding, v.open_orders, v.pending_fills, v.params, v.state) == before