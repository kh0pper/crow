from decimal import Decimal as D

import pytest

from crow_coinbase import money as G

SPEC = G.ProductSpec(
    "XRP-USDC", D("0.0001"), D("0.000001"), D("0.0001"), D("0.000001"), D("1")
)
FEE = D("0.005")


def test_levels_geometric_and_rounded_to_tick():
    lv = G.build_levels(D("0.9645"), D("2.5"), 3, 3, SPEC)
    assert sorted(lv) == [-3, -2, -1, 0, 1, 2, 3]
    assert lv[0] == D("0.9645")
    assert lv[1] == D("0.9886")  # 0.9645*1.025 = 0.98861 -> 0.9886
    assert lv[-1] == D("0.9410")  # 0.9645/1.025 = 0.94098 -> 0.9410
    assert lv[3] == D("1.0387")  # 0.9645*1.025^3 = 1.03866
    for p in lv.values():
        assert p % SPEC.price_increment == 0
    # consecutive ratios ~= 1.025
    for i in range(-3, 3):
        assert abs(lv[i + 1] / lv[i] - D("1.025")) < D("0.0002")


def test_levels_reject_collapse():
    with pytest.raises(ValueError):
        G.build_levels(
            D("0.001"), D("2.5"), 3, 3, SPEC
        )  # tick 0.0001 can't resolve 2.5% of 0.001


@pytest.mark.parametrize(
    "step,ok", [("2.5", True), ("1.5", True), ("1.49", False), ("0.5", False)]
)
def test_fee_guard(step, ok):
    passed, req = G.fee_guard(D(step), D("0.5"), D("0.5"))
    assert req == D("1.5")
    assert passed is ok


def test_range_bounds_one_step_outside():
    lv = G.build_levels(D("1"), D("2.5"), 3, 3, SPEC)
    lo, hi = G.range_bounds(lv, D("2.5"))
    assert lo == lv[-3] / D("1.025")
    assert hi == lv[3] * D("1.025")
    assert G.out_of_range(lo + D("0.0001"), hi - D("0.0001"), (lo, hi)) is None
    assert "lower" in G.out_of_range(lo - D("0.0001"), hi - 1, (lo, hi))
    assert "upper" in G.out_of_range(lo + 1, hi + D("0.0001"), (lo, hi))


def test_buy_size_never_exceeds_quote_incl_fee():
    for price in (D("0.9410"), D("0.9180"), D("0.8956"), D("1.2345")):
        size = G.buy_size_for_quote(D("15"), price, FEE, SPEC)
        assert G.buy_cost(size, price, FEE) <= D("15")
        assert G.buy_cost(size + SPEC.base_increment, price, FEE) > D(
            "15"
        )  # largest such size
        assert size % SPEC.base_increment == 0


def test_too_small():
    assert G.too_small(D("0"), D("1"), SPEC)
    assert "quote_min" in G.too_small(D("0.9"), D("1"), SPEC)
    assert G.too_small(D("1.1"), D("1"), SPEC) is None


def test_plan_initial_respects_budget_and_splits_xrp():
    lv = G.build_levels(D("0.9645"), D("2.5"), 3, 3, SPEC)
    orders, skipped = G.plan_initial(
        lv, D("15"), D("45"), D("43.834672"), None, FEE, SPEC
    )
    buys = [o for o in orders if o.side == G.BUY]
    sells = [o for o in orders if o.side == G.SELL]
    assert [o.level for o in buys] == [-1, -2, -3]
    assert [o.level for o in sells] == [1, 2, 3]
    assert sum(G.buy_cost(o.size, o.price, FEE) for o in buys) <= D("45")
    assert all(o.size == D("14.611557") for o in sells)
    assert sum(o.size for o in sells) <= D("43.834672")
    assert not skipped


def test_plan_initial_skips_when_budget_runs_out():
    lv = G.build_levels(D("1"), D("2.5"), 3, 3, SPEC)
    orders, skipped = G.plan_initial(lv, D("15"), D("15.5"), D("30"), None, FEE, SPEC)
    buys = [o for o in orders if o.side == G.BUY]
    assert len(buys) == 1  # 15 used, 0.5 left < 1 USDC min
    assert {s.level for s in skipped} == {-2, -3}


def test_opposite_after_buy_is_sell_one_up_same_qty():
    lv = G.build_levels(D("1"), D("2.5"), 3, 3, SPEC)
    o, why = G.opposite_order(G.BUY, -1, D("15.123456"), D(0), lv, FEE, SPEC)
    assert (
        why is None and o.side == G.SELL and o.level == 0 and o.size == D("15.123456")
    )


def test_opposite_after_sell_proceeds_vs_fixed():
    lv = G.build_levels(D("1"), D("2.5"), 3, 3, SPEC)
    o, _ = G.opposite_order(G.SELL, 1, D("14"), D("14.2"), lv, FEE, SPEC, "proceeds")
    assert o.side == G.BUY and o.level == 0
    assert G.buy_cost(o.size, o.price, FEE) <= D("14.2")
    o2, _ = G.opposite_order(
        G.SELL, 1, D("14"), D("14.2"), lv, FEE, SPEC, "fixed", D("10")
    )
    assert (
        G.buy_cost(o2.size, o2.price, FEE) <= D("10") < G.buy_cost(o.size, o.price, FEE)
    )


def test_opposite_off_the_grid_or_too_small():
    lv = G.build_levels(D("1"), D("2.5"), 3, 3, SPEC)
    assert G.opposite_order(G.BUY, 3, D("10"), D(0), lv, FEE, SPEC)[0] is None
    assert G.opposite_order(G.SELL, -3, D("10"), D("10"), lv, FEE, SPEC)[0] is None
    o, why = G.opposite_order(G.BUY, -1, D("0.5"), D(0), lv, FEE, SPEC)
    assert o is None and "quote_min" in why


def test_maker_price_never_crosses_and_reprice_moves_away():
    t = D("0.0001")
    # buy level above the ask -> rest one tick under the ask (a better price than the level)
    assert G.maker_price(G.BUY, D("1.0"), D("0.9"), D("0.95"), t) == D("0.9499")
    assert G.maker_price(G.BUY, D("0.9"), D("0.91"), D("0.92"), t) == D("0.9")
    assert G.maker_price(G.SELL, D("0.9"), D("0.95"), D("0.96"), t) == D("0.9501")
    assert G.maker_price(G.SELL, D("1.0"), D("0.95"), D("0.96"), t) == D("1.0")
    assert G.reprice_away(G.BUY, D("0.95"), t) == D("0.9499")
    assert G.reprice_away(G.SELL, D("0.95"), t) == D("0.9501")


def test_round_trip_profit_is_positive_at_2_5pct():
    lv = G.build_levels(D("0.9645"), D("2.5"), 3, 3, SPEC)
    size = G.buy_size_for_quote(D("15"), lv[-1], FEE, SPEC)
    cost = G.buy_cost(size, lv[-1], FEE)
    profit = G.realized_on_sell(size, G.sell_net(size, lv[0], FEE), cost / size)
    assert D("0.2") < profit < D("0.25")  # ~2.5% - 1% fees on ~15 USDC

