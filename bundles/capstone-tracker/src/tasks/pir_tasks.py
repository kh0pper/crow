"""
PIR audit digest + email monitoring.

Originally Celery tasks in canvas-companion. In the capstone-tracker bundle
these are plain functions invoked by crow-gateway's scheduler.js via HTTP
POST to /internal/run-pir-audit and /internal/run-pir-email-monitor
(see plan § 4.6 + § 4.0.2).
"""

import email as email_lib
import imaplib
import logging
import os
import re
from datetime import date, datetime, timedelta
from email.header import decode_header

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _get_engine():
    from src.models.database import get_sync_engine
    return get_sync_engine()


# ── PIR Audit Digest ──────────────────────────────────────────────────────


def pir_audit_digest():
    """
    Weekly PIR audit: find overdue PIRs, past-due follow-ups, and stale
    action_needed items. Creates a note and optionally sends an email digest.
    """
    from src.models.database import PIRRequest

    engine = _get_engine()
    today = date.today()

    with Session(engine) as session:
        active_pirs = session.execute(
            select(PIRRequest).where(
                PIRRequest.status.notin_(["received", "withdrawn"])
            ).order_by(PIRRequest.response_due.asc())
        ).scalars().all()

        overdue = []
        followup_due = []
        action_needed = []
        stale_processing = []

        for pir in active_pirs:
            due = (pir.response_due.date()
                   if isinstance(pir.response_due, datetime) else pir.response_due)

            if due and due < today and pir.status in ("pending", "clarification", "processing"):
                days_late = (today - due).days
                overdue.append((pir, days_late))

            if pir.next_followup_date:
                fdate = (pir.next_followup_date.date()
                         if isinstance(pir.next_followup_date, datetime)
                         else pir.next_followup_date)
                if fdate <= today:
                    followup_due.append((pir, (today - fdate).days))

            if pir.action_needed:
                action_needed.append(pir)

            if pir.status == "processing" and pir.updated_at:
                updated = (pir.updated_at.date()
                           if isinstance(pir.updated_at, datetime) else pir.updated_at)
                if (today - updated).days > 14:
                    stale_processing.append((pir, (today - updated).days))

    lines = [f"# PIR Audit Digest — {today.strftime('%B %d, %Y')}\n"]

    if not (overdue or followup_due or action_needed or stale_processing):
        lines.append("All PIRs are on track. No issues found.\n")
        logger.info("PIR audit: no issues found")
        return {"status": "clean", "date": str(today)}

    if overdue:
        lines.append(f"## Overdue ({len(overdue)})\n")
        for pir, days in overdue:
            lines.append(
                f"- **{pir.pir_number}** ({pir.recipient}): "
                f"{days} days late — {pir.label}"
            )
        lines.append("")

    if followup_due:
        lines.append(f"## Follow-up Due ({len(followup_due)})\n")
        for pir, days in followup_due:
            lines.append(
                f"- **{pir.pir_number}** ({pir.recipient}): "
                f"follow-up {'today' if days == 0 else f'{days} days overdue'}"
            )
        lines.append("")

    if action_needed:
        lines.append(f"## Our Action Needed ({len(action_needed)})\n")
        for pir in action_needed:
            lines.append(
                f"- **{pir.pir_number}** ({pir.recipient}): {pir.action_needed}"
            )
        lines.append("")

    if stale_processing:
        lines.append(f"## Stale Processing ({len(stale_processing)})\n")
        for pir, days in stale_processing:
            lines.append(
                f"- **{pir.pir_number}** ({pir.recipient}): "
                f"no update in {days} days — {pir.label}"
            )
        lines.append("")

    digest_text = "\n".join(lines)
    logger.info(
        "PIR audit: %d overdue, %d follow-up due, %d action needed, %d stale",
        len(overdue), len(followup_due), len(action_needed), len(stale_processing),
    )

    _save_digest_note(digest_text, today)
    _send_digest_email(digest_text, today, len(overdue), len(followup_due),
                       len(action_needed))

    return {
        "status": "issues_found",
        "date": str(today),
        "overdue": len(overdue),
        "followup_due": len(followup_due),
        "action_needed": len(action_needed),
        "stale": len(stale_processing),
    }


def _save_digest_note(digest_text: str, today: date):
    base = os.environ["CAPSTONE_TRACKER_INTERNAL_URL"].rstrip("/")
    try:
        resp = httpx.post(f"{base}/api/notes", json={
            "title": f"PIR Audit Digest — {today.strftime('%b %d, %Y')}",
            "note_type": "text",
            "content": digest_text,
            "tags": ["pir-audit", "capstone", "insd-5941"],
        }, timeout=10.0)
        if resp.status_code == 200:
            logger.info("PIR audit note created")
        else:
            logger.warning("Failed to create audit note: %s", resp.status_code)
    except Exception as e:
        logger.warning("Failed to create audit note: %s", e)


def _send_digest_email(digest_text: str, today: date, overdue: int,
                       followup_due: int, action_needed: int):
    try:
        from src.services.email_service import get_email_service
        svc = get_email_service()

        subject = (
            f"PIR Audit: {overdue} overdue, {followup_due} follow-ups, "
            f"{action_needed} actions — {today.strftime('%b %d')}"
        )
        svc.send_email(
            subject=subject,
            body_text=digest_text,
            to_addr=os.environ.get("EMAIL_TO", "kevin.hopper@maestro.press"),
            caller="pir_audit",
            skip_rate_limit=True,
        )
        logger.info("PIR audit email sent")
    except Exception as e:
        logger.warning("Failed to send audit email: %s", e)


# ── PIR Email Monitoring ──────────────────────────────────────────────────


PIR_CONTACT_PATTERNS = [
    "pir@tea.texas.gov",
    "info@clevelandisd.org",
    "information.request@harmonytx.org",
    "information.request@ideapublicschools.org",
    "open_records@eisd.net",
    "sisley.carrillo@eisd.net",
    "recordrequests@iltexas.org",
    "austinisd@govqa.us",
    "openrecords@austinisd.org",
    "publicinformation@houstonisd.org",
    "openrecords@fwisd.org",
    "publicinforequest@dallasisd.org",
]

PIR_SUBJECT_PATTERNS = [
    r"public information",
    r"open records",
    r"PIR\s*#?\s*\d+",
    r"ORR?\s*#?\s*\d+",
    r"TPIA",
    r"cost estimate",
    r"responsive records",
]


def pir_email_monitor():
    """Scan Gmail for unread emails from known PIR contacts."""
    imap_host = os.environ.get("IMAP_HOST", "imap.gmail.com")
    imap_port = int(os.environ.get("IMAP_PORT", "993"))
    user = os.environ["SMTP_USERNAME"]
    password = os.environ["SMTP_PASSWORD"]

    try:
        mail = imaplib.IMAP4_SSL(imap_host, imap_port)
        mail.login(user, password)
        mail.select("INBOX")
    except Exception as e:
        logger.error("IMAP connection failed: %s", e)
        return {"status": "error", "message": str(e)}

    since_date = (date.today() - timedelta(days=7)).strftime("%d-%b-%Y")
    unprocessed = []

    for contact in PIR_CONTACT_PATTERNS:
        try:
            search_status, messages = mail.search(
                None,
                f'(FROM "{contact}" UNSEEN SINCE "{since_date}")'
            )
            if search_status != "OK" or not messages[0]:
                continue

            msg_ids = messages[0].split()
            for msg_id in msg_ids:
                fetch_status, data = mail.fetch(msg_id, "(BODY.PEEK[HEADER])")
                if fetch_status != "OK" or not data or not data[0]:
                    continue

                raw = data[0][1] if isinstance(data[0], tuple) else data[0]
                if not isinstance(raw, bytes):
                    continue
                msg = email_lib.message_from_bytes(raw)
                subject = _decode_header(msg.get("Subject", ""))
                from_addr = msg.get("From", "")
                msg_date = msg.get("Date", "")

                is_pir = any(
                    re.search(pat, subject, re.IGNORECASE)
                    for pat in PIR_SUBJECT_PATTERNS
                )

                if is_pir:
                    unprocessed.append({
                        "from": from_addr,
                        "subject": subject,
                        "date": msg_date,
                        "imap_id": msg_id.decode(),
                    })

        except Exception as e:
            logger.warning("Error scanning %s: %s", contact, e)
            continue

    mail.logout()

    if unprocessed:
        logger.warning(
            "PIR email monitor: %d unread PIR-related emails found",
            len(unprocessed),
        )
        _save_email_alert(unprocessed)
    else:
        logger.info("PIR email monitor: no unread PIR emails")

    return {
        "status": "found" if unprocessed else "clean",
        "unread_count": len(unprocessed),
        "emails": unprocessed,
    }


def _decode_header(header_val: str) -> str:
    if not header_val:
        return ""
    parts = decode_header(header_val)
    decoded = []
    for content, charset in parts:
        if isinstance(content, bytes):
            decoded.append(content.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(content)
    return " ".join(decoded)


def _save_email_alert(unprocessed: list[dict]):
    base = os.environ["CAPSTONE_TRACKER_INTERNAL_URL"].rstrip("/")
    lines = [f"# Unread PIR Emails — {date.today().strftime('%B %d, %Y')}\n"]
    lines.append(f"Found {len(unprocessed)} unread PIR-related emails:\n")

    for msg in unprocessed:
        lines.append(f"- **From:** {msg['from']}")
        lines.append(f"  **Subject:** {msg['subject']}")
        lines.append(f"  **Date:** {msg['date']}\n")

    try:
        resp = httpx.post(f"{base}/api/notes", json={
            "title": f"Unread PIR Emails — {date.today().strftime('%b %d')}",
            "note_type": "text",
            "content": "\n".join(lines),
            "tags": ["pir-email-alert", "capstone"],
        }, timeout=10.0)
        if resp.status_code == 200:
            logger.info("PIR email alert note created")
    except Exception as e:
        logger.warning("Failed to create email alert note: %s", e)
