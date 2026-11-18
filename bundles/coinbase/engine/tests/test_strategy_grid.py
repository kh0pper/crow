"""grid.py: the level grid strategy, decided from a hand-built view.

Every price and size here comes from `money.build_levels` / `money.plan_initial`
/ `money.opposite_order`, so the expectations are the grid math's own numbers.
No exchange, no store: a BotView and a MarketSnapshot are plain dataclasses.
"""

from __future__ import annotations

import copy
from decimal import Decimal as D

import pytest

from crow_coinbase import money
from crow_coinbase.ledger import Holding
from crow_coinbase.strategies.base import BotView, MarketSnapshot
from crow_coinbase.strategies.grid import GridStrategy

SPEC = money.ProductSpec(
    "XRP-USDC", D("0.0001"), D("0.000001"), D("0.0001"), D("0.000001"), D("1")
)
FEE = D("0.005")
PRODUCT = "XRP-USDC"
TS = 1_700_000_000.0


# ---------------------------------------------------------------- fixtures


def params(**over) -> dict:
    """The default grid config; keyword arguments override single fields."""
    p = {
        "center": "0.9645",
        "step_pct": "2.5",
        "levels_below": 3,
        "levels_above": 3,
        "quote_per_buy": "15",
        "rebuy_sizing": "proceeds",
    }
    p.update(over)
    return p


def levels(p=None) -> dict:
    """The levels the strategy derives from its params (never stored)."""
    p = params() if p is None else p
    return money.build_levels(
        D(str(p["center"])),
        D(str(p["step_pct"])),
        int(p["levels_below"]),
        int(p["levels_above"]),
        SPEC,
    )


def holding(
    quote="0", base="0", reserved_quote="0", reserved_base="0"
) -> Holding:
    return Holding(
        D(str(quote)), D(str(base)), D(str(reserved_quote)), D(str(reserved_base))
    )


def view(pending=(), open_orders=(), hold=None, p=None, state=None) -> BotView:
    return BotView(
        bot_id="b1",
        product=PRODUCT,
        params=params() if p is None else p,
        state={} if state is None else state,
        holding=holding("45", "60") if hold is None else hold,
        open_orders=list(open_orders),
        pending_fills=list(pending),
        fee_rate=FEE,
        spec=SPEC,
        now=TS,
    )


def snap(low="0.9400", high="0.9900", bid="0.9640", ask="0.9650") -> MarketSnapshot:
    """A poll window whose low/high sit inside the default grid's bounds."""
    return MarketSnapshot(
        product=PRODUCT,
        bid=D(bid),
        ask=D(ask),
        low=D(low),
        high=D(high),
        ts=TS,
    )


def fill(cid, side, level, size, value, fees="0", **extra) -> dict:
    """One terminal order row, shaped as `store.orders()` hands it over."""
    f = {
        "client_order_id": cid,
        "side": side,
        "level": level,
        "filled_size": D(str(size)),
        "filled_value": D(str(value)),
        "fees": D(str(fees)),
    }
    f.update(extra)
    return f


def filled_at(lv, cid, side, level, size, fees="0") -> dict:
    """A fill at one of the grid's own level prices; a sell keeps `fees` apart."""
    size = D(str(size))
    price = lv[level]
    value = size * price if side == money.BUY else money.sell_net(size, price, FEE)
    return fill(cid, side, level, size, value + D(str(fees)), fees=fees)


def order(cid, side, level, price, size, status="OPEN", **extra) -> dict:
    """One row shaped as `store.orders()` hands it over for open orders."""
    o = {
        "client_order_id": cid,
        "side": side,
        "level": level,
        "status": status,
        "price": D(str(price)),
        "size": D(str(size)),
    }
    o.update(extra)
    return o


# ---------------------------------------------------------------- init


def test_init_proposes_three_and_three():
    lv = levels()
    d = GridStrategy().init_intents(snap(), view(hold=holding("45", "60")))

    buys = [i for i in d.intents if i.side == money.BUY]
    sells = [i for i in d.intents if i.side == money.SELL]

    assert len(d.intents) == 6
    assert [i.level for i in buys] == [-1, -2, -3]  # nearest first
    assert [i.level for i in sells] == [1, 2, 3]

    for i in d.intents:
        assert i.action == "place"
        assert i.level is not None
        assert i.consumes_fill is None
        assert i.cancel_cid is None
        assert i.limit_price == lv[i.level]
        assert i.size is not None and i.size > 0
        assert str(i.level) in i.reason

    assert sum(money.buy_cost(i.size, i.limit_price, FEE) for i in buys) <= D("45")
    assert [i.size for i in sells] == [D("20"), D("20"), D("20")]
    assert d.pause_reason is None
    assert d.skipped_fills == []


def test_init_respects_budget():
    lv = levels()
    d = GridStrategy().init_intents(snap(), view(hold=holding("20", "0")))

    assert [i.side for i in d.intents] == [money.BUY, money.BUY]
    assert [i.level for i in d.intents] == [-1, -2]
    assert all(i.limit_price == lv[i.level] for i in d.intents)
    assert sum(money.buy_cost(i.size, i.limit_price, FEE) for i in d.intents) <= D("20")
    assert not any(i.side == money.SELL for i in d.intents)
    assert d.skipped_fills == []

    # Nothing at all to spend and nothing to sell: no intents, still no error.
    empty = GridStrategy().init_intents(snap(), view(hold=holding("0", "0")))
    assert empty.intents == []


# ---------------------------------------------------------------- buy fills


def test_buy_fill_places_sell_one_level_up_same_qty():
    lv = levels()
    size = D("15.861183")
    f = filled_at(lv, "cb-b1-B--1-000000000001", money.BUY, -1, size, fees="0.07")

    d = GridStrategy().decide(snap(), view(pending=[f]))

    assert d.pause_reason is None
    assert d.skipped_fills == []
    assert len(d.intents) == 1
    i = d.intents[0]
    assert i.action == "place"
    assert i.side == money.SELL
    assert i.level == 0
    assert i.size == size
    assert i.limit_price == lv[0]
    assert i.consumes_fill == f["client_order_id"]

    # A row whose money columns arrive as strings (JSON) is read the same way.
    raw = {
        "client_order_id": "cb-b1-B--1-000000000017",
        "side": money.BUY,
        "level": -1,
        "filled_size": "10",
        "filled_value": "9.4100",
        "fees": "0.0235",
    }
    d2 = GridStrategy().decide(snap(), view(pending=[raw]))
    assert [i.size for i in d2.intents] == [D("10")]
    assert d2.intents[0].level == 0


def test_follow_up_carries_consumes_fill():
    lv = levels()
    cid = "cb-b1-B--1-000000000004"
    f = filled_at(lv, cid, money.BUY, -1, D("10"))

    d = GridStrategy().decide(snap(), view(pending=[f]))
    assert d.intents[0].consumes_fill == cid

    # When the row carries its own `id`, that is the fill id.
    row = dict(f)
    row["id"] = "fill-9f2c"
    d2 = GridStrategy().decide(snap(), view(pending=[row]))
    assert d2.intents[0].consumes_fill == "fill-9f2c"


def test_partial_then_cancel_opposite_for_filled_part():
    lv = levels()
    f = filled_at(lv, "cb-b1-B--2-000000000014", money.BUY, -2, D("6"), fees="0.02")
    # The rest of the order (4 of 10 XRP) never filled before it was cancelled.
    row = dict(f, status="CANCELLED", size=D("10"), order_id="o-14")

    d = GridStrategy().decide(snap(), view(pending=[row]))

    assert d.skipped_fills == []
    assert len(d.intents) == 1
    i = d.intents[0]
    assert i.side == money.SELL
    assert i.level == -1
    assert i.size == D("6")
    assert i.limit_price == lv[-1]
    assert i.consumes_fill == row["client_order_id"]


# ---------------------------------------------------------------- sell fills


def test_sell_fill_rebuys_one_level_down_with_proceeds():
    lv = levels()
    size = D("14.611557")
    fees = D("0.07")
    f = filled_at(lv, "cb-b1-S-1-000000000002", money.SELL, 1, size, fees=fees)
    net = f["filled_value"] - f["fees"]

    d = GridStrategy().decide(snap(), view(pending=[f]))

    assert d.skipped_fills == []
    assert len(d.intents) == 1
    i = d.intents[0]
    assert i.side == money.BUY
    assert i.level == 0
    assert i.limit_price == lv[0]
    assert money.buy_cost(i.size, i.limit_price, FEE) <= net
    assert i.size == money.buy_size_for_quote(net, lv[0], FEE, SPEC)
    assert i.size > size
    assert i.consumes_fill == f["client_order_id"]


def test_fixed_rebuy_uses_quote_per_buy():
    p = params(rebuy_sizing="fixed")
    lv = levels(p)
    size = D("14.611557")
    f = fill("cb-b1-S-1-000000000003", money.SELL, 1, size, D("100"), fees="0")

    d = GridStrategy().decide(snap(), view(pending=[f], p=p))

    assert d.skipped_fills == []
    i = d.intents[0]
    assert i.side == money.BUY
    assert i.level == 0
    assert money.buy_cost(i.size, i.limit_price, FEE) <= D("15")
    assert i.size == money.buy_size_for_quote(D("15"), lv[0], FEE, SPEC)
    # The proceeds (100 USDC) would have bought a much larger lot.
    assert i.size < money.buy_size_for_quote(D("100"), lv[0], FEE, SPEC)


# ---------------------------------------------------------------- pauses / skips


def test_range_exit_pause():
    lv = levels()
    lo, hi = money.range_bounds(lv, D("2.5"))
    f = filled_at(lv, "cb-b1-B--1-000000000005", money.BUY, -1, D("10"))

    below = snap(low=lo - D("0.0010"), high=hi - D("0.0010"))
    d = GridStrategy().decide(below, view(pending=[f]))
    assert d.intents == []
    assert d.pause_reason is not None and "lower" in d.pause_reason
    assert d.skipped_fills == []

    above = snap(low=lo + D("0.0010"), high=hi + D("0.0010"))
    d2 = GridStrategy().decide(above, view(pending=[f]))
    assert d2.intents == []
    assert d2.pause_reason is not None and "upper" in d2.pause_reason
    assert d2.skipped_fills == []

    # The same view without the range exit does place the opposite order.
    inside = GridStrategy().decide(snap(), view(pending=[f]))
    assert inside.pause_reason is None
    assert [i.level for i in inside.intents] == [0]


def test_occupied_level_waits_not_skipped():
    lv = levels()
    f = filled_at(lv, "cb-b1-B--1-000000000006", money.BUY, -1, D("10"))
    busy = order("cb-b1-S-0-000000000010", money.SELL, 0, lv[0], D("10"))

    d = GridStrategy().decide(snap(), view(pending=[f], open_orders=[busy]))
    assert d.intents == []
    assert f["client_order_id"] not in d.skipped_fills

    # PENDING_SUBMIT holds the level just the same: the order may still land.
    pending_submit = dict(busy, status="PENDING_SUBMIT")
    d2 = GridStrategy().decide(
        snap(), view(pending=[f], open_orders=[pending_submit])
    )
    assert d2.intents == []
    assert f["client_order_id"] not in d2.skipped_fills

    # A dead order at that level does not hold it.
    dead = dict(busy, status="CANCELLED")
    d3 = GridStrategy().decide(snap(), view(pending=[f], open_orders=[dead]))
    assert [i.level for i in d3.intents] == [0]

    # No order at the level at all: the opposite order appears.
    d4 = GridStrategy().decide(snap(), view(pending=[f]))
    assert [i.level for i in d4.intents] == [0]

    # Two fills wanting the same target level in one call: only the first is
    # placed, the second is neither placed nor skipped.
    first = filled_at(lv, "cb-b1-B--1-000000000006", money.BUY, -1, D("10"))
    second = filled_at(lv, "cb-b1-B--1-000000000007", money.BUY, -1, D("5"))
    d5 = GridStrategy().decide(snap(), view(pending=[first, second]))
    assert len(d5.intents) == 1
    assert d5.intents[0].consumes_fill == first["client_order_id"]
    assert second["client_order_id"] not in d5.skipped_fills
    assert d5.skipped_fills == []


def test_off_grid_fill_is_skipped():
    lv = levels()

    top = filled_at(lv, "cb-b1-B-3-000000000011", money.BUY, 3, D("10"))
    d = GridStrategy().decide(snap(), view(pending=[top]))
    assert d.intents == []
    assert top["client_order_id"] in d.skipped_fills

    bottom = filled_at(lv, "cb-b1-S--3-000000000012", money.SELL, -3, D("10"))
    d2 = GridStrategy().decide(snap(), view(pending=[bottom]))
    assert d2.intents == []
    assert bottom["client_order_id"] in d2.skipped_fills

    # Skipping one fill does not stop a later one from being answered.
    both = GridStrategy().decide(snap(), view(pending=[top, bottom]))
    assert both.skipped_fills == [
        top["client_order_id"],
        bottom["client_order_id"],
    ]
    assert both.intents == []


def test_too_small_fill_is_skipped():
    lv = levels()
    f = filled_at(lv, "cb-b1-B--1-000000000013", money.BUY, -1, D("0.5"))

    d = GridStrategy().decide(snap(), view(pending=[f]))

    # 0.5 XRP at the level-0 price is 0.48 USDC, under the 1 USDC quote minimum.
    assert money.too_small(D("0.5"), lv[0], SPEC) is not None
    assert d.intents == []
    assert f["client_order_id"] in d.skipped_fills


# ---------------------------------------------------------------- params


def test_fee_guard_refuses_tight_step():
    strat = GridStrategy()

    why = strat.fee_guard(params(step_pct="1.4"), D("0.5"))
    assert why is not None
    assert "1.4" in why
    assert "1.5" in why  # 2 * maker 0.5% + 0.5% margin

    assert strat.fee_guard(params(step_pct="1.5"), D("0.5")) is None
    assert strat.fee_guard(params(step_pct="2.5"), D("0.5")) is None
    # A dearer maker fee needs a wider step.
    assert strat.fee_guard(params(step_pct="2.5"), D("1.5")) is not None


def _missing_center() -> dict:
    return {k: v for k, v in params().items() if k != "center"}


VALIDATE_CASES = [
    ("missing_center", _missing_center(), True),
    ("center_zero", params(center="0"), True),
    ("step_pct_zero", params(step_pct="0"), True),
    ("levels_below_zero", params(levels_below=0), True),
    ("levels_above_zero", params(levels_above=0), True),
    ("quote_per_buy_zero", params(quote_per_buy="0"), True),
    ("rebuy_sizing_bogus", params(rebuy_sizing="bogus"), True),
    ("center_unparseable", params(center="abc"), True),
    ("good_strings", params(), False),
    (
        "good_int_and_float",
        {
            "center": 1,
            "step_pct": 2.5,
            "levels_below": 3,
            "levels_above": 3,
            "quote_per_buy": 15,
            "rebuy_sizing": "proceeds",
        },
        False,
    ),
    (
        "good_float_and_fixed",
        {
            "center": 0.9645,
            "step_pct": "2.5",
            "levels_below": 3,
            "levels_above": 3,
            "quote_per_buy": 15.0,
            "rebuy_sizing": "fixed",
        },
        False,
    ),
]


@pytest.mark.parametrize(
    "case,p,raises", VALIDATE_CASES, ids=[c[0] for c in VALIDATE_CASES]
)
def test_validate_rejects_bad_params(case, p, raises):
    strat = GridStrategy()
    if raises:
        with pytest.raises(ValueError):
            strat.validate(p)
    else:
        strat.validate(p)  # accepted: no exception


def test_recenter_returns_new_params():
    strat = GridStrategy()
    p = params()
    before = dict(p)

    out = strat.recenter(p, "1.0234")

    assert isinstance(out, dict)
    assert out is not p
    assert set(out) == set(before)
    assert D(str(out["center"])) == D("1.0234")
    assert {k: v for k, v in out.items() if k != "center"} == {
        k: v for k, v in before.items() if k != "center"
    }
    assert p == before  # the input dict was not touched

    # A Decimal center works too, and keeps working on the same params.
    from_decimal = strat.recenter(p, D("1.0234"))
    assert D(str(from_decimal["center"])) == D("1.0234")
    assert p == before

    with pytest.raises(ValueError):
        strat.recenter(p, "0")
    with pytest.raises(ValueError):
        strat.recenter(p, D("0"))
    assert p == before


# ---------------------------------------------------------------- purity


def test_decide_is_pure():
    lv = levels()
    f = filled_at(lv, "cb-b1-B--1-000000000015", money.BUY, -1, D("10"))
    open_row = order("cb-b1-S-2-000000000016", money.SELL, 2, lv[2], D("5"))
    v = view(pending=[f], open_orders=[open_row], hold=holding("45", "60"))
    s = snap()

    pending_before = copy.deepcopy(v.pending_fills)
    orders_before = copy.deepcopy(v.open_orders)
    params_before = copy.deepcopy(v.params)

    first = GridStrategy().decide(s, v)
    second = GridStrategy().decide(s, v)

    assert first == second
    assert [(i.action, i.side, i.level) for i in first.intents] == [
        ("place", money.SELL, 0)
    ]
    assert v.pending_fills == pending_before
    assert v.open_orders == orders_before
    assert v.params == params_before
    assert len(v.pending_fills) == 1
    assert len(v.open_orders) == 1