"""Latest market snapshot per product, plus the measured clock skew.

The poller writes on its own thread while the strategy loop reads on another, so
every access takes the same lock.  A product with no snapshot yet reads as None,
and the skew reads as None until the first `set_clock` — both are "unknown", and
the gateway refuses an order on either rather than guessing.

The skew also goes back to unknown once its measurement is older than two poll
windows: a skew read an hour ago is not evidence about the clock now, so it has
to be re-measured instead of being trusted forever.  Both the poll interval and
the clock are injected, so the expiry can be exercised without waiting.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Optional

from .limits import DEFAULT_POLL_SECONDS
from .strategies.base import MarketSnapshot

# A skew measurement is trusted for this many poll windows.
SKEW_WINDOWS = 2


class SnapshotCache:
    """Thread-safe `{product: MarketSnapshot}`, latest put wins, plus the skew."""

    def __init__(
        self,
        poll_seconds: int = DEFAULT_POLL_SECONDS,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.poll_seconds = poll_seconds
        self._now = now
        self._lock = threading.Lock()
        self._snapshots: dict[str, MarketSnapshot] = {}
        self._skew_s: Optional[float] = None
        self._measured_at: Optional[float] = None

    def put(self, snap: MarketSnapshot) -> None:
        """Store *snap* under its product, replacing any older one."""
        with self._lock:
            self._snapshots[snap.product] = snap

    def get(self, product: str) -> Optional[MarketSnapshot]:
        """The latest snapshot for *product*, or None when there is none."""
        with self._lock:
            return self._snapshots.get(product)

    def set_clock(self, server_ts: float, local_ts: float) -> None:
        """Record `server_ts - local_ts` as the skew, measured at `now()`."""
        measured_at = self._now()
        with self._lock:
            self._skew_s = server_ts - local_ts
            self._measured_at = measured_at

    def skew_s(self) -> Optional[float]:
        """The last measured skew, or None while it is unknown or out of date."""
        at = self._now()
        with self._lock:
            if self._skew_s is None or self._measured_at is None:
                return None
            if at - self._measured_at > SKEW_WINDOWS * self.poll_seconds:
                return None
            return self._skew_s