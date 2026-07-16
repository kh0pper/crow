"""
Advocacy Communications Tracker — read-only list view.

Per-comm cadence: one row per email send / draft / reply / meeting /
op-ed pitch. Edits are made via direct SQL during sessions; this iteration
provides a dashboard view only (no CRUD UI).
"""

from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from src.models.database import AdvocacyComm, get_sync_engine
from src.templates_config import templates

router = APIRouter()


@router.get("/advocacy", response_class=HTMLResponse, name="advocacy_index")
async def advocacy_index(
    request: Request,
    status: Optional[str] = Query(None),
    phase: Optional[str] = Query(None),
    contact_org: Optional[str] = Query(None),
):
    """Read-only list of advocacy communications, sortable + filterable."""
    engine = get_sync_engine()
    with Session(engine) as session:
        stmt = select(AdvocacyComm).order_by(
            AdvocacyComm.sent_date.desc().nullslast(),
            AdvocacyComm.created_at.desc(),
        )
        if status:
            stmt = stmt.where(AdvocacyComm.status == status)
        if phase:
            stmt = stmt.where(AdvocacyComm.phase == phase)
        if contact_org:
            stmt = stmt.where(AdvocacyComm.contact_org == contact_org)
        comms = session.scalars(stmt).all()

        total = session.scalar(select(func.count()).select_from(AdvocacyComm)) or 0

        def count_status(s: str) -> int:
            return session.scalar(
                select(func.count()).select_from(AdvocacyComm).where(AdvocacyComm.status == s)
            ) or 0

        stats = {
            "total": total,
            "drafted": count_status("drafted"),
            "sent": count_status("sent"),
            "awaiting": count_status("awaiting-reply"),
            "replied": count_status("replied"),
            "stalled": count_status("stalled"),
        }

        all_rows = session.scalars(select(AdvocacyComm)).all()
        statuses = sorted({c.status for c in all_rows if c.status})
        phases = sorted({c.phase for c in all_rows if c.phase})
        orgs = sorted({c.contact_org for c in all_rows if c.contact_org})

    return templates.TemplateResponse(
        request,
        "advocacy.html",
        {
            "comms": comms,
            "stats": stats,
            "statuses": statuses,
            "phases": phases,
            "orgs": orgs,
            "filter_status": status,
            "filter_phase": phase,
            "filter_org": contact_org,
        },
    )
