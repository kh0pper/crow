"""
Gmail API tools — thread search/read, draft creation, label management.

Uses classic gmail.googleapis.com REST API via google-api-python-client.
Scopes: gmail.readonly + gmail.compose + gmail.modify (granular, as
required by Google Workspace — the full-mailbox mail.google.com superset
is NOT required for these operations).

All tools return the {"success": bool, "data"?: dict, "error"?: str}
shape the handle_google_errors decorator enforces.
"""

import asyncio
import base64
import logging
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import make_msgid
from typing import Optional

from .auth import get_gmail_service
from .guardrails import handle_google_errors

# Self-send allowlist. EMPTY by default — gmail_send_to_self is the ONLY tool
# that actually sends (not drafts), so it is disabled until you opt in by
# listing your own address(es) in GMAIL_SEND_TO_SELF_ALLOWLIST=email1,email2.
# Restricting sends to your own addresses prevents a buggy or jailbroken agent
# from emailing third parties without review.
_DEFAULT_SELF_ALLOWLIST: tuple[str, ...] = ()


def _self_send_allowlist() -> set[str]:
    raw = os.environ.get("GMAIL_SEND_TO_SELF_ALLOWLIST", "")
    if raw.strip():
        return {e.strip().lower() for e in raw.split(",") if e.strip()}
    return {e.lower() for e in _DEFAULT_SELF_ALLOWLIST}


def _markdown_to_html(md_body: str) -> str:
    """
    Convert a markdown string to HTML for the multipart/alternative HTML part.
    Uses markdown-it-py (already a transitive dep of fastmcp). Falls back to
    a permissive line-break-preserving wrap if the import ever fails so the
    bot's email pipeline degrades to plain-but-readable rather than 500.
    """
    try:
        from markdown_it import MarkdownIt
        md = MarkdownIt("commonmark", {"html": False, "linkify": True, "breaks": True})
        md.enable("table")
        return md.render(md_body)
    except Exception as e:
        logger.warning("markdown-it render failed (%s); falling back to <pre>", e)
        escaped = (
            md_body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        return f"<pre style='font-family:ui-monospace,monospace;white-space:pre-wrap'>{escaped}</pre>"


def _encode_message_multipart(
    to: str,
    subject: str,
    text_body: str,
    html_body: str,
    cc: Optional[str] = None,
    bcc: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> str:
    """
    Build a multipart/alternative message with both a plain-text and an HTML
    part. Gmail / iOS Mail / Outlook will pick whichever they render.
    """
    msg = MIMEMultipart("alternative")
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc
    if bcc:
        msg["Bcc"] = bcc
    if reply_to:
        msg["Reply-To"] = reply_to
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    msg["Message-ID"] = make_msgid()
    # The order matters: clients prefer the LAST acceptable part. Plain text
    # first so HTML wins for renderers that support it.
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

logger = logging.getLogger(__name__)


# ---------- internal helpers ----------

def _encode_message(
    to: str,
    subject: str,
    body: str,
    cc: Optional[str] = None,
    bcc: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> str:
    msg = MIMEMultipart("alternative")
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc
    if bcc:
        msg["Bcc"] = bcc
    if reply_to:
        msg["Reply-To"] = reply_to
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    msg["Message-ID"] = make_msgid()
    msg.attach(MIMEText(body, "plain", "utf-8"))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")


def _pluck_header(payload: dict, name: str) -> Optional[str]:
    for h in payload.get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value")
    return None


def _clean_id(value):
    """
    Normalize an id string that an LLM may have wrapped in extra quotes or
    whitespace before passing as a tool argument. Returns None for None /
    empty / "null" sentinel; otherwise strips surrounding whitespace and any
    paired surrounding " or ' characters. Bot agents (especially smaller
    local models) routinely emit `thread_id = "abc"` style values; without
    this normalization the Gmail REST API rejects them with "Invalid id".
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() == "null":
        return None
    while len(s) >= 2 and s[0] == s[-1] and s[0] in ("\"", "'"):
        s = s[1:-1].strip()
    return s or None


def _extract_body(payload: dict) -> str:
    mime = payload.get("mimeType", "")
    if mime.startswith("text/plain"):
        data = payload.get("body", {}).get("data", "")
        if data:
            try:
                return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            except Exception:
                return ""
    out = []
    for part in payload.get("parts", []) or []:
        out.append(_extract_body(part))
    return "".join(out)


_LABEL_CACHE: dict[str, str] = {}


async def _resolve_label_names(names: list[str]) -> list[str]:
    if not names:
        return []
    if not _LABEL_CACHE:
        service = get_gmail_service()
        result = await asyncio.to_thread(
            lambda: service.users().labels().list(userId="me").execute()
        )
        for lbl in result.get("labels", []):
            _LABEL_CACHE[lbl["name"]] = lbl["id"]
            _LABEL_CACHE[lbl["id"]] = lbl["id"]
    resolved = []
    for n in names:
        if n in _LABEL_CACHE:
            resolved.append(_LABEL_CACHE[n])
        elif n.upper() in ("INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "SENT", "DRAFT", "IMPORTANT"):
            resolved.append(n.upper())
        else:
            raise ValueError(f"Unknown label: {n}")
    return resolved


# ---------- tool surface ----------

@handle_google_errors
async def gmail_search_threads(query: str, max_results: int = 20) -> dict:
    """
    Search Gmail threads by query string. `query` uses Gmail search syntax
    (e.g. 'from:foo@bar.com newer_than:7d', 'label:inbox -label:newsletters').
    """
    service = get_gmail_service()
    result = await asyncio.to_thread(
        lambda: service.users().threads().list(
            userId="me", q=query, maxResults=max_results
        ).execute()
    )
    threads = result.get("threads", [])
    items = []
    for t in threads:
        try:
            full = await asyncio.to_thread(
                lambda tid=t["id"]: service.users().threads().get(
                    userId="me", id=tid, format="metadata",
                    metadataHeaders=["Subject", "From", "Date"],
                ).execute()
            )
            first_msg = (full.get("messages") or [{}])[0]
            payload = first_msg.get("payload", {}) or {}
            items.append({
                "thread_id": t["id"],
                "history_id": t.get("historyId"),
                "snippet": first_msg.get("snippet", ""),
                "message_count": len(full.get("messages", [])),
                "subject": _pluck_header(payload, "Subject"),
                "from": _pluck_header(payload, "From"),
                "date": _pluck_header(payload, "Date"),
                "label_ids": first_msg.get("labelIds", []),
            })
        except Exception as e:
            items.append({"thread_id": t["id"], "hydrate_error": str(e)})
    return {"success": True, "data": {"query": query, "count": len(items), "threads": items}}


@handle_google_errors
async def gmail_get_thread(thread_id: str) -> dict:
    """Get the full content of a Gmail thread — all messages with headers and plain-text bodies."""
    thread_id = _clean_id(thread_id)
    if not thread_id:
        return {"success": False, "error": "thread_id is required"}
    service = get_gmail_service()
    result = await asyncio.to_thread(
        lambda: service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    )
    messages = []
    for m in result.get("messages", []):
        payload = m.get("payload", {}) or {}
        messages.append({
            "message_id": m.get("id"),
            "internal_date": m.get("internalDate"),
            "snippet": m.get("snippet", ""),
            "label_ids": m.get("labelIds", []),
            "headers": {
                "subject": _pluck_header(payload, "Subject"),
                "from": _pluck_header(payload, "From"),
                "to": _pluck_header(payload, "To"),
                "cc": _pluck_header(payload, "Cc"),
                "date": _pluck_header(payload, "Date"),
                "message_id_header": _pluck_header(payload, "Message-ID"),
                "references": _pluck_header(payload, "References"),
                "in_reply_to": _pluck_header(payload, "In-Reply-To"),
            },
            "body_text": _extract_body(payload),
        })
    return {
        "success": True,
        "data": {
            "thread_id": thread_id,
            "history_id": result.get("historyId"),
            "message_count": len(messages),
            "messages": messages,
        },
    }


@handle_google_errors
async def gmail_create_draft(
    to: str,
    subject: str,
    body: str,
    thread_id: Optional[str] = None,
    cc: Optional[str] = None,
    bcc: Optional[str] = None,
) -> dict:
    """
    Create a Gmail draft (NOT sent — lands in Drafts folder). If `thread_id`
    is provided, the draft is attached to that thread and In-Reply-To /
    References headers are set so external clients thread correctly.
    """
    thread_id = _clean_id(thread_id)
    service = get_gmail_service()
    in_reply_to = None
    references = None
    if thread_id:
        try:
            thread = await asyncio.to_thread(
                lambda: service.users().threads().get(
                    userId="me", id=thread_id, format="metadata",
                    metadataHeaders=["Message-ID", "References"],
                ).execute()
            )
            messages = thread.get("messages", [])
            if messages:
                last_payload = messages[-1].get("payload", {}) or {}
                in_reply_to = _pluck_header(last_payload, "Message-ID")
                prior_refs = _pluck_header(last_payload, "References")
                if in_reply_to:
                    references = f"{prior_refs} {in_reply_to}".strip() if prior_refs else in_reply_to
        except Exception as e:
            logger.warning("thread-header resolve failed: %s", e)
    raw = _encode_message(to=to, subject=subject, body=body, cc=cc, bcc=bcc,
                          in_reply_to=in_reply_to, references=references)
    draft_request_body: dict = {"message": {"raw": raw}}
    if thread_id:
        draft_request_body["message"]["threadId"] = thread_id
    draft = await asyncio.to_thread(
        lambda: service.users().drafts().create(userId="me", body=draft_request_body).execute()
    )
    return {
        "success": True,
        "data": {
            "draft_id": draft["id"],
            "message_id": draft["message"]["id"],
            "thread_id": draft["message"].get("threadId"),
            "to": to,
            "subject": subject,
        },
    }


@handle_google_errors
async def gmail_send_to_self(
    to: str,
    subject: str,
    body: str,
    thread_id: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> dict:
    """
    SEND (not draft) an email FROM the authenticated account TO an allowlisted
    self address. Useful for notifications/digests so they arrive in your inbox
    instead of sitting in Drafts.

    The recipient MUST be in the self-send allowlist, which is EMPTY by default —
    set GMAIL_SEND_TO_SELF_ALLOWLIST=your@address to enable this tool. Any other
    recipient is rejected — this is NOT a general-purpose send. For drafts to
    external recipients, use gmail_create_draft.

    The body is rendered as both plain text (the input verbatim) AND
    markdown-converted HTML in a multipart/alternative message, so Gmail
    renders the formatting properly.

    If thread_id is provided, the sent message threads onto that conversation
    (In-Reply-To / References + Gmail threadId), matching gmail_create_draft.
    """
    to_clean = (to or "").strip().lower()
    if to_clean not in _self_send_allowlist():
        return {
            "success": False,
            "error": (
                f"gmail_send_to_self rejected: recipient '{to}' not in self-send "
                f"allowlist. This tool only sends to user-bound addresses. "
                f"For external recipients use gmail_create_draft."
            ),
        }
    thread_id = _clean_id(thread_id)
    service = get_gmail_service()
    in_reply_to = None
    references = None
    # When thread_id is provided, look up the thread's FIRST message (the
    # original notifier / conversation opener) to derive:
    #   - In-Reply-To header → the original RFC-822 Message-ID
    #   - Subject override     → "Re: <original subject>" (verbatim with Re: prefix)
    #
    # Recipient-side threading is driven by RFC-822 In-Reply-To AND subject
    # similarity, NOT by the sender's threadId. Using the FIRST message of the
    # thread rather than the LAST gives a stable anchor — the original
    # Message-ID, while the most-recent message may be on a diverged sub-thread.
    #
    # Subject override is critical: if the caller passes a subject like
    # "Ready to submit — 1 application" that does NOT share a stem with
    # the original notifier subject, Gmail will create a new thread at the
    # recipient regardless of In-Reply-To. Forcing "Re: <original subject>"
    # makes recipient-side threading deterministic.
    effective_subject = subject
    if thread_id:
        try:
            thread = await asyncio.to_thread(
                lambda: service.users().threads().get(
                    userId="me", id=thread_id, format="metadata",
                    metadataHeaders=["Message-ID", "References", "Subject"],
                ).execute()
            )
            messages = thread.get("messages", [])
            if messages:
                first_payload = messages[0].get("payload", {}) or {}
                in_reply_to = _pluck_header(first_payload, "Message-ID")
                prior_refs = _pluck_header(first_payload, "References")
                original_subject = _pluck_header(first_payload, "Subject")
                if in_reply_to:
                    references = (
                        f"{prior_refs} {in_reply_to}".strip()
                        if prior_refs else in_reply_to
                    )
                if original_subject:
                    # Strip any existing Re: prefix to avoid Re: Re: stacking
                    stripped = original_subject.lstrip()
                    while stripped.lower().startswith("re:"):
                        stripped = stripped[3:].lstrip()
                    effective_subject = f"Re: {stripped}"
        except Exception as e:
            logger.warning("thread-header resolve failed: %s", e)

    # Optional explicit Reply-To header.
    reply_to_header = reply_to or None
    html_body = _markdown_to_html(body)
    raw = _encode_message_multipart(
        to=to, subject=effective_subject, text_body=body, html_body=html_body,
        in_reply_to=in_reply_to, references=references,
        reply_to=reply_to_header,
    )
    send_body: dict = {"raw": raw}
    if thread_id:
        send_body["threadId"] = thread_id
    sent = await asyncio.to_thread(
        lambda: service.users().messages().send(userId="me", body=send_body).execute()
    )
    return {
        "success": True,
        "data": {
            "message_id": sent["id"],
            "thread_id": sent.get("threadId"),
            "to": to,
            "subject": effective_subject,
            "subject_caller_supplied": subject,
            "subject_overridden": effective_subject != subject,
            "sent": True,
        },
    }


@handle_google_errors
async def gmail_label_thread(
    thread_id: str,
    add_labels: Optional[list[str]] = None,
    remove_labels: Optional[list[str]] = None,
) -> dict:
    """
    Add or remove labels on a Gmail thread. Accepts label names OR IDs;
    system labels (INBOX, UNREAD, STARRED, etc.) always work by name.
    """
    thread_id = _clean_id(thread_id)
    if not thread_id:
        return {"success": False, "error": "thread_id is required"}
    service = get_gmail_service()
    add_ids = await _resolve_label_names(add_labels or [])
    remove_ids = await _resolve_label_names(remove_labels or [])
    if not add_ids and not remove_ids:
        return {"success": False, "error": "at least one of add_labels / remove_labels must be non-empty"}
    await asyncio.to_thread(
        lambda: service.users().threads().modify(
            userId="me", id=thread_id,
            body={"addLabelIds": add_ids, "removeLabelIds": remove_ids},
        ).execute()
    )
    return {"success": True, "data": {"thread_id": thread_id, "added": add_ids, "removed": remove_ids}}


@handle_google_errors
async def gmail_archive(thread_id: str) -> dict:
    """Archive a Gmail thread (removes INBOX label)."""
    return await gmail_label_thread(thread_id, remove_labels=["INBOX"])


@handle_google_errors
async def gmail_list_labels() -> dict:
    """List all Gmail labels (system + user) with counts."""
    service = get_gmail_service()
    result = await asyncio.to_thread(
        lambda: service.users().labels().list(userId="me").execute()
    )
    labels = [
        {
            "id": lbl["id"], "name": lbl["name"], "type": lbl.get("type"),
            "messages_total": lbl.get("messagesTotal"),
            "messages_unread": lbl.get("messagesUnread"),
            "threads_total": lbl.get("threadsTotal"),
            "threads_unread": lbl.get("threadsUnread"),
        }
        for lbl in result.get("labels", [])
    ]
    return {"success": True, "data": {"count": len(labels), "labels": labels}}


@handle_google_errors
async def gmail_create_label(
    name: str,
    label_list_visibility: str = "labelShow",
    message_list_visibility: str = "show",
) -> dict:
    """
    Create a new Gmail label. `name` may contain '/' to nest under a parent
    (e.g. 'bot/echo-bot/processed' nests under 'bot/echo-bot' which nests
    under 'bot'). Returns the new label's id; idempotent if a label with the
    same name already exists (returns the existing id with already_existed=true).
    """
    service = get_gmail_service()
    existing = await asyncio.to_thread(
        lambda: service.users().labels().list(userId="me").execute()
    )
    for lbl in existing.get("labels", []):
        if lbl.get("name") == name:
            _LABEL_CACHE[name] = lbl["id"]
            _LABEL_CACHE[lbl["id"]] = lbl["id"]
            return {
                "success": True,
                "data": {"id": lbl["id"], "name": name, "already_existed": True},
            }
    body = {
        "name": name,
        "labelListVisibility": label_list_visibility,
        "messageListVisibility": message_list_visibility,
    }
    created = await asyncio.to_thread(
        lambda: service.users().labels().create(userId="me", body=body).execute()
    )
    _LABEL_CACHE[name] = created["id"]
    _LABEL_CACHE[created["id"]] = created["id"]
    return {
        "success": True,
        "data": {
            "id": created["id"],
            "name": created.get("name", name),
            "type": created.get("type"),
            "already_existed": False,
        },
    }


@handle_google_errors
async def gmail_create_filter(
    add_labels: Optional[list[str]] = None,
    remove_labels: Optional[list[str]] = None,
    from_address: Optional[str] = None,
    to_address: Optional[str] = None,
    subject: Optional[str] = None,
    query: Optional[str] = None,
    negated_query: Optional[str] = None,
    has_attachment: Optional[bool] = None,
    exclude_chats: Optional[bool] = None,
    mark_as_read: bool = False,
    archive: bool = False,
    forward: Optional[str] = None,
) -> dict:
    """
    Create a Gmail filter rule. At least one criterion (from_address,
    to_address, subject, query, etc.) and one action (add_labels,
    remove_labels, mark_as_read, archive, forward) must be supplied.

    Label names are auto-resolved to label IDs; create any new labels
    with gmail_create_label FIRST. Returns the new filter's id.

    Filters are immutable — to edit, delete via the Gmail UI and recreate.
    """
    service = get_gmail_service()

    criteria: dict = {}
    if from_address:
        criteria["from"] = from_address
    if to_address:
        criteria["to"] = to_address
    if subject:
        criteria["subject"] = subject
    if query:
        criteria["query"] = query
    if negated_query:
        criteria["negatedQuery"] = negated_query
    if has_attachment is not None:
        criteria["hasAttachment"] = has_attachment
    if exclude_chats is not None:
        criteria["excludeChats"] = exclude_chats
    if not criteria:
        return {"success": False, "error": "at least one criterion (from_address, to_address, subject, query, etc.) is required"}

    action: dict = {}
    add_ids = await _resolve_label_names(add_labels or [])
    remove_ids = await _resolve_label_names(remove_labels or [])
    if mark_as_read:
        remove_ids = list({*remove_ids, "UNREAD"})
    if archive:
        remove_ids = list({*remove_ids, "INBOX"})
    if add_ids:
        action["addLabelIds"] = add_ids
    if remove_ids:
        action["removeLabelIds"] = remove_ids
    if forward:
        action["forward"] = forward
    if not action:
        return {"success": False, "error": "at least one action (add_labels, remove_labels, mark_as_read, archive, forward) is required"}

    body = {"criteria": criteria, "action": action}
    created = await asyncio.to_thread(
        lambda: service.users().settings().filters().create(userId="me", body=body).execute()
    )
    return {
        "success": True,
        "data": {
            "id": created["id"],
            "criteria": created.get("criteria", criteria),
            "action": created.get("action", action),
        },
    }
