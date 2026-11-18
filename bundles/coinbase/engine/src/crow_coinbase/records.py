"""trades.csv — one row per fill, in neutral base/quote columns.

The file is a convenience copy of the fills the engine booked, written as each
fill is booked.  The authoritative tax export is `/export/fills.csv`, which is
built from the database with one row per booked fill; this file is written
before the database row and can in principle lag behind the table.

`trade_id` is unique per row: a trade already in the file is never appended
twice, and the ids are read once per path and then kept in memory.
"""

from __future__ import annotations

import csv
import threading
from decimal import Decimal
from pathlib import Path

COLUMNS = [
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

# A fill whose `trade_type` is absent or null is an ordinary fill.
DEFAULT_TRADE_TYPE = "FILL"

# The trade ids already in one file, by resolved path.  Loaded on first use so a
# cycle does not re-read a file that only grows.  Re-entrant, because a caller may
# hold it across `_ids_of` and the write that follows.
_CACHE: dict[str, set[str]] = {}
_LOCK = threading.RLock()


# ---------------------------------------------------------------- trade ids


def _key(path: Path | str) -> str:
    """The cache key for *path*: its resolved name, so aliases share one entry."""
    return str(Path(path).resolve())


def _ids_of(path: Path | str) -> set[str]:
    """The cached trade ids of *path*, read from the file the first time."""
    key = _key(path)
    with _LOCK:
        known = _CACHE.get(key)
        if known is None:
            known = _read_ids(Path(path))
            _CACHE[key] = known
        return known


def _read_ids(path: Path) -> set[str]:
    """The `trade_id` column of an existing file, by header name; empty when absent.

    Read by header name rather than by position, so a file written with the
    column somewhere else still answers correctly.  A file with no header and no
    `trade_id` column holds no ids this module can trust.
    """
    ids: set[str] = set()
    if not path.exists():
        return ids
    with open(path, newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header is None or "trade_id" not in header:
            return ids
        index = header.index("trade_id")
        for row in reader:
            if index < len(row):
                ids.add(row[index])
    return ids


def has_trade(path: Path | str, trade_id: str) -> bool:
    """Whether *path* already holds a row for *trade_id*."""
    return str(trade_id) in _ids_of(path)


def forget(path: Path | str) -> None:
    """Drop one path's cached ids: a scratch file that will not be read again."""
    with _LOCK:
        _CACHE.pop(_key(path), None)


def reset_cache() -> None:
    """Drop every cached id set, so the next call reads each file again."""
    with _LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------- rows


def split_product(product: str) -> tuple[str, str]:
    """The base and the quote of a product id: `XRP-USDC` -> `("XRP", "USDC")`."""
    base, _, quote = str(product).partition("-")
    return base, quote


def trade_type_of(fill: dict) -> str:
    """The fill's own trade type, or `FILL` when it carries none."""
    return str(fill.get("trade_type") or DEFAULT_TRADE_TYPE)


def append_fill(
    path: Path, product: str, fill: dict, cid: str, mode: str
) -> bool:
    """Append one fill to *path*; a trade id the file already holds is not written.

    Returns True when a row was written and False when the file already had that
    trade id.  The id check and the write are one step under the module lock, so
    two callers cannot both append the same trade.  The quote columns are in the
    product's quote currency: `fee` is the commission, `gross_quote` is
    size * price, and `net_quote` is the cash the fill moved — negative for a buy
    (it paid) and positive for a sell (it was paid), each net of the fee.
    """
    trade_id = str(fill["trade_id"])
    with _LOCK:
        known = _ids_of(path)
        if trade_id in known:
            return False
        size, price, fee = (
            Decimal(fill["size"]),
            Decimal(fill["price"]),
            Decimal(fill["commission"]),
        )
        gross = size * price
        net = -(gross + fee) if fill["side"] == "BUY" else gross - fee
        base, quote = split_product(product)
        new = not path.exists()
        with open(path, "a", newline="") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(COLUMNS)
            w.writerow(
                [
                    fill["trade_time"],
                    product,
                    base,
                    quote,
                    fill["side"],
                    trade_type_of(fill),
                    f"{size:f}",
                    f"{price:f}",
                    f"{fee:.8f}",
                    f"{gross:.8f}",
                    f"{net:.8f}",
                    trade_id,
                    fill["order_id"],
                    cid,
                    mode,
                ]
            )
        known.add(trade_id)
    return True