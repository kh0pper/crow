"""SQLite system of record: bots, orders, fills, high-water marks, kv, events.

Isolation mode: AUTOCOMMIT (`isolation_level=None`) with EXPLICIT transactions.
Every connection opens in autocommit and `Store.tx()` is the only place that
starts a transaction.  `tx()` runs `BEGIN IMMEDIATE`, so a writer takes the
write lock up front instead of failing late while upgrading a read lock, and it
falls back to a `SAVEPOINT` when the caller already holds a transaction: the
work then joins the caller's transaction and their commit/rollback decides its
fate.  Every method that writes more than one row, or reads then writes
(`create_bot`, `record_fill`, `update_hwm`, ...), runs inside `tx()`.

`orders.filled_size`, `orders.filled_value` and `orders.fees` mirror the
exchange's own order snapshot: `update_order()` is their single writer and
always sets absolute values.  `record_fill()` only books the `fills` table, so a
fill seen once through the stream and once through the reconcile loop is
counted once.

The database runs in WAL mode (readers never block the writer).  Each thread
gets its own connection through `threading.local`; `Store.conn` is also a valid
`conn_factory` for `DryRunExchange`, and `close()` closes every connection the
store opened.  Money is `Decimal` in Python and TEXT in SQLite (`str(Decimal)`
out, `Decimal(x or "0")` back).  The dry-run exchange keeps its `sim_*` tables
in the same file, created by exchange.py: the names do not clash.
"""

from __future__ import annotations

import contextlib
import itertools
import json
import re
import sqlite3
import threading
import time
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Optional

D = Decimal

# local order statuses
PENDING_SUBMIT = (
    "PENDING_SUBMIT"  # written before the API call; resolved by client_order_id
)
OPEN = "OPEN"
FILLED = "FILLED"
CANCELLED = "CANCELLED"
REJECTED = "REJECTED"  # exchange refused it (never live)
FAILED = "FAILED"  # never reached the exchange
LIVE_STATUSES = (PENDING_SUBMIT, OPEN)

# bot statuses
ACTIVE, PAUSED, STOPPED = "ACTIVE", "PAUSED", "STOPPED"

# opposite-order bookkeeping on a filled order
OPP_TODO, OPP_PLACED, OPP_SKIPPED = 0, 1, 2

# owners that are not bots and never hold a capital budget
RESERVED_OWNERS = ("ai", "orphan")
BOT_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")

SCHEMA_VERSION = 1

# Applied with CREATE TABLE IF NOT EXISTS, so reopening a file is a no-op.
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS bots (
         id TEXT PRIMARY KEY, product TEXT, strategy TEXT, params_json TEXT,
         state_json TEXT, capital_quote TEXT, capital_base TEXT, status TEXT,
         init_done INTEGER DEFAULT 0, created_at REAL)""",
    """CREATE TABLE IF NOT EXISTS orders (
         client_order_id TEXT PRIMARY KEY, order_id TEXT, owner TEXT, source TEXT,
         product TEXT, side TEXT, level INTEGER, price TEXT, size TEXT, status TEXT,
         parent_cid TEXT, created_at REAL, updated_at REAL,
         filled_size TEXT DEFAULT '0', filled_value TEXT DEFAULT '0',
         fees TEXT DEFAULT '0', basis_per_base TEXT, consumes_fill TEXT,
         opposite INTEGER DEFAULT 0, fills_ok INTEGER DEFAULT 0, note TEXT)""",
    """CREATE INDEX IF NOT EXISTS orders_created_at ON orders(created_at)""",
    """CREATE TABLE IF NOT EXISTS fills (
         trade_id TEXT PRIMARY KEY, order_id TEXT, client_order_id TEXT, owner TEXT,
         side TEXT, size TEXT, price TEXT, commission TEXT, trade_time TEXT,
         recorded_at REAL, product TEXT, trade_type TEXT)""",
    """CREATE TABLE IF NOT EXISTS hwm (owner TEXT PRIMARY KEY, value TEXT)""",
    """CREATE TABLE IF NOT EXISTS events (ts REAL, level TEXT, message TEXT)""",
    """CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)""",
    """CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)""",
)

ORDER_DECIMALS = ("price", "size", "filled_size", "filled_value", "fees")


class Store:
    """The engine's database file. Thread-safe: one connection per thread."""

    def __init__(self, path: Path | str):
        self.path = str(path)
        self._local = threading.local()
        self._lock = threading.Lock()
        self._conns: list[sqlite3.Connection] = []
        self._savepoints = itertools.count(1)
        self._order_columns: Optional[set[str]] = None
        self._apply_schema()

    # ------------------------------------------------ connections
    def _connect(self) -> sqlite3.Connection:
        # check_same_thread=False: `close()` may run on a different thread than the
        # one that opened a connection, and it closes every connection from that
        # closing thread.  Each connection is otherwise only ever used by its own
        # thread (looked up through `threading.local`).
        # `timeout` is the one and only place the busy timeout is set (30 s), so a
        # `BEGIN IMMEDIATE` that finds another writer waits instead of failing.
        db = sqlite3.connect(
            self.path,
            timeout=30,
            isolation_level=None,
            check_same_thread=False,
        )
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def conn(self) -> sqlite3.Connection:
        """This thread's connection, created on first use (usable as conn_factory)."""
        db = getattr(self._local, "db", None)
        if db is None:
            db = self._connect()
            self._local.db = db
            with self._lock:
                self._conns.append(db)
        return db

    def close(self) -> None:
        """Close every connection this store opened, from any thread."""
        with self._lock:
            conns, self._conns = self._conns, []
        for db in conns:
            db.close()
        self._local = threading.local()

    @contextlib.contextmanager
    def tx(self):
        """One write transaction: BEGIN IMMEDIATE, or a savepoint when already in one.

        Cleanup never masks the caller's error: a failing ROLLBACK / RELEASE is
        suppressed so the original exception keeps propagating.
        """
        db = self.conn()
        if db.in_transaction:
            name = f"crow_sp_{next(self._savepoints)}"
            db.execute(f"SAVEPOINT {name}")
            try:
                yield db
            except BaseException:
                with contextlib.suppress(sqlite3.Error):
                    if db.in_transaction:
                        db.execute(f"ROLLBACK TO {name}")
                        db.execute(f"RELEASE {name}")
                raise
            db.execute(f"RELEASE {name}")
            return
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
        except BaseException:
            with contextlib.suppress(sqlite3.Error):
                if db.in_transaction:
                    db.execute("ROLLBACK")
            raise
        try:
            db.execute("COMMIT")
        except BaseException:
            # The transaction is still open: undo it, then report the COMMIT error.
            with contextlib.suppress(sqlite3.Error):
                if db.in_transaction:
                    db.execute("ROLLBACK")
            raise

    def _apply_schema(self) -> None:
        """Create the tables, seed schema_version and refuse a newer database file."""
        with self.tx() as db:
            for statement in SCHEMA:
                db.execute(statement)
            row = db.execute(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
            ).fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,)
                )
            elif int(row[0]) > SCHEMA_VERSION:
                raise RuntimeError(
                    f"database schema version {int(row[0])} is newer than this "
                    f"engine's schema version {SCHEMA_VERSION}"
                )

    def schema_version(self) -> int:
        row = self.conn().execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()
        return int(row[0]) if row else SCHEMA_VERSION

    def order_columns(self) -> set[str]:
        """The real `orders` column names, read with PRAGMA and cached once."""
        if self._order_columns is None:
            self._order_columns = {
                row[1] for row in self.conn().execute("PRAGMA table_info(orders)")
            }
        return self._order_columns

    # ------------------------------------------------ bots
    def create_bot(
        self,
        bot_id: str,
        product: str,
        strategy: str,
        params: dict,
        capital_quote: Decimal,
        capital_base: Decimal,
    ) -> dict:
        """Insert a bot and return it. Validates the id and the capital budget."""
        if not isinstance(bot_id, str) or not BOT_ID_RE.fullmatch(bot_id):
            raise ValueError(f"invalid bot id: {bot_id!r}")
        if bot_id in RESERVED_OWNERS:
            raise ValueError(f"reserved bot id: {bot_id!r}")
        quote, base = D(capital_quote), D(capital_base)
        if quote < 0 or base < 0:
            raise ValueError(f"capital must not be negative: {quote} / {base}")
        now = time.time()
        with self.tx() as db:
            if (
                db.execute("SELECT 1 FROM bots WHERE id=?", (bot_id,)).fetchone()
                is not None
            ):
                raise ValueError(f"bot already exists: {bot_id!r}")
            db.execute(
                "INSERT INTO bots(id,product,strategy,params_json,state_json,"
                "capital_quote,capital_base,status,init_done,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,0,?)",
                (
                    bot_id,
                    product,
                    strategy,
                    json.dumps(params or {}),
                    json.dumps({}),
                    str(quote),
                    str(base),
                    ACTIVE,
                    now,
                ),
            )
        return self.get_bot(bot_id)

    def get_bot(self, bot_id: str) -> Optional[dict]:
        row = self.conn().execute("SELECT * FROM bots WHERE id=?", (bot_id,)).fetchone()
        return _bot(row) if row else None

    def list_bots(self) -> list[dict]:
        rows = self.conn().execute("SELECT * FROM bots ORDER BY created_at, id")
        return [_bot(r) for r in rows]

    def set_bot_status(self, bot_id: str, status: str) -> None:
        self.conn().execute("UPDATE bots SET status=? WHERE id=?", (status, bot_id))

    def set_bot_state(self, bot_id: str, state: dict) -> None:
        self.conn().execute(
            "UPDATE bots SET state_json=? WHERE id=?",
            (json.dumps(state or {}), bot_id),
        )

    def set_init_done(self, bot_id: str) -> None:
        self.conn().execute("UPDATE bots SET init_done=1 WHERE id=?", (bot_id,))

    # ------------------------------------------------ orders
    def insert_order(
        self,
        cid: str,
        owner: str,
        source: str,
        product: str,
        side: str,
        level: int,
        price: Decimal,
        size: Decimal,
        status: str = PENDING_SUBMIT,
        order_id: Optional[str] = None,
        parent_cid: Optional[str] = None,
        consumes_fill: Optional[str] = None,
        basis_per_base: Optional[Decimal] = None,
        note: Optional[str] = None,
    ) -> None:
        """Record a local order row before it is (or is not) sent to the exchange.

        EVERY order's client order id starts with `cb-`: the engine's own ids all
        carry that prefix, so an id without it is not recognisably ours.

        For every owner except `orphan` the id must also carry the owner, i.e.
        `cb-<owner>-...` — any other owner part would make the reconcile loop
        attribute the order to the wrong owner.  An `orphan` order (a fill/order
        the exchange reported whose bot row is gone) still needs a `cb-` id, e.g.
        one built from the vanished bot's id (`cb-b9-B-1-000000000001`), but it
        need not carry the literal string `orphan`.

        Raises `ValueError` (nothing written) for any other id.
        """
        cid = str(cid)
        prefix = f"cb-{owner}-"
        if not cid.startswith("cb-"):
            raise ValueError(f"client order id {cid!r} must start with 'cb-'")
        if owner != "orphan" and not cid.startswith(prefix):
            raise ValueError(f"client order id {cid!r} must start with {prefix!r}")
        now = time.time()
        self.conn().execute(
            "INSERT INTO orders(client_order_id,order_id,owner,source,product,side,"
            "level,price,size,status,parent_cid,created_at,updated_at,basis_per_base,"
            "consumes_fill,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cid,
                order_id,
                owner,
                source,
                product,
                side,
                level,
                str(price),
                str(size),
                status,
                parent_cid,
                now,
                now,
                None if basis_per_base is None else str(basis_per_base),
                consumes_fill,
                note,
            ),
        )

    def update_order(self, cid: str, **fields: Any) -> None:
        """Patch an order row; Decimals are stored as TEXT and updated_at is bumped.

        This is the SINGLE writer of `filled_size`, `filled_value` and `fees`:
        those columns mirror the exchange's order snapshot, so they are set to
        absolute values here and are never incremented (`record_fill` writes only
        the `fills` table).  Field names are checked against the real `orders`
        columns, and `client_order_id` itself is not patchable; an unknown name
        raises `ValueError` and writes nothing.
        """
        if not fields:
            return
        allowed = self.order_columns()
        for name in fields:
            if name == "client_order_id" or name not in allowed:
                raise ValueError(f"cannot update order column: {name!r}")
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        vals = [str(v) if isinstance(v, Decimal) else v for v in fields.values()]
        with self.tx() as db:
            db.execute(f"UPDATE orders SET {cols} WHERE client_order_id=?", (*vals, cid))

    def order(self, cid: str) -> Optional[dict]:
        row = self.conn().execute(
            "SELECT * FROM orders WHERE client_order_id=?", (cid,)
        ).fetchone()
        return _order(row) if row else None

    def orders(
        self,
        owner: Optional[str] = None,
        statuses: Optional[Iterable[str]] = None,
        product: Optional[str] = None,
    ) -> list[dict]:
        q, args = "SELECT * FROM orders WHERE 1=1", []
        if owner is not None:
            q += " AND owner=?"
            args.append(owner)
        if statuses:
            st = list(statuses)
            q += f" AND status IN ({','.join('?' * len(st))})"
            args += st
        if product is not None:
            q += " AND product=?"
            args.append(product)
        q += " ORDER BY created_at, client_order_id"
        return [_order(r) for r in self.conn().execute(q, args)]

    # ------------------------------------------------ fills
    def record_fill(self, fill: dict, cid: str) -> bool:
        """Book one exchange fill into `fills` exactly once.

        Returns True when a row was inserted and False when the trade_id was
        already booked (nothing written).  Raises `KeyError` for an unknown
        client order id (nothing written).  The owner is copied from the order
        row, so a fill keeps its owner even after that bot's row is gone.

        A fill carrying a `product` that differs from the order row's product is
        refused with `ValueError` (nothing written): a fill belongs to its order's
        product.  When the fill carries no product, the order's product is used.

        This never writes `orders`: `filled_size` / `filled_value` / `fees` are
        the exchange's snapshot and only `update_order` sets them, so a fill seen
        by both the stream and the reconcile loop is counted once.
        """
        now = time.time()
        with self.tx() as db:
            row = db.execute(
                "SELECT owner, product FROM orders WHERE client_order_id=?", (cid,)
            ).fetchone()
            if row is None:
                raise KeyError(cid)
            product = fill.get("product") or row["product"]
            if product != row["product"]:
                raise ValueError(
                    f"fill trade_id {fill['trade_id']!r} product {product!r} does "
                    f"not match order {cid!r} product {row['product']!r}"
                )
            cur = db.execute(
                "INSERT OR IGNORE INTO fills(trade_id,order_id,client_order_id,owner,"
                "side,size,price,commission,trade_time,recorded_at,product,trade_type) "
                "VALUES(:trade_id,:order_id,:cid,:owner,:side,:size,:price,"
                ":commission,:trade_time,:recorded_at,:product,:trade_type)",
                {
                    "trade_id": fill["trade_id"],
                    "order_id": fill["order_id"],
                    "cid": cid,
                    "owner": row["owner"],
                    "side": fill["side"],
                    "size": str(D(fill["size"])),
                    "price": str(D(fill["price"])),
                    "commission": str(D(fill["commission"])),
                    "trade_time": fill["trade_time"],
                    "recorded_at": now,
                    "product": product,
                    "trade_type": fill.get("trade_type"),
                },
            )
            return cur.rowcount == 1

    def has_fill(self, trade_id: str) -> bool:
        return (
            self.conn()
            .execute("SELECT 1 FROM fills WHERE trade_id=?", (trade_id,))
            .fetchone()
            is not None
        )

    # ------------------------------------------------ high-water mark
    def hwm(self, owner: str) -> Optional[Decimal]:
        row = self.conn().execute(
            "SELECT value FROM hwm WHERE owner=?", (owner,)
        ).fetchone()
        return D(row["value"]) if row and row["value"] is not None else None

    def update_hwm(self, owner: str, equity: Decimal) -> Decimal:
        """Ratchet the owner's high-water mark up to *equity* and return it."""
        value = D(equity)
        with self.tx() as db:
            row = db.execute("SELECT value FROM hwm WHERE owner=?", (owner,)).fetchone()
            previous = D(row["value"]) if row and row["value"] is not None else None
            new = value if previous is None else max(previous, value)
            db.execute(
                "INSERT INTO hwm(owner,value) VALUES(?,?) "
                "ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
                (owner, str(new)),
            )
        return new

    # ------------------------------------------------ kv / events
    def get(self, key: str, default=None):
        """JSON-decode a kv entry, or return *default* when the key is absent."""
        row = self.conn().execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def put(self, key: str, value) -> None:
        self.conn().execute(
            "INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)",
            (key, json.dumps(value)),
        )

    def event(self, level: str, message: str) -> None:
        self.conn().execute(
            "INSERT INTO events(ts,level,message) VALUES(?,?,?)",
            (time.time(), level, message),
        )


def _bot(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "product": row["product"],
        "strategy": row["strategy"],
        "params": json.loads(row["params_json"] or "{}"),
        "state": json.loads(row["state_json"] or "{}"),
        "capital_quote": D(row["capital_quote"] or "0"),
        "capital_base": D(row["capital_base"] or "0"),
        "status": row["status"],
        "init_done": bool(row["init_done"]),
        "created_at": row["created_at"],
    }


def _order(row: sqlite3.Row) -> dict:
    o = dict(row)
    for k in ORDER_DECIMALS:
        o[k] = D(o[k] or "0")
    o["basis_per_base"] = D(o["basis_per_base"]) if o["basis_per_base"] else None
    return o