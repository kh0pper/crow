"""Latest market snapshot per product, plus the measured clock skew.

The poller writes on its own thread while the strategy loop reads on another, so
every access takes the same lock.  A product with no snapshot yet reads as None,
and the skew reads as None until the first `set_clock` — both are "unknown", and
the gateway refuses an order on either rather than guessing.
"""

from __future__ import annotations

import threading
from typing import Optional

from .strategies.base import MarketSnapshot


class SnapshotCache:
    """Thread-safe `{product: MarketSnapshot}`, latest put wins, plus the skew."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshots: dict[str, MarketSnapshot] = {}
        self._skew_s: Optional[float] = None

    def put(self, snap: MarketSnapshot) -> None:
        """Store *snap* under its product, replacing any older one."""
        with self._lock:
            self._snapshots[snap.product] = snap

    def get(self, product: str) -> Optional[MarketSnapshot]:
        """The latest snapshot for *product*, or None when there is none."""
        with self._lock:
            return self._snapshots.get(product)

    def set_clock(self, server_ts: float, local_ts: float) -> None:
        """Record `server_ts - local_ts` as the clock skew (seconds)."""
        with self._lock:
            self._skew_s = server_ts - local_ts

    def skew_s(self) -> Optional[float]:
        """The last measured skew, or None while the clock is still unknown."""
        with self._lock:
            return self._skew_s