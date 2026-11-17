"""Exchange adapters.

LiveExchange  - Coinbase Advanced Trade via the official coinbase-advanced-py SDK.
DryRunExchange - same interface, simulated order book; fills are driven by live
                 public 1-minute candles. Never sends an authenticated write.

Normalized order dict: order_id, client_order_id, side, status, price, size,
                       filled_size, filled_value, total_fees
Normalized fill dict:  trade_id, order_id, side, size, price, commission, trade_time
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Optional

import requests

from .money import BUY, SELL, ProductSpec

log = logging.getLogger("crow_coinbase.exchange")
D = Decimal


class TransientError(Exception):
    """Network/timeout/5xx/429: outcome unknown, safe to retry reads."""


class PermanentError(Exception):
    """4xx etc: retrying will not help."""


class ProductUnavailable(Exception):
    pass


def classify(exc: Exception) -> Exception:
    if isinstance(exc, (TransientError, PermanentError)):
        return exc
    if isinstance(
        exc, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)
    ):
        return TransientError(type(exc).__name__)
    if isinstance(exc, requests.exceptions.HTTPError):
        code = getattr(exc.response, "status_code", None)
        if code is None or code == 429 or code >= 500:
            return TransientError(f"HTTP {code}")
        return PermanentError(f"HTTP {code}: {str(exc)[:200]}")
    return exc


def with_retry(
    fn: Callable,
    what: str,
    attempts: int = 5,
    base_delay: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
):
    """Retry *idempotent* calls on transient errors with exponential backoff."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            err = classify(e)
            if not isinstance(err, TransientError) or i == attempts - 1:
                raise err from e
            delay = min(base_delay * 2**i, 30)
            log.warning(
                "%s failed (%s); retry %d/%d in %.0fs",
                what,
                err,
                i + 1,
                attempts - 1,
                delay,
            )
            sleep(delay)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm_order(o: dict) -> dict:
    cfg = o.get("order_configuration") or {}
    lim = cfg.get("limit_limit_gtc") or cfg.get("limit_limit_gtd") or {}
    return {
        "order_id": o.get("order_id"),
        "client_order_id": o.get("client_order_id") or "",
        "side": o.get("side"),
        "status": o.get("status"),
        "price": D(str(lim.get("limit_price") or o.get("average_filled_price") or "0")),
        "size": D(str(lim.get("base_size") or "0")),
        "filled_size": D(str(o.get("filled_size") or "0")),
        "filled_value": D(str(o.get("filled_value") or "0")),
        "total_fees": D(str(o.get("total_fees") or "0")),
    }


def _norm_fill(f: dict) -> dict:
    size, price = D(str(f["size"])), D(str(f["price"]))
    if f.get("size_in_quote"):
        size = size / price
    return {
        "trade_id": f["trade_id"],
        "order_id": f["order_id"],
        "side": f["side"],
        "size": size,
        "price": price,
        "commission": D(str(f.get("commission") or "0")),
        "trade_time": f["trade_time"],
        "trade_type": f.get("trade_type", "FILL"),
    }


class MarketData:
    """Public, unauthenticated market data (used by both live and dry-run)."""

    def __init__(self, product_id: str, client=None, sleep=time.sleep):
        from coinbase.rest import RESTClient

        self.pid = product_id
        self.pub = client or RESTClient(api_key=None, api_secret=None)
        self.sleep = sleep

    def product(self) -> tuple[ProductSpec, dict]:
        try:
            p = with_retry(
                lambda: self.pub.get_public_product(self.pid).to_dict(),
                "get_product",
                sleep=self.sleep,
            )
        except PermanentError as e:
            raise ProductUnavailable(
                f"{self.pid} not found or not accessible via the API ({e}). "
                f"Not switching to another product."
            )
        if p.get("product_id") != self.pid:
            raise ProductUnavailable(f"{self.pid} not returned by API")
        problems = [
            k for k in ("trading_disabled", "cancel_only", "is_disabled") if p.get(k)
        ]
        if p.get("status") != "online":
            problems.append(f"status={p.get('status')}")
        if problems:
            raise ProductUnavailable(f"{self.pid} not tradable: {', '.join(problems)}")
        return ProductSpec.from_api(p), p

    def best_bid_ask(self) -> tuple[Decimal, Decimal]:
        b = with_retry(
            lambda: self.pub.get_public_product_book(self.pid, limit=1).to_dict(),
            "book",
            sleep=self.sleep,
        )["pricebook"]
        return D(b["bids"][0]["price"]), D(b["asks"][0]["price"])

    def candles(self, start: float, end: float) -> list[dict]:
        """1-minute candles in [start, end], oldest first."""
        start = max(start, end - 300 * 60)  # API returns at most 350 candles
        r = with_retry(
            lambda: self.pub.get_public_candles(
                self.pid,
                start=str(int(start)),
                end=str(int(end)),
                granularity="ONE_MINUTE",
            ).to_dict(),
            "candles",
            sleep=self.sleep,
        )
        out = [
            {"start": int(c["start"]), "low": D(c["low"]), "high": D(c["high"])}
            for c in r.get("candles", [])
        ]
        return sorted(out, key=lambda c: c["start"])

    def range_since(self, since: float) -> tuple[Decimal, Decimal]:
        bid, ask = self.best_bid_ask()
        lo, hi = bid, ask
        for c in self.candles(since - 60, time.time()):
            lo, hi = min(lo, c["low"]), max(hi, c["high"])
        return lo, hi


# ====================================================================== live


class LiveExchange:
    dry_run = False

    def __init__(
        self,
        product_id: str,
        creds: dict,
        market: Optional[MarketData] = None,
        sleep=time.sleep,
    ):
        from coinbase.rest import RESTClient

        if not creds:
            raise PermanentError(
                "live mode needs COINBASE_KEY_FILE or COINBASE_API_KEY/COINBASE_API_SECRET in .env"
            )
        self.pid = product_id
        self.client = RESTClient(timeout=15, verbose=False, **creds)
        self.market = market or MarketData(product_id, sleep=sleep)
        self.sleep = sleep

    # -- read
    def key_permissions(self) -> dict:
        return with_retry(
            lambda: self.client.get_api_key_permissions().to_dict(),
            "key_permissions",
            sleep=self.sleep,
        )

    def maker_fee_rate(self) -> Optional[Decimal]:
        r = with_retry(
            lambda: self.client.get_transaction_summary(product_type="SPOT").to_dict(),
            "fees",
            sleep=self.sleep,
        )
        rate = (r.get("fee_tier") or {}).get("maker_fee_rate")
        return D(str(rate)) if rate is not None else None

    def balances(self) -> dict[str, Decimal]:
        out, cursor = {}, None
        while True:
            r = with_retry(
                lambda: self.client.get_accounts(limit=250, cursor=cursor).to_dict(),
                "accounts",
                sleep=self.sleep,
            )
            for a in r.get("accounts", []):
                out[a["currency"]] = D(str(a["available_balance"]["value"]))
            if not r.get("has_next"):
                return out
            cursor = r.get("cursor")

    def list_open_orders(self) -> list[dict]:
        out, cursor = [], None
        while True:
            r = with_retry(
                lambda: self.client.list_orders(
                    product_ids=[self.pid],
                    order_status=["OPEN"],
                    limit=250,
                    cursor=cursor,
                ).to_dict(),
                "list_open_orders",
                sleep=self.sleep,
            )
            out += [_norm_order(o) for o in r.get("orders", [])]
            if not r.get("has_next"):
                return out
            cursor = r.get("cursor")

    def get_order(self, order_id: str) -> dict:
        r = with_retry(
            lambda: self.client.get_order(order_id).to_dict(),
            "get_order",
            sleep=self.sleep,
        )
        return _norm_order(r["order"])

    def find_by_client_id(self, cid: str, since: float) -> Optional[dict]:
        """Look an order up by client_order_id (used before re-sending after a timeout)."""
        cursor = None
        for _ in range(10):
            r = with_retry(
                lambda: self.client.list_orders(
                    product_ids=[self.pid],
                    start_date=iso(since - 120),
                    limit=250,
                    cursor=cursor,
                ).to_dict(),
                "find_by_client_id",
                sleep=self.sleep,
            )
            for o in r.get("orders", []):
                if o.get("client_order_id") == cid:
                    return _norm_order(o)
            if not r.get("has_next"):
                return None
            cursor = r.get("cursor")
        return None

    def fills(self, order_id: str) -> list[dict]:
        out, cursor = [], None
        while True:
            r = with_retry(
                lambda: self.client.get_fills(
                    order_ids=[order_id], limit=100, cursor=cursor
                ).to_dict(),
                "fills",
                sleep=self.sleep,
            )
            out += [_norm_fill(f) for f in r.get("fills", [])]
            if not r.get("cursor"):
                return out
            cursor = r.get("cursor")

    # -- write
    def place_limit(self, cid: str, side: str, size: Decimal, price: Decimal) -> dict:
        """ONE attempt, post-only GTC limit. Returns {ok, order_id, reason}.
        Raises TransientError when the outcome is unknown (caller must look up by cid)."""
        try:
            r = self.client.limit_order_gtc(
                client_order_id=cid,
                product_id=self.pid,
                side=side,
                base_size=format(size, "f"),
                limit_price=format(price, "f"),
                post_only=True,
            ).to_dict()
        except Exception as e:  # noqa: BLE001
            raise classify(e) from e
        if r.get("success"):
            sr = r.get("success_response") or {}
            return {
                "ok": True,
                "order_id": sr.get("order_id") or r.get("order_id"),
                "reason": None,
            }
        er = r.get("error_response") or {}
        reason = (
            er.get("new_order_failure_reason")
            or er.get("preview_failure_reason")
            or er.get("error")
            or r.get("failure_reason")
            or "UNKNOWN"
        )
        return {
            "ok": False,
            "order_id": None,
            "reason": str(reason),
            "message": er.get("message"),
        }

    def cancel(self, order_ids: list[str]) -> dict[str, bool]:
        res = {}
        for i in range(0, len(order_ids), 100):
            chunk = order_ids[i : i + 100]
            r = with_retry(
                lambda: self.client.cancel_orders(order_ids=chunk).to_dict(),
                "cancel",
                sleep=self.sleep,
            )
            for x in r.get("results", []):
                res[x.get("order_id")] = bool(x.get("success")) or x.get(
                    "failure_reason"
                ) in ("DUPLICATE_CANCEL_REQUEST",)
        return res

    def advance(self, now: float) -> None:
        pass


# ====================================================================== dry run

SIM_SCHEMA = """
CREATE TABLE IF NOT EXISTS sim_orders (
  order_id TEXT PRIMARY KEY, client_order_id TEXT UNIQUE, side TEXT, price TEXT, size TEXT,
  status TEXT, created_at REAL, filled_at REAL, fee TEXT DEFAULT '0');
CREATE TABLE IF NOT EXISTS sim_balances (currency TEXT PRIMARY KEY, amount TEXT);
CREATE TABLE IF NOT EXISTS sim_kv (key TEXT PRIMARY KEY, value TEXT);
"""


class DryRunExchange:
    """Simulates the exchange in the dry-run database. Never sends an authenticated request.

    Fill rule (conservative): a resting buy fills only if a later 1-minute candle traded
    strictly BELOW its price; a sell only if one traded strictly ABOVE. Candles that began
    before the order was placed are ignored.
    """

    dry_run = True

    def __init__(
        self,
        product_id: str,
        db,
        market: MarketData,
        fee_rate: Decimal,
        start_usdc: Decimal,
        start_xrp: Decimal,
        base="XRP",
        quote="USDC",
    ):
        self.pid, self.db, self.market, self.fee_rate = product_id, db, market, fee_rate
        self.base, self.quote = base, quote
        db.row_factory = sqlite3.Row
        db.executescript(SIM_SCHEMA)
        if not db.execute("SELECT 1 FROM sim_balances").fetchone():
            db.execute("INSERT INTO sim_balances VALUES(?,?)", (quote, str(start_usdc)))
            db.execute("INSERT INTO sim_balances VALUES(?,?)", (base, str(start_xrp)))

    # -- balances (total minus holds of open orders = available)
    def _total(self, cur: str) -> Decimal:
        return D(
            self.db.execute(
                "SELECT amount FROM sim_balances WHERE currency=?", (cur,)
            ).fetchone()[0]
        )

    def _add(self, cur: str, delta: Decimal) -> None:
        self.db.execute(
            "UPDATE sim_balances SET amount=? WHERE currency=?",
            (str(self._total(cur) + delta), cur),
        )

    def balances(self) -> dict[str, Decimal]:
        usdc, xrp = self._total(self.quote), self._total(self.base)
        for r in self.db.execute(
            "SELECT side,price,size FROM sim_orders WHERE status='OPEN'"
        ):
            if r[0] == BUY:
                usdc -= D(r[2]) * D(r[1]) * (1 + self.fee_rate)
            else:
                xrp -= D(r[2])
        return {self.quote: usdc, self.base: xrp}

    def totals(self) -> dict[str, Decimal]:
        return {self.quote: self._total(self.quote), self.base: self._total(self.base)}

    def key_permissions(self) -> dict:
        return {}

    def maker_fee_rate(self) -> Optional[Decimal]:
        return None

    # -- orders
    def _row(self, r) -> dict:
        filled = r["status"] == "FILLED"
        size, price = D(r["size"]), D(r["price"])
        return {
            "order_id": r["order_id"],
            "client_order_id": r["client_order_id"],
            "side": r["side"],
            "status": r["status"],
            "price": price,
            "size": size,
            "filled_size": size if filled else D(0),
            "filled_value": size * price if filled else D(0),
            "total_fees": D(r["fee"]),
        }

    def _q(self, sql, args=()):
        return self.db.execute(sql, args)

    def list_open_orders(self) -> list[dict]:
        return [
            self._row(r)
            for r in self._q("SELECT * FROM sim_orders WHERE status='OPEN'")
        ]

    def get_order(self, order_id: str) -> dict:
        r = self._q("SELECT * FROM sim_orders WHERE order_id=?", (order_id,)).fetchone()
        if not r:
            raise PermanentError("HTTP 404: order not found")
        return self._row(r)

    def find_by_client_id(self, cid: str, since: float) -> Optional[dict]:
        r = self._q(
            "SELECT * FROM sim_orders WHERE client_order_id=?", (cid,)
        ).fetchone()
        return self._row(r) if r else None

    def fills(self, order_id: str) -> list[dict]:
        r = self._q(
            "SELECT * FROM sim_orders WHERE order_id=? AND status='FILLED'", (order_id,)
        ).fetchone()
        if not r:
            return []
        return [
            {
                "trade_id": "sim-" + r["order_id"],
                "order_id": r["order_id"],
                "side": r["side"],
                "size": D(r["size"]),
                "price": D(r["price"]),
                "commission": D(r["fee"]),
                "trade_time": iso(r["filled_at"]),
                "trade_type": "FILL",
            }
        ]

    def place_limit(self, cid: str, side: str, size: Decimal, price: Decimal) -> dict:
        existing = self.find_by_client_id(cid, 0)
        if (
            existing
        ):  # same semantics as Coinbase: duplicate cid returns the existing order
            return {"ok": True, "order_id": existing["order_id"], "reason": None}
        bid, ask = self.market.best_bid_ask()
        if (side == BUY and price >= ask) or (side == SELL and price <= bid):
            return {
                "ok": False,
                "order_id": None,
                "reason": "INVALID_LIMIT_PRICE_POST_ONLY",
            }
        bal = self.balances()
        need = size * price * (1 + self.fee_rate) if side == BUY else size
        have = bal[self.quote] if side == BUY else bal[self.base]
        if need > have:
            return {"ok": False, "order_id": None, "reason": "INSUFFICIENT_FUND"}
        oid = "sim-" + uuid.uuid4().hex[:12]
        self.db.execute(
            "INSERT INTO sim_orders(order_id,client_order_id,side,price,size,status,created_at) "
            "VALUES(?,?,?,?,?, 'OPEN', ?)",
            (oid, cid, side, str(price), str(size), time.time()),
        )
        return {"ok": True, "order_id": oid, "reason": None}

    def cancel(self, order_ids: list[str]) -> dict[str, bool]:
        out = {}
        for oid in order_ids:
            cur = self.db.execute(
                "UPDATE sim_orders SET status='CANCELLED' WHERE order_id=? AND status='OPEN'",
                (oid,),
            )
            out[oid] = cur.rowcount == 1
        return out

    # -- simulation step
    def advance(self, now: float) -> list[str]:
        """Fill resting orders that the market traded through since they were placed."""
        open_rows = list(self._q("SELECT * FROM sim_orders WHERE status='OPEN'"))
        if not open_rows:
            return []
        oldest = min(r["created_at"] for r in open_rows)
        candles = self.market.candles(oldest, now)
        filled = []
        for r in open_rows:
            price, size = D(r["price"]), D(r["size"])
            eligible = [c for c in candles if c["start"] >= r["created_at"]]
            hit = next(
                (
                    c
                    for c in eligible
                    if (c["low"] < price if r["side"] == BUY else c["high"] > price)
                ),
                None,
            )
            if not hit:
                continue
            fee = size * price * self.fee_rate
            if r["side"] == BUY:
                self._add(self.quote, -(size * price + fee))
                self._add(self.base, size)
            else:
                self._add(self.base, -size)
                self._add(self.quote, size * price - fee)
            self.db.execute(
                "UPDATE sim_orders SET status='FILLED', filled_at=?, fee=? WHERE order_id=?",
                (max(hit["start"] + 60, r["created_at"]), str(fee), r["order_id"]),
            )
            filled.append(r["client_order_id"])
        return filled


def new_client_order_id(prefix: str, side: str, level: int) -> str:
    return f"{prefix}{side[0]}{level:+d}-{uuid.uuid4().hex[:12]}"


def parse_client_order_id(prefix: str, cid: str) -> Optional[tuple[str, int]]:

    m = re.fullmatch(rf"{re.escape(prefix)}([BS])([+-]\d+)-[0-9a-f]+", cid or "")
    if not m:
        return None
    return (BUY if m.group(1) == "B" else SELL), int(m.group(2))
