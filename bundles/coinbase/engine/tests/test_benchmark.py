"""benchmark.py: the hold-the-starting-mix shadow value.

The benchmark is a kv record on the real Store (`store.get` / `store.put` only),
so these tests use a Store in tmp_path and reopen its file to check persistence.
"""

from __future__ import annotations

from decimal import Decimal as D

import pytest

from crow_coinbase.benchmark import Benchmark
from crow_coinbase.store import Store

OWNER = "b1"
BASE = D("60")
QUOTE = D("45")
PRICE = D("0.9645")


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "s.db")
    yield s
    s.close()


def started(store) -> Benchmark:
    b = Benchmark(store)
    b.start(OWNER, BASE, QUOTE, PRICE)
    return b


def test_vs_hold_zero_at_start(store):
    b = started(store)

    equity = BASE * PRICE + QUOTE
    assert b.value(OWNER, PRICE) == equity
    assert b.vs_hold(OWNER, equity, PRICE) == D("0")
    assert isinstance(b.value(OWNER, PRICE), D)
    assert isinstance(b.vs_hold(OWNER, equity, PRICE), D)


def test_vs_hold_tracks_price(store):
    b = started(store)
    up = PRICE * D("1.1")  # +10%

    # Equity frozen at the starting mix while the price rises: we lost the
    # gains the starting base would have made.
    frozen = BASE * PRICE + QUOTE
    assert b.vs_hold(OWNER, frozen, up) == -(BASE * PRICE * D("0.1"))
    assert b.vs_hold(OWNER, frozen, up) < D("0")

    # Equity that grew exactly with the hold is level with it.
    assert b.value(OWNER, up) == BASE * up + QUOTE
    assert b.vs_hold(OWNER, b.value(OWNER, up), up) == D("0")

    # A plain quote-only mix is worth more than the shadow once the price falls.
    down = PRICE * D("0.9")
    assert b.vs_hold(OWNER, frozen, down) == BASE * PRICE * D("0.1")
    assert b.vs_hold(OWNER, frozen, down) == -(BASE * down + QUOTE - frozen)


def test_start_is_idempotent(store):
    b = started(store)

    b.start(OWNER, D("999"), D("999"), D("999"))

    assert b.value(OWNER, D("2")) == BASE * D("2") + QUOTE
    assert b.vs_hold(OWNER, D("0"), D("2")) == -(BASE * D("2") + QUOTE)

    # Another owner starts with its own mix under its own key.
    b.start("b2", D("1"), D("2"), D("3"))
    assert b.value("b2", D("3")) == D("1") * D("3") + D("2")
    assert b.value(OWNER, D("2")) == BASE * D("2") + QUOTE


def test_value_unstarted_raises_keyerror(store):
    b = Benchmark(store)

    with pytest.raises(KeyError):
        b.value("nobody", PRICE)
    with pytest.raises(KeyError):
        b.vs_hold("nobody", D("100"), PRICE)

    # Nothing was written for the owner that was never started.
    assert store.get("benchmark:nobody") is None


def test_benchmark_persists_across_store_reopen(tmp_path):
    path = tmp_path / "s.db"

    first = Store(path)
    try:
        Benchmark(first).start(OWNER, BASE, QUOTE, PRICE)
    finally:
        first.close()

    second = Store(path)
    try:
        reopened = Benchmark(second)
        price = D("1.0000")
        assert reopened.value(OWNER, price) == BASE * price + QUOTE
        assert reopened.vs_hold(OWNER, D("100"), price) == D("100") - (
            BASE * price + QUOTE
        )
        # The restart keeps the original mix, so a later start changes nothing.
        reopened.start(OWNER, D("999"), D("999"), D("999"))
        assert reopened.value(OWNER, price) == BASE * price + QUOTE
    finally:
        second.close()