"""
PIR Tracker routes — list, create, update, delete Public Information Requests.

Uses sync SQLAlchemy (get_sync_engine + Session) following the tasks.py pattern.
"""

from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from src.models.database import PIRRequest, get_sync_engine
from src.templates_config import templates

router = APIRouter()

SQ_LABELS = {
    "sq1": "Sub-Q 1: Charter/ISD Duplication Efficiency",
    "sq2": "Sub-Q 2: Bond Election Mechanism",
    "sq3": "Sub-Q 3: ARC as Constitutional Remedy",
    "sq4": "Sub-Q 4: TIA Funding Equity",
}


def _reject_null_or_empty(cls, v, info):
    if v is None:
        raise ValueError(f"{info.field_name} cannot be null")
    if isinstance(v, str) and v == "":
        raise ValueError(f"{info.field_name} cannot be empty")
    return v


def _is_overdue(pir: PIRRequest) -> bool:
    """Display-only: past due with no response."""
    if pir.status not in ("pending", "clarification", "processing"):
        return False
    if pir.response_due is None:
        return False
    due = pir.response_due.date() if isinstance(pir.response_due, datetime) else pir.response_due
    return due < date.today()


def _needs_our_action(pir: PIRRequest) -> bool:
    """Display-only: we have a pending action item."""
    return bool(pir.action_needed)


def _followup_overdue(pir: PIRRequest) -> bool:
    """Display-only: our planned follow-up date has passed."""
    if pir.next_followup_date is None:
        return False
    if pir.status in ("received", "withdrawn"):
        return False
    fdate = (pir.next_followup_date.date()
             if isinstance(pir.next_followup_date, datetime) else pir.next_followup_date)
    return fdate <= date.today()


def _is_urgent(pir: PIRRequest) -> bool:
    """Display-only: due within 5 business days."""
    if pir.status in ("received", "withdrawn"):
        return False
    if pir.response_due is None:
        return False
    due = pir.response_due.date() if isinstance(pir.response_due, datetime) else pir.response_due
    delta = (due - date.today()).days
    if delta < 0:
        return False  # overdue, not urgent
    # Count business days (rough: weekdays only)
    business_days = 0
    current = date.today()
    while current < due and business_days < 6:
        current = date.fromordinal(current.toordinal() + 1)
        if current.weekday() < 5:
            business_days += 1
    return business_days <= 5


def _enrich(pir: PIRRequest) -> dict:
    """Convert PIR model to dict with computed display properties."""
    return {
        "pir": pir,
        "is_overdue": _is_overdue(pir),
        "is_urgent": _is_urgent(pir),
        "needs_our_action": _needs_our_action(pir),
        "followup_overdue": _followup_overdue(pir),
    }


def _group_by_research_question(pirs: list[dict]) -> list[dict]:
    """Group PIRs by research sub-question. PIRs with multiple SQs appear in each group."""
    groups = {
        "sq1": {"label": SQ_LABELS["sq1"], "key": "sq1", "entries": []},
        "sq2": {"label": SQ_LABELS["sq2"], "key": "sq2", "entries": []},
        "sq3": {"label": SQ_LABELS["sq3"], "key": "sq3", "entries": []},
        "sq4": {"label": SQ_LABELS["sq4"], "key": "sq4", "entries": []},
        "none": {"label": "Supporting (No Sub-Q)", "key": "none", "entries": []},
    }
    for entry in pirs:
        p = entry["pir"]
        placed = False
        if p.sq1:
            groups["sq1"]["entries"].append(entry)
            placed = True
        if p.sq2:
            groups["sq2"]["entries"].append(entry)
            placed = True
        if p.sq3:
            groups["sq3"]["entries"].append(entry)
            placed = True
        if p.sq4:
            groups["sq4"]["entries"].append(entry)
            placed = True
        if not placed:
            groups["none"]["entries"].append(entry)
    return [g for g in groups.values() if g["entries"]]


def _group_by_recipient(pirs: list[dict]) -> list[dict]:
    """Group PIRs by recipient."""
    buckets: dict[str, list[dict]] = {}
    for entry in pirs:
        key = entry["pir"].recipient
        buckets.setdefault(key, []).append(entry)
    return [
        {"label": k, "key": k, "entries": v}
        for k, v in sorted(buckets.items())
    ]


def _group_by_status(pirs: list[dict]) -> list[dict]:
    """Group PIRs by status."""
    order = ["pending", "clarification", "responded", "processing",
             "partial", "received", "overdue_display", "withdrawn"]
    buckets: dict[str, list[dict]] = {}
    for entry in pirs:
        key = "overdue_display" if entry["is_overdue"] else entry["pir"].status
        buckets.setdefault(key, []).append(entry)
    status_labels = {
        "pending": "Pending",
        "clarification": "Clarification Requested",
        "responded": "Responded",
        "processing": "Processing",
        "partial": "Partial",
        "received": "Received",
        "overdue_display": "Overdue",
        "withdrawn": "Withdrawn",
    }
    return [
        {"label": status_labels.get(s, s.title()), "key": s, "entries": buckets[s]}
        for s in order if s in buckets
    ]


@router.get("/pir", response_class=HTMLResponse, name="pir_index")
async def pir_page(
    request: Request,
    group_by: str = "research_question",
    status: Optional[str] = None,
    sq: Optional[str] = None,
):
    """Main PIR tracker page."""
    engine = get_sync_engine()

    with Session(engine) as session:
        stmt = select(PIRRequest).order_by(PIRRequest.response_due.asc())

        if status and status != "all":
            if status == "overdue":
                # Can't filter overdue in SQL easily — filter in Python below
                pass
            else:
                stmt = stmt.where(PIRRequest.status == status)

        if sq in ("sq1", "sq2", "sq3", "sq4"):
            col = getattr(PIRRequest, sq)
            stmt = stmt.where(col == True)

        pirs_raw = session.execute(stmt).scalars().all()

        # Enrich with computed properties
        pirs = [_enrich(p) for p in pirs_raw]

        # Apply overdue filter in Python
        if status == "overdue":
            pirs = [p for p in pirs if p["is_overdue"]]

        # Summary stats (always computed from full dataset for header cards)
        all_pirs_stmt = select(PIRRequest)
        all_pirs = session.execute(all_pirs_stmt).scalars().all()
        all_enriched = [_enrich(p) for p in all_pirs]

        stats = {
            "total": len(all_enriched),
            "pending": sum(1 for e in all_enriched if e["pir"].status == "pending"),
            "clarification": sum(1 for e in all_enriched
                                 if e["pir"].status in ("clarification", "responded")),
            "received": sum(1 for e in all_enriched if e["pir"].status == "received"),
            "processing": sum(1 for e in all_enriched if e["pir"].status == "processing"),
            "overdue": sum(1 for e in all_enriched if e["is_overdue"]),
            "action_needed": sum(1 for e in all_enriched if e["needs_our_action"]),
            "followup_due": sum(1 for e in all_enriched if e["followup_overdue"]),
        }

    # Group results
    if group_by == "recipient":
        groups = _group_by_recipient(pirs)
    elif group_by == "status":
        groups = _group_by_status(pirs)
    else:
        groups = _group_by_research_question(pirs)

    return templates.TemplateResponse(
        request,
        "pir.html",
        {
            "groups": groups,
            "stats": stats,
            "group_by": group_by,
            "current_status": status or "all",
            "current_sq": sq or "",
        },
    )


@router.get("/pir/add", response_class=HTMLResponse, name="pir_add")
async def pir_add_form(request: Request):
    """Return add PIR form HTML for HTMX modal."""
    return templates.TemplateResponse(
        request, "partials/pir_form.html", {"pir": None},
    )


@router.get("/pir/{pir_id}/edit", response_class=HTMLResponse, name="pir_edit")
async def pir_edit_form(request: Request, pir_id: int):
    """Return edit PIR form HTML for HTMX modal."""
    engine = get_sync_engine()

    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()

        if not pir:
            return HTMLResponse("<p>PIR not found</p>", status_code=404)

        return templates.TemplateResponse(
            request, "partials/pir_form.html", {"pir": pir},
        )


class PIRCreateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pir_number: str
    label: str
    recipient: str
    recipient_email: Optional[str] = None
    tea_id: Optional[str] = None
    reference_number: Optional[str] = None
    sq1: bool = False
    sq2: bool = False
    sq3: bool = False
    sq4: bool = False
    priority: str = "MEDIUM"
    status: str = "pending"
    filed_date: str  # YYYY-MM-DD
    response_due: str  # YYYY-MM-DD
    received_date: Optional[str] = None
    note_id: Optional[int] = None
    description: Optional[str] = None
    status_notes: Optional[str] = None
    action_needed: Optional[str] = None
    next_followup_date: Optional[str] = None  # YYYY-MM-DD

    _validate_nn = field_validator(
        "pir_number", "label", "recipient",
        "filed_date", "response_due", mode="before",
    )(classmethod(_reject_null_or_empty))


def _apply_pir_data(pir: PIRRequest, data: PIRCreateUpdate):
    """Apply form data to a PIR model instance."""
    pir.pir_number = data.pir_number
    pir.label = data.label
    pir.recipient = data.recipient
    pir.recipient_email = data.recipient_email or None
    pir.tea_id = data.tea_id or None
    pir.reference_number = data.reference_number or None
    pir.sq1 = data.sq1
    pir.sq2 = data.sq2
    pir.sq3 = data.sq3
    pir.sq4 = data.sq4
    pir.priority = data.priority
    pir.status = data.status
    pir.filed_date = datetime.strptime(data.filed_date, "%Y-%m-%d")
    pir.response_due = datetime.strptime(data.response_due, "%Y-%m-%d")
    pir.received_date = (
        datetime.strptime(data.received_date, "%Y-%m-%d")
        if data.received_date else None
    )
    pir.note_id = data.note_id
    pir.description = data.description or None
    pir.status_notes = data.status_notes or None
    pir.action_needed = data.action_needed or None
    pir.next_followup_date = (
        datetime.strptime(data.next_followup_date, "%Y-%m-%d")
        if data.next_followup_date else None
    )


@router.post("/pir", response_class=HTMLResponse, name="pir_create")
async def pir_create(data: PIRCreateUpdate):
    """Create a new PIR."""
    engine = get_sync_engine()

    with Session(engine) as session:
        pir = PIRRequest()
        _apply_pir_data(pir, data)
        session.add(pir)
        session.commit()

    return HTMLResponse('<p class="success-text">PIR created.</p>')


@router.put("/pir/{pir_id}", response_class=HTMLResponse, name="pir_update")
async def pir_update(pir_id: int, data: PIRCreateUpdate):
    """Update an existing PIR."""
    engine = get_sync_engine()

    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()

        if not pir:
            return HTMLResponse("<p>PIR not found</p>", status_code=404)

        _apply_pir_data(pir, data)
        session.commit()

    return HTMLResponse('<p class="success-text">PIR updated.</p>')


class StatusUpdate(BaseModel):
    status: str
    status_notes: Optional[str] = None
    response_due: Optional[str] = None  # YYYY-MM-DD


@router.post("/pir/{pir_id}/status", response_class=HTMLResponse, name="pir_status_update")
async def pir_status_update(pir_id: int, data: StatusUpdate):
    """Quick status update for a PIR."""
    engine = get_sync_engine()

    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()

        if not pir:
            return HTMLResponse("<p>PIR not found</p>", status_code=404)

        pir.status = data.status
        if data.status_notes:
            pir.status_notes = data.status_notes
        if data.response_due:
            pir.response_due = datetime.strptime(data.response_due, "%Y-%m-%d")
        if data.status == "received":
            pir.received_date = datetime.now(timezone.utc)
        session.commit()

    # Return updated row snippet for HTMX swap
    return HTMLResponse(
        f'<span class="badge badge-{data.status}">{data.status.title()}</span>'
    )


@router.delete("/pir/{pir_id}", response_class=HTMLResponse, name="pir_delete")
async def pir_delete(pir_id: int):
    """Delete a PIR."""
    engine = get_sync_engine()

    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()

        if pir:
            session.delete(pir)
            session.commit()

    return HTMLResponse("")


# ── JSON API ───────────────────────────────────────────────────────────────


def _pir_to_dict(pir: PIRRequest) -> dict:
    """Serialize a PIRRequest to a JSON-safe dict."""
    def _dt(val):
        if val is None:
            return None
        return val.isoformat() if isinstance(val, (datetime, date)) else str(val)

    return {
        "id": pir.id,
        "pir_number": pir.pir_number,
        "label": pir.label,
        "recipient": pir.recipient,
        "recipient_email": pir.recipient_email,
        "tea_id": pir.tea_id,
        "reference_number": pir.reference_number,
        "sq1": pir.sq1,
        "sq2": pir.sq2,
        "sq3": pir.sq3,
        "sq4": pir.sq4,
        "priority": pir.priority,
        "status": pir.status,
        "filed_date": _dt(pir.filed_date),
        "response_due": _dt(pir.response_due),
        "received_date": _dt(pir.received_date),
        "note_id": pir.note_id,
        "description": pir.description,
        "status_notes": pir.status_notes,
        "action_needed": pir.action_needed,
        "next_followup_date": _dt(pir.next_followup_date),
        "created_at": _dt(pir.created_at),
        "updated_at": _dt(pir.updated_at),
    }


class PIRPatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pir_number: Optional[str] = None
    label: Optional[str] = None
    recipient: Optional[str] = None
    recipient_email: Optional[str] = None
    tea_id: Optional[str] = None
    reference_number: Optional[str] = None
    sq1: Optional[bool] = None
    sq2: Optional[bool] = None
    sq3: Optional[bool] = None
    sq4: Optional[bool] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    filed_date: Optional[str] = None
    response_due: Optional[str] = None
    received_date: Optional[str] = None
    note_id: Optional[int] = None
    description: Optional[str] = None
    status_notes: Optional[str] = None
    action_needed: Optional[str] = None
    next_followup_date: Optional[str] = None

    _validate_nn = field_validator(
        "pir_number", "label", "recipient",
        "filed_date", "response_due", mode="before",
    )(classmethod(_reject_null_or_empty))


@router.get("/api/pir/{pir_id}", name="api_pir_get")
async def pir_get_json(pir_id: int):
    """JSON API: Get a PIR by ID."""
    engine = get_sync_engine()
    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()
        if not pir:
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return JSONResponse(_pir_to_dict(pir))


@router.patch("/api/pir/{pir_id}", name="api_pir_patch")
async def pir_patch_json(pir_id: int, data: PIRPatchUpdate):
    """JSON API: Partial update a PIR."""
    engine = get_sync_engine()
    with Session(engine) as session:
        pir = session.execute(
            select(PIRRequest).where(PIRRequest.id == pir_id)
        ).scalar_one_or_none()
        if not pir:
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        for field, value in data.model_dump(exclude_unset=True).items():
            if field in ("filed_date", "response_due",
                         "received_date", "next_followup_date") and value:
                value = datetime.strptime(value, "%Y-%m-%d")
            setattr(pir, field, value)
        pir.updated_at = datetime.now(timezone.utc)
        try:
            session.commit()
        except IntegrityError as e:
            session.rollback()
            if "unique" in str(e.orig).lower():
                return JSONResponse(
                    {"detail": "pir_number must be unique"},
                    status_code=409,
                )
            return JSONResponse(
                {"detail": f"integrity error: {e.orig}"},
                status_code=409,
            )
        return JSONResponse(_pir_to_dict(pir))
