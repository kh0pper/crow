"""Reconcile: the exchange snapshot is the truth, the store catches up.

One cycle reads the exchange and writes the store's order rows to match it:
`list_open_orders(None)` for the book, then one `get_order` or
`find_by_client_id` per live row that list did not mention, because absence from
the list is not evidence that an order is gone.  A snapshot's `filled_size`,
`filled_value` and `total_fees` are written as ABSOLUTE values, and only through
`store.update_order` (their single writer): a `filled_size` that moved clears
`fills_ok`, so the fills behind it are booked again, and the flag is set only
once the recorded FILL sizes reach it.

Every fill is booked once: a trade already in `fills` is skipped, the
`trades.csv` row is written before the database row, and a `trade_type` that is
null or absent counts as a FILL.  Ids that do not start with `cb-` are somebody
else's orders and are never adopted or touched.

Nothing here writes to the exchange.  A kill is the gateway's `cancel_all`, run
after the rows are settled so their state is recorded first, and only for a halt
or for an owner whose bot row says STOPPED; an orphan waits for a halt.  A
failing list call propagates (an empty book must not be assumed), while a failing
per-order read is a warning that skips that one row for the cycle and retries it
on the next one.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Optional

from . import money, records
from .exchange import PermanentError, TransientError
from .store import (
    CANCELLED,
    FAILED,
    FILLED,
    LIVE_STATUSES,
    OPEN,
    PENDING_SUBMIT,
    STOPPED,
    Store,
)

D = Decimal
log = logging.getLogger("crow_coinbase.reconcile")

# The local status a snapshot settles to, by the exchange's own status string.
# Everything not named here (OPEN, PENDING, QUEUED, a status nobody knows) is a
# resting order: the safe reading of a status this module cannot interpret.
STATUS_BY_EXCHANGE = {
    "FILLED": FILLED,
    "CANCELLED": CANCELLED,
    "EXPIRED": CANCELLED,
    "CANCEL_QUEUED": CANCELLED,
    "FAILED": FAILED,
}

# Rows that can still carry fills to book, so every cycle sweeps them: a cycle
# that died between the absolute update and the fill write leaves `fills_ok` at 0
# on a row nobody will settle again.
FILLABLE_STATUSES = (OPEN, FILLED, CANCELLED)

# A `cb-` row written before a send, with no order at the exchange, is given up
# on only after this long (seconds): an answer that was lost may still land, so a
# short window would fail an order the exchange is about to hold.
PENDING_WINDOW_S = 300.0

# `cb-<owner>-<B|S><+level>-<hex>`: the owner part and the shape the engine builds.
OWNER_RE = re.compile(r"^cb-([a-z0-9]{1,16})-")
SHAPE_RE = re.compile(r"^cb-[a-z0-9]{1,16}-([BS])([+-]\d+)-[0-9a-f]+$")
SIDES = {"B": money.BUY, "S": money.SELL}


@dataclass(frozen=True)
class ReconcileReport:
    """What one cycle did, for the caller to log, ring or alert on.

    `updated` counts the order rows inserted (an adopted stranger) or changed
    (a settle, an expiry) this call.  `orphans` lists every `cb-` order still
    live after the sync whose owner is `orphan`, so a bot that vanished cannot
    leave an order resting unnoticed.  `new_fills` maps an owner to the rows that
    went from live to terminal carrying a fill this call, each re-read after its
    update, which is the shape a strategy needs to react to a fill it did not
    place itself.
    """

    updated: int
    orphans: list[str]
    new_fills: dict[str, list[dict]]


def reconcile(
    store: Store,
    exchange: Any,
    now: float,
    gateway: Any = None,
    *,
    trades_csv: Path | None = None,
    mode: str = "dry",
) -> ReconcileReport:
    """Bring the store's order rows up to date with the exchange, once.

    `now` is the caller's clock (epoch seconds), used only to decide that a row
    which never reached the exchange may be given up on.  `gateway` is the kill
    path: with none, live orders are left resting.  `trades_csv` defaults to the
    file beside the database, and `mode` is stamped into every row written there.
    """
    csv_path = (
        Path(trades_csv)
        if trades_csv is not None
        else Path(store.path).parent / "trades.csv"
    )
    open_list = _open_cb_orders(exchange)
    new_fills: dict[str, list[dict]] = {}

    updated = _settle_live(store, exchange, open_list, now, new_fills)
    updated += _adopt_unknown(store, open_list, new_fills)
    _book_fills(store, exchange, csv_path, mode)
    if gateway is not None:
        _kill_gap(store, gateway, open_list)

    orphans = [
        row["client_order_id"]
        for row in store.orders(owner="orphan", statuses=LIVE_STATUSES)
    ]
    return ReconcileReport(updated=updated, orphans=orphans, new_fills=new_fills)


# ---------------------------------------------------------------- the book


def _open_cb_orders(exchange: Any) -> dict[str, dict]:
    """The exchange's open orders that are ours, keyed by client order id.

    A failing list call propagates: a cycle that cannot read the book must not
    settle anything from an empty one.  An id without the `cb-` prefix was not
    placed by the engine (a hand-placed order in the exchange's own UI) and is
    dropped here, so no later step can adopt it or ask about it.
    """
    listed = exchange.list_open_orders(None) or []
    return {
        snap["client_order_id"]: snap
        for snap in listed
        if str(snap.get("client_order_id") or "").startswith("cb-")
    }


def _settle_live(
    store: Store,
    exchange: Any,
    open_list: dict[str, dict],
    now: float,
    new_fills: dict[str, list[dict]],
) -> int:
    """Settle every live row from the exchange; return how many rows changed.

    A row in the open list takes that snapshot.  A row the list omits is read on
    its own: with an order id it is never given up on, however old (a lost answer
    is not an order that never landed), and without one it is looked up by client
    order id, where only a row past the window with no order anywhere becomes
    FAILED.  One row's read failing skips that row alone.
    """
    updated = 0
    for row in store.orders(statuses=LIVE_STATUSES):
        cid = row["client_order_id"]
        snap = open_list.get(cid)
        if snap is None:
            answered, snap = _absent_snapshot(store, exchange, row)
            if not answered:
                continue
            if snap is None:
                created = row["created_at"] or 0.0
                if _may_be_given_up(row) and now - created > PENDING_WINDOW_S:
                    store.update_order(
                        cid,
                        status=FAILED,
                        note="never reached the exchange",
                    )
                    updated += 1
                continue
        fresh, changed, new_fill = _apply(store, row, snap)
        updated += 1 if changed else 0
        if new_fill:
            new_fills.setdefault(row["owner"], []).append(fresh)
    return updated


def _absent_snapshot(
    store: Store, exchange: Any, row: dict
) -> tuple[bool, Optional[dict]]:
    """The snapshot for a live row the open list did not mention.

    Returns `(answered, snapshot)`; `answered` False means the read raised, so the
    row is left exactly as it is.  A row with an order id is read with
    `get_order`, the one read that answers for a terminal order.  A row without
    one is looked up by its own id, on its own product, from the timestamp it was
    written with.  Nothing found for a resting row is recorded as a warning: no
    exchange read says that order is gone.
    """
    cid = row["client_order_id"]
    order_id = row["order_id"]
    if order_id:
        return _read(
            store, f"order {order_id}", lambda: exchange.get_order(order_id)
        )
    answered, snap = _read(
        store,
        f"client order id {cid}",
        lambda: exchange.find_by_client_id(cid, row["created_at"], row["product"]),
    )
    if answered and snap is None and row["status"] == OPEN:
        message = f"open order {cid} has no order id and was not found by client id"
        log.warning(message)
        store.event("warn", message)
    return answered, snap


def _may_be_given_up(row: dict) -> bool:
    """True for a row that may become FAILED: pending, sent nowhere, no order id."""
    return row["status"] == PENDING_SUBMIT and not row["order_id"]


def _read(store: Store, what: str, call: Callable[[], Any]) -> tuple[bool, Any]:
    """One per-order exchange read; an exchange error answers nothing.

    Returns `(answered, value)`.  `answered` False means a transient or permanent
    error was raised: it is logged and recorded as a warning, and the caller
    leaves that row alone for this cycle.  A failed read is never allowed to
    expire a row, treat it as a cancellation, or count as an empty fill list,
    because it says nothing about the order.
    """
    try:
        return True, call()
    except (TransientError, PermanentError) as error:
        log.warning("%s: %s", what, error)
        store.event("warn", f"{what}: {error}")
        return False, None


def _apply(store: Store, row: dict, snap: dict) -> tuple[dict, bool, bool]:
    """Write the exchange's snapshot of *row* onto its order row.

    `filled_size`, `filled_value` and `fees` take the snapshot's absolute values
    and are never added to, so a fill the stream also saw cannot double count.  A
    `filled_size` that moved clears `fills_ok`, which is what makes the fills
    behind the new total get booked.  One `store.update_order` is made, and only
    when something differs from the row, so a second cycle over an unchanged book
    writes nothing.

    Returns `(fresh, changed, new_fill)`: the row re-read after the write, whether
    the row was written, and whether a live row settled to a terminal one that
    carries a fill.
    """
    cid = row["client_order_id"]
    status = _status_of(snap)
    order_id = snap.get("order_id") or row["order_id"]
    filled_size = _dec(snap.get("filled_size"))
    fields: dict[str, Any] = {
        "status": status,
        "order_id": order_id,
        "filled_size": filled_size,
        "filled_value": _dec(snap.get("filled_value")),
        "fees": _dec(snap.get("total_fees")),
    }
    changed = (
        status != row["status"]
        or order_id != row["order_id"]
        or filled_size != row["filled_size"]
        or fields["filled_value"] != row["filled_value"]
        or fields["fees"] != row["fees"]
    )
    if changed:
        if filled_size != row["filled_size"]:
            fields["fills_ok"] = 0
        store.update_order(cid, **fields)
    fresh = store.order(cid) or row
    terminal_with_fill = status == FILLED or (
        status == CANCELLED and filled_size > 0
    )
    return fresh, changed, row["status"] in LIVE_STATUSES and terminal_with_fill


def _status_of(snap: dict) -> str:
    """The local status a normalised snapshot settles to."""
    return STATUS_BY_EXCHANGE.get(str(snap.get("status") or ""), OPEN)


def _owner_of(cid: str) -> Optional[str]:
    """The owner part of a `cb-<owner>-...` id, or None when the id does not parse."""
    match = OWNER_RE.match(cid)
    return match.group(1) if match else None


def _dec(value: Any) -> Decimal:
    """A snapshot number as a `Decimal`; an absent one is zero."""
    return D(str(value if value is not None else "0"))


# ---------------------------------------------------------------- adoption


def _adopt_unknown(store: Store, open_list: dict[str, dict], new_fills: dict) -> int:
    """Give a row to every one of our open orders the store has never seen.

    The owner comes from the id when it is `ai` or a bot row exists; anything else
    is an orphan (the bot is gone), which the halt branch alone may sweep.  The
    row is written OPEN with the exchange's own order id and then settled from the
    same snapshot in one further step, so a stranger that is already partly
    filled keeps its filled part.  Returns how many rows were written.
    """
    updated = 0
    for cid, snap in open_list.items():
        if store.order(cid) is not None:
            continue
        owner = _owner_of(cid)
        if owner == "ai":
            source = "ai"
        else:
            if owner is None or store.get_bot(owner) is None:
                owner = "orphan"
            source = "bot"
        side, level = _shape_of(cid, snap)
        orphan = owner == "orphan"
        store.insert_order(
            cid,
            owner,
            source,
            snap.get("product"),
            side,
            level,
            _dec(snap.get("price")),
            _dec(snap.get("size")),
            status=OPEN,
            order_id=snap.get("order_id"),
            note="adopted orphan" if orphan else "adopted",
        )
        updated += 1
        row = store.order(cid)
        if row is None:
            continue
        fresh, changed, new_fill = _apply(store, row, snap)
        updated += 1 if changed else 0
        if new_fill:
            new_fills.setdefault(owner, []).append(fresh)
    return updated


def _shape_of(cid: str, snap: dict) -> tuple[str, int]:
    """The side and level an adopted id carries, or the snapshot's own.

    The engine builds every id as `cb-<owner>-<B|S><+level>-<hex>`, so an id that
    does not parse falls back to the exchange's side at level 0 rather than
    guessing from a prefix that may have been hand-written.
    """
    match = SHAPE_RE.match(cid)
    if match is None:
        return str(snap.get("side") or money.BUY), 0
    return SIDES[match.group(1)], int(match.group(2))


# ---------------------------------------------------------------- fills


def _book_fills(
    store: Store, exchange: Any, trades_csv: Path, mode: str
) -> None:
    """Book the fills behind every filled row: `trades.csv` first, then the database.

    A row is skipped once `fills_ok` says its booked FILL sizes match the
    `filled_size` the exchange reported, so a cycle over an unchanged book writes
    nothing and a partial fill sitting on a resting order is booked as soon as it
    appears.  A trade already in `fills` (booked by the stream, or by an earlier
    cycle) adds no CSV row of its own, and the CSV write comes before the insert,
    so a cycle that dies between the two leaves a row records can still be read.
    """
    for row in store.orders(statuses=FILLABLE_STATUSES):
        if row["filled_size"] <= 0 or row["fills_ok"]:
            continue
        order_id = row["order_id"]
        if not order_id:
            continue
        cid = row["client_order_id"]
        answered, fills = _read(
            store, f"fills for {order_id}", lambda: exchange.fills(order_id)
        )
        if not answered:
            continue
        for fill in fills or []:
            _book_fill(store, row, fill, trades_csv, mode)
        if _recorded_fill_size(store, cid) >= row["filled_size"]:
            store.update_order(cid, fills_ok=1)


def _book_fill(store: Store, row: dict, fill: dict, trades_csv: Path, mode: str) -> None:
    """Book one exchange fill, unless it is already booked or belongs elsewhere.

    The row's product is the product of its fills: a fill that names a different
    one is recorded as a warning and left unbooked, because attributing it here
    would put another order's trade in this owner's records.
    """
    trade_id = fill.get("trade_id")
    if not trade_id or store.has_fill(trade_id):
        return
    cid = row["client_order_id"]
    product = fill.get("product") or row["product"]
    if product != row["product"]:
        message = (
            f"fill {trade_id} is product {product!r} but order {cid} is "
            f"{row['product']!r}; left unbooked"
        )
        log.warning(message)
        store.event("warn", message)
        return
    records.append_fill(trades_csv, product, fill, cid, mode)
    store.record_fill(fill, cid)


def _recorded_fill_size(store: Store, cid: str) -> Decimal:
    """The traded size booked for *cid*, counting FILL trades only.

    A null or absent `trade_type` is a FILL; a CORRECTION (or any other type) moved
    no base, so it must not count toward the size the order says was filled.
    """
    total = D(0)
    rows = store.conn().execute(
        "SELECT trade_type, size FROM fills WHERE client_order_id=?", (cid,)
    )
    for fill in rows:
        if fill["trade_type"] in (None, "FILL"):
            total += _dec(fill["size"])
    return total


# ---------------------------------------------------------------- kill path


def _kill_gap(store: Store, gateway: Any, open_list: dict[str, dict]) -> None:
    """Sweep live orders off the book, through the gateway and nothing else.

    A halt sweeps every `cb-` order, orphans and the `ai` owner included;
    otherwise only an owner whose bot row says STOPPED is swept.  This runs after
    the rows are settled, so each row already records the state the exchange had
    before the sweep, and the next cycle settles them from the exchange itself.  A
    failing sweep is recorded as an error and the cycle still returns.
    """
    if not open_list:
        return
    if gateway.is_halted():
        _sweep(store, gateway, "all", None)
        return
    for owner in _owners_of(store, open_list):
        bot = store.get_bot(owner)
        if bot is not None and bot["status"] == STOPPED:
            _sweep(store, gateway, "owner", owner)


def _sweep(store: Store, gateway: Any, scope: str, owner: Optional[str]) -> None:
    """One gateway sweep; its exception is recorded, never raised."""
    try:
        gateway.cancel_all(scope=scope, owner=owner)
    except Exception as error:  # noqa: BLE001 - a kill path may not abort the cycle
        message = f"sweep {scope} {owner or '-'} failed: {error}"
        log.error(message)
        store.event("error", message)


def _owners_of(store: Store, open_list: dict[str, dict]) -> list[str]:
    """Each distinct owner of an order in the open list, in the list's own order."""
    owners: list[str] = []
    for cid in open_list:
        row = store.order(cid)
        if row is None or row["owner"] in owners:
            continue
        owners.append(row["owner"])
    return owners