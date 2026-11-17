"""trades.csv — one row per fill, for tax records (each sell is a taxable event)."""

from __future__ import annotations

import csv
from decimal import Decimal
from pathlib import Path

COLUMNS = [
    "timestamp_utc",
    "product",
    "side",
    "qty_xrp",
    "price_usdc",
    "fee_usdc",
    "usd_value",
    "net_usdc",
    "trade_id",
    "order_id",
    "client_order_id",
    "mode",
]


def append_fill(path: Path, product: str, fill: dict, cid: str, mode: str) -> None:
    size, price, fee = (
        Decimal(fill["size"]),
        Decimal(fill["price"]),
        Decimal(fill["commission"]),
    )
    value = size * price
    # net cash effect in USDC: buys cost value+fee, sells yield value-fee
    net = -(value + fee) if fill["side"] == "BUY" else value - fee
    new = not path.exists()
    with open(path, "a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(COLUMNS)
        w.writerow(
            [
                fill["trade_time"],
                product,
                fill["side"],
                f"{size:f}",
                f"{price:f}",
                f"{fee:.8f}",
                f"{value:.8f}",
                f"{net:.8f}",
                fill["trade_id"],
                fill["order_id"],
                cid,
                mode,
            ]
        )
