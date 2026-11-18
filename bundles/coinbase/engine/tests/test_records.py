"""records.py: the trades.csv columns, one row per fill, and its duplicate guard.

Every test writes a real file in a temporary directory and reads it back as CSV.
Money is `Decimal`; the row values are asserted as the decimal strings the file
carries.  The module-level id cache is cleared around every test, because two
tests may reach the same path string.
"""

from __future__ import annotations

import csv
from decimal import Decimal as D
from pathlib import Path

import pytest

from crow_coinbase import records

# The tax column set, written out here so a reordering of records.COLUMNS is a
# failure rather than something the test follows along with.
TAX_COLUMNS = [
    "timestamp_utc",
    "product",
    "base_currency",
    "quote_currency",
    "side",
    "trade_type",
    "base_size",
    "price",
    "fee",
    "gross_quote",
    "net_quote",
    "trade_id",
    "order_id",
    "client_order_id",
    "mode",
]

# The pair-specific column names this file used to carry.
LEGACY_COLUMNS = ["qty_xrp", "price_usdc", "fee_usdc", "usd_value", "net_usdc"]


def fill(**over) -> dict:
    """One normalised exchange fill, BUY 10 XRP at 1.0 USDC with a 0.05 fee."""
    base = {
        "trade_id": "t-1",
        "order_id": "ex-1",
        "side": "BUY",
        "size": D("10"),
        "price": D("1.0"),
        "commission": D("0.05"),
        "trade_time": "2026-01-01T00:00:00Z",
        "trade_type": "FILL",
    }
    base.update(over)
    return base


def table(path: Path) -> list[list[str]]:
    with open(path, newline="") as fh:
        return list(csv.reader(fh))


def rows_by_name(path: Path) -> list[dict[str, str]]:
    """Every data row as {column: value}, so a test names the column it means."""
    table_rows = table(path)
    header = table_rows[0]
    return [dict(zip(header, row)) for row in table_rows[1:]]


@pytest.fixture(autouse=True)
def clear_cache():
    records.reset_cache()
    yield
    records.reset_cache()


@pytest.fixture
def path(tmp_path):
    return tmp_path / "trades.csv"


# ---------------------------------------------------------------- columns


def test_header_is_the_tax_column_set(path):
    assert records.COLUMNS == TAX_COLUMNS
    assert records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry") is True
    assert table(path)[0] == TAX_COLUMNS


def test_legacy_pair_specific_columns_are_gone():
    """No column is named after one product's base or quote currency."""
    for legacy in LEGACY_COLUMNS:
        assert legacy not in records.COLUMNS


# ---------------------------------------------------------------- rows


def test_buy_row(path):
    records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry")

    assert rows_by_name(path) == [
        {
            "timestamp_utc": "2026-01-01T00:00:00Z",
            "product": "XRP-USDC",
            "base_currency": "XRP",
            "quote_currency": "USDC",
            "side": "BUY",
            "trade_type": "FILL",
            "base_size": "10",
            "price": "1.0",
            "fee": "0.05000000",
            "gross_quote": "10.00000000",
            # a buy paid: gross plus the fee, negative
            "net_quote": "-10.05000000",
            "trade_id": "t-1",
            "order_id": "ex-1",
            "client_order_id": "cb-b1-B+1-0",
            "mode": "dry",
        }
    ]


def test_sell_row(path):
    records.append_fill(
        path,
        "XRP-USDC",
        fill(trade_id="t-2", side="SELL", size=D("10"), price=D("1.5"), commission=D("0.07")),
        "cb-b1-S+2-0",
        "dry",
    )

    row = rows_by_name(path)[0]
    assert row["side"] == "SELL"
    assert row["gross_quote"] == "15.00000000"
    assert row["fee"] == "0.07000000"
    # a sell received: gross less the fee, positive
    assert row["net_quote"] == "14.93000000"


def test_correction_trade_type_is_kept(path):
    records.append_fill(
        path,
        "XRP-USDC",
        fill(trade_id="t-fix", trade_type="CORRECTION"),
        "cb-b1-B+1-0",
        "dry",
    )

    assert rows_by_name(path)[0]["trade_type"] == "CORRECTION"


def test_absent_trade_type_is_a_fill(path):
    """A fill carrying no trade type (or a null one) is an ordinary fill."""
    missing = fill(trade_id="t-missing")
    missing.pop("trade_type")
    records.append_fill(path, "XRP-USDC", missing, "cb-b1-B+1-0", "dry")
    records.append_fill(
        path, "XRP-USDC", fill(trade_id="t-null", trade_type=None), "cb-b1-B+2-0", "dry"
    )

    assert [row["trade_type"] for row in rows_by_name(path)] == ["FILL", "FILL"]


def test_btc_usdc_product_splits(path):
    records.append_fill(
        path,
        "BTC-USDC",
        fill(trade_id="t-btc", size=D("0.5"), price=D("60000"), commission=D("30")),
        "cb-b1-B+1-0",
        "dry",
    )

    row = rows_by_name(path)[0]
    assert row["base_currency"] == "BTC"
    assert row["quote_currency"] == "USDC"
    assert row["base_size"] == "0.5"
    assert row["gross_quote"] == "30000.00000000"
    assert row["net_quote"] == "-30030.00000000"


# ---------------------------------------------------------------- duplicates


def test_append_fill_refuses_a_trade_id_already_in_the_file(path):
    assert records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry") is True
    assert records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry") is False

    assert len(table(path)) == 2  # the header and one row


def test_append_fill_refuses_a_trade_id_already_in_an_existing_file(path):
    """A file written by an earlier process holds ids this one has not seen yet."""
    with open(path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(records.COLUMNS)
        writer.writerow(
            ["2025-12-31T00:00:00Z", "XRP-USDC", "XRP", "USDC", "SELL", "FILL",
             "10", "1.0", "0.00000000", "10.00000000", "10.00000000", "t-1",
             "ex-1", "cb-b1-S+1-0", "dry"]
        )

    assert records.has_trade(path, "t-1") is True
    assert records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry") is False
    assert len(table(path)) == 2


def test_has_trade_reads_the_column_by_header_name(tmp_path):
    """A file whose trade_id column sits somewhere else still answers correctly."""
    moved = tmp_path / "moved.csv"
    with open(moved, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["note", "trade_id", "mode"])
        writer.writerow(["a fill", "t-moved", "dry"])

    assert records.has_trade(moved, "t-moved") is True
    assert records.has_trade(moved, "t-other") is False


def test_has_trade_of_a_missing_file_is_false(tmp_path):
    assert records.has_trade(tmp_path / "nothing.csv", "t-1") is False


def test_reset_cache_rereads_the_file(path):
    """A file replaced behind the cache is read again after `reset_cache`."""
    records.append_fill(path, "XRP-USDC", fill(), "cb-b1-B+1-0", "dry")
    assert records.has_trade(path, "t-1") is True

    path.unlink()
    records.append_fill(path, "XRP-USDC", fill(trade_id="t-9"), "cb-b1-B+2-0", "dry")
    assert records.has_trade(path, "t-1") is True  # still what the cache holds

    records.reset_cache()
    assert records.has_trade(path, "t-1") is False
    assert records.has_trade(path, "t-9") is True