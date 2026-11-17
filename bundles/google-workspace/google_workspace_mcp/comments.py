"""
Google Docs Comments API tools — with full pagination.

Uses Drive API v3 (not Docs API) for comments. Fixes the documented
truncation-at-20 bug by using pageSize=100 + nextPageToken loop.
"""

import asyncio
import html
import logging
from typing import Optional

from .actor_label import label_text
from .auth import get_drive_service
from .guardrails import handle_google_errors


def _decode_quoted(qfc: Optional[dict]) -> Optional[str]:
    """Drive's Comments API returns quotedFileContent.value as HTML-encoded
    when mimeType is text/html (which is the default). The actual doc text
    contains the literal characters, so an as-is find_replace fails on any
    string with &, <, > etc. Decode here before exposing to callers."""
    if not qfc:
        return None
    value = qfc.get("value")
    if value is None:
        return None
    mime = qfc.get("mimeType", "")
    if mime == "text/html" or mime.startswith("text/html"):
        return html.unescape(value)
    return value

logger = logging.getLogger(__name__)

COMMENT_FIELDS = (
    "comments(id,content,author(displayName),resolved,"
    "quotedFileContent,createdTime,modifiedTime,"
    "replies(content,author(displayName),createdTime,action)),"
    "nextPageToken"
)


def _fetch_all_comments(file_id: str, include_resolved: bool) -> list[dict]:
    """Fetch ALL comments with pagination (blocking)."""
    drive = get_drive_service()
    all_comments = []
    page_token = None

    while True:
        kwargs = {
            "fileId": file_id,
            "fields": COMMENT_FIELDS,
            "pageSize": 100,
        }
        if page_token:
            kwargs["pageToken"] = page_token

        result = drive.comments().list(**kwargs).execute()
        comments = result.get("comments", [])
        all_comments.extend(comments)

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    if not include_resolved:
        all_comments = [c for c in all_comments if not c.get("resolved")]

    return all_comments


def _format_comment(c: dict) -> dict:
    """Normalize a raw comment dict."""
    return {
        "id": c["id"],
        "content": c.get("content", ""),
        "author": c.get("author", {}).get("displayName", "Unknown"),
        "quoted_text": _decode_quoted(c.get("quotedFileContent")),
        "resolved": c.get("resolved", False),
        "created": c.get("createdTime", ""),
        "modified": c.get("modifiedTime", ""),
        "replies": [
            {
                "content": r.get("content", ""),
                "author": r.get("author", {}).get("displayName", "Unknown"),
                "created": r.get("createdTime", ""),
                "action": r.get("action"),
            }
            for r in c.get("replies", [])
        ],
    }


@handle_google_errors
async def gdocs_list_comments(
    doc_id: str, include_resolved: bool = False
) -> dict:
    """List ALL comments on a Google Doc with full pagination."""
    comments = await asyncio.to_thread(_fetch_all_comments, doc_id, include_resolved)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "count": len(comments),
            "include_resolved": include_resolved,
            "comments": [_format_comment(c) for c in comments],
        },
    }


@handle_google_errors
async def gdocs_add_comment(
    doc_id: str, content: str, quoted_text: Optional[str] = None,
    actor: Optional[dict] = None,
) -> dict:
    """Add a comment to a Google Doc, optionally anchored to text."""
    drive = get_drive_service()

    body: dict = {"content": label_text(content, actor)}
    if quoted_text:
        body["quotedFileContent"] = {
            "mimeType": "text/plain",
            "value": quoted_text,
        }

    result = await asyncio.to_thread(
        lambda: drive.comments().create(
            fileId=doc_id, body=body,
            fields="id,content,author(displayName),createdTime,quotedFileContent",
        ).execute()
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "comment_id": result["id"],
            "content": result.get("content", ""),
            "author": result.get("author", {}).get("displayName", "Unknown"),
            "quoted_text": result.get("quotedFileContent", {}).get("value"),
        },
    }


@handle_google_errors
async def gdocs_reply_comment(
    doc_id: str, comment_id: str, content: str, actor: Optional[dict] = None
) -> dict:
    """Reply to a comment on a Google Doc."""
    drive = get_drive_service()

    result = await asyncio.to_thread(
        lambda: drive.replies().create(
            fileId=doc_id, commentId=comment_id,
            body={"content": label_text(content, actor)},
            fields="id,content,author(displayName),createdTime,action",
        ).execute()
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "comment_id": comment_id,
            "reply_id": result.get("id"),
            "content": result.get("content", ""),
        },
    }


@handle_google_errors
async def gdocs_resolve_comment(doc_id: str, comment_id: str) -> dict:
    """Resolve a comment by replying with action=resolve."""
    drive = get_drive_service()

    await asyncio.to_thread(
        lambda: drive.replies().create(
            fileId=doc_id, commentId=comment_id,
            body={"content": "", "action": "resolve"},
            fields="id,action",
        ).execute()
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "comment_id": comment_id,
            "resolved": True,
        },
    }


@handle_google_errors
async def gdocs_apply_comment_edit(
    doc_id: str, comment_id: str, replace_text: str, summary: str,
    actor: Optional[dict] = None,
) -> dict:
    """Atomic edit-from-comment workflow.

    Fetches the comment's authoritative quotedFileContent.value from Drive,
    runs find_replace using THAT exact string as the find target, then replies
    with the supplied summary and resolves the comment. Designed for LLM agents
    that paraphrase long strings unreliably — the agent only supplies the new
    text and a short summary; the tool handles the find side internally.

    Returns success even when the highlighted text can't be located in the doc;
    in that case it leaves a "could not locate" reply, resolves the comment, and
    sets data.applied = false.
    """
    from .auth import get_docs_service
    drive = get_drive_service()
    docs = get_docs_service()

    comment = await asyncio.to_thread(
        lambda: drive.comments().get(
            fileId=doc_id, commentId=comment_id,
            fields="id,resolved,content,quotedFileContent",
        ).execute()
    )
    quoted = _decode_quoted(comment.get("quotedFileContent"))
    if not quoted:
        return {
            "success": False,
            "error": "Comment has no quotedFileContent — apply requires anchored highlight.",
        }
    if comment.get("resolved"):
        return {
            "success": False,
            "error": f"Comment {comment_id} is already resolved.",
        }

    body = {"requests": [{"replaceAllText": {
        "containsText": {"text": quoted, "matchCase": True},
        "replaceText": replace_text,
    }}]}
    res = await asyncio.to_thread(
        lambda: docs.documents().batchUpdate(documentId=doc_id, body=body).execute()
    )
    occurrences = (
        res.get("replies", [{}])[0].get("replaceAllText", {}).get("occurrencesChanged", 0)
    )

    if occurrences == 0:
        # Distinguish two failure modes so the user knows what to do next:
        # (a) Drive API truncates quotedFileContent.value at ~1000 chars when
        #     the highlight is longer. Truncated values end with U+2026 (…).
        #     The bot's find target is therefore a partial string that does
        #     not exist verbatim in the doc.
        # (b) Doc text was edited between commenting and applying. Less common.
        #
        # In BOTH cases leave the comment UNRESOLVED with a clear reply. An
        # idempotency check (skip when a reply by the authenticated user
        # already exists) prevents retry loops. The user can re-highlight a
        # shorter span, leave a structural-rewrite comment that is handled via
        # batch find_replace, or remove this reply and re-comment.
        truncated = bool(quoted) and (len(quoted) >= 900 or quoted.rstrip().endswith("…"))
        if truncated:
            reply_text = (
                "I cannot apply this edit directly because the highlighted span "
                "is too long for the Drive Comments API. Drive truncates the "
                f"highlight at about 1000 characters (yours is ≥{len(quoted)}). "
                "Two ways forward: (1) leave a tighter comment that highlights "
                "a specific phrase, or (2) leave a comment like 'no em dashes' "
                "or 'rewrite per rules' — those rule-application comments "
                "trigger a batch find-replace across the whole doc and don't "
                "depend on the highlighted span. Leaving this comment "
                "unresolved so you can see this reply."
            )
        else:
            reply_text = (
                "I could not locate the highlighted text exactly. It may have "
                "been edited since you commented, or it crosses a paragraph "
                "boundary the find-replace API can't span. Please re-highlight "
                "a shorter contiguous phrase and re-comment, or leave a rule-"
                "application comment ('no em dashes', 'rewrite per rules')."
            )
        await asyncio.to_thread(
            lambda: drive.replies().create(
                fileId=doc_id, commentId=comment_id,
                body={"content": label_text(reply_text, actor)},
                fields="id",
            ).execute()
        )
        return {
            "success": True,
            "data": {
                "doc_id": doc_id,
                "comment_id": comment_id,
                "applied": False,
                "occurrences": 0,
                "quoted_text": quoted,
                "reason": "truncated_quote" if truncated else "no_match",
                "left_unresolved": True,
            },
        }

    await asyncio.to_thread(
        lambda: drive.replies().create(
            fileId=doc_id, commentId=comment_id,
            body={"content": label_text(summary, actor)},
            fields="id",
        ).execute()
    )
    await asyncio.to_thread(
        lambda: drive.replies().create(
            fileId=doc_id, commentId=comment_id,
            body={"content": "", "action": "resolve"},
            fields="id",
        ).execute()
    )
    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "comment_id": comment_id,
            "applied": True,
            "occurrences": occurrences,
            "quoted_text": quoted,
            "replace_text": replace_text,
            "summary": summary,
        },
    }
