"""
Google Forms API v1 tools — read a form's structure and EDIT it in place
(add / update / delete questions) without recreating it, so the published
responder URL (QR codes, flyers, prior emails) is preserved.

Requirements:
  - the `forms.body` scope granted (see auth.SCOPES) — needs a re-auth after the
    scope is added;
  - the Google Forms API enabled in the OAuth client's GCP project
    (console.cloud.google.com -> APIs & Services -> enable "Google Forms API").

Forms model: a form has `info` (title/description) and an ordered list of `items`,
each with an `itemId`. A question item carries a `question` with a `questionId`,
`required`, and one of choiceQuestion / textQuestion / scaleQuestion / etc.
Editing is via forms.batchUpdate with createItem / updateItem / deleteItem requests;
createItem needs a `location.index` (append = current item count).

NOTE: this module deliberately does NOT read form responses. Add a separate,
clearly-scoped tool with forms.responses.readonly if that is ever needed.
"""

import asyncio
import logging
import os

from .auth import get_forms_service, get_script_service
from .forms_questions import _CHOICE_TYPES, _build_question  # noqa: F401
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)

# forms_set_destination: the REST Forms API cannot link a form to a response
# spreadsheet (it only READS `linkedSheetId`) — Apps Script's FormApp can. The
# tool therefore calls a tiny Apps Script "shim" project via scripts.run. See
# apps-script-shim/forms-destination-shim.gs for the shim source + deployment steps.
_SHIM_ENV = "GWS_FORMS_SHIM_SCRIPT_ID"
_SHIM_SETUP = (
    "forms_set_destination needs a one-time Apps Script shim deployment: "
    "(1) create a standalone Apps Script project with the source in "
    "apps-script-shim/forms-destination-shim.gs; (2) in the script's Project "
    "Settings, attach it to the SAME GCP project as this server's OAuth client; "
    "(3) deploy it as an API Executable; (4) grant this server's token the "
    "https://www.googleapis.com/auth/forms scope (add to auth.SCOPES + re-auth); "
    f"(5) set {_SHIM_ENV}=<the shim's Script ID> in the server's environment "
    "(or pass shim_script_id)."
)



def _summarize_item(item: dict) -> dict:
    """Reduce a raw Forms item to a compact digest for forms_get_structure."""
    out = {"item_id": item.get("itemId"), "title": item.get("title", "")}
    if "pageBreakItem" in item:
        out["kind"] = "page_break (section)"
        return out
    if "textItem" in item:
        out["kind"] = "text (descriptive)"
        return out
    if "imageItem" in item:
        out["kind"] = "image"
        return out
    if "videoItem" in item:
        out["kind"] = "video"
        return out
    qi = item.get("questionItem")
    if qi:
        q = qi.get("question", {})
        out["question_id"] = q.get("questionId")
        out["required"] = bool(q.get("required", False))
        if "choiceQuestion" in q:
            cq = q["choiceQuestion"]
            out["kind"] = "choice"
            out["choice_type"] = cq.get("type")  # RADIO | CHECKBOX | DROP_DOWN
            out["options"] = [o.get("value") for o in cq.get("options", [])]
        elif "textQuestion" in q:
            out["kind"] = "paragraph_text" if q["textQuestion"].get("paragraph") else "short_text"
        elif "scaleQuestion" in q:
            out["kind"] = "scale"
        elif "dateQuestion" in q:
            out["kind"] = "date"
        elif "timeQuestion" in q:
            out["kind"] = "time"
        elif "fileUploadQuestion" in q:
            out["kind"] = "file_upload"
        else:
            out["kind"] = "question (other)"
        return out
    if "questionGroupItem" in item:
        out["kind"] = "question_group (grid)"
        return out
    out["kind"] = "other"
    return out


@handle_google_errors
async def forms_get_structure(form_id: str) -> dict:
    """Read a form's structure: title, the responder (public) URL, the linked
    response sheet if any, and every item as a compact digest (item_id, title,
    kind, and for choice questions: choice_type + options + required)."""
    svc = get_forms_service()
    res = await asyncio.to_thread(lambda: svc.forms().get(formId=form_id).execute())
    items = res.get("items", [])
    info = res.get("info", {})
    return {
        "success": True,
        "data": {
            "form_id": res.get("formId", form_id),
            "title": info.get("title", ""),
            "document_title": info.get("documentTitle", ""),
            "description": info.get("description", ""),
            "responder_uri": res.get("responderUri", ""),
            "revision_id": res.get("revisionId", ""),
            "linked_sheet_id": res.get("linkedSheetId"),
            "item_count": len(items),
            "items": [_summarize_item(it) for it in items],
        },
    }


@handle_google_errors
async def forms_batch_update(form_id: str, requests: list) -> dict:
    """Advanced: raw forms.batchUpdate passthrough. `requests` is a list of
    Forms API request objects (createItem / updateItem / deleteItem / moveItem /
    updateFormInfo / updateSettings). Returns the new revisionId + replies.
    Editing an existing form by id PRESERVES its published URL."""
    svc = get_forms_service()
    body = {"requests": requests, "includeFormInResponse": False}
    res = await asyncio.to_thread(
        lambda: svc.forms().batchUpdate(formId=form_id, body=body).execute()
    )
    return {
        "success": True,
        "data": {
            "form_id": form_id,
            "revision_id": res.get("form", {}).get("revisionId")
            or res.get("writeControl", {}).get("requiredRevisionId"),
            "replies": res.get("replies", []),
        },
    }


@handle_google_errors
async def forms_set_destination(
    form_id: str, spreadsheet_id: str, shim_script_id: str | None = None
) -> dict:
    """Link a form's responses to a Google Sheet (the UI's 'Link to Sheets').

    The REST Forms API cannot do this, so the call is delegated to an Apps
    Script shim (FormApp.setDestination) via scripts.run — see _SHIM_SETUP for
    the one-time deployment. `shim_script_id` overrides the GWS_FORMS_SHIM_SCRIPT_ID
    env var. Verifies the link afterwards by re-reading the form's linkedSheetId."""
    shim = (shim_script_id or os.environ.get(_SHIM_ENV, "")).strip()
    if not shim:
        return {
            "success": False,
            "error": f"No shim configured. {_SHIM_SETUP}",
            "data": {"form_id": form_id, "spreadsheet_id": spreadsheet_id},
        }

    svc = get_script_service()
    body = {
        "function": "setFormDestination",
        "parameters": [form_id, spreadsheet_id],
        "devMode": False,
    }
    res = await asyncio.to_thread(
        lambda: svc.scripts().run(scriptId=shim, body=body).execute()
    )
    if "error" in res:
        return {
            "success": False,
            "error": res["error"],
            "data": {
                "form_id": form_id,
                "spreadsheet_id": spreadsheet_id,
                "shim_script_id": shim,
                "hint": _SHIM_SETUP,
            },
        }

    # Verify: the authoritative check is the form's linkedSheetId.
    fsvc = get_forms_service()
    form = await asyncio.to_thread(lambda: fsvc.forms().get(formId=form_id).execute())
    linked = form.get("linkedSheetId")
    return {
        "success": bool(linked),
        "data": {
            "form_id": form_id,
            "spreadsheet_id": spreadsheet_id,
            "linked_sheet_id": linked,
            "verified": bool(linked),
            "shim_result": res.get("response", {}).get("result"),
        },
        **({} if linked else {"error": "shim ran but the form reports no linkedSheetId"}),
    }


_RESTRICTED_HINT = (
    "The responder link answers only to accounts in this Workspace organization "
    "(anonymous GET returned a sign-in page). No API setting lifts this; in the "
    "form's Settings > Responses turn off 'Restrict to users in <org> and trusted "
    "organizations' before sharing it outside the organization."
)


def _anonymous_status(url: str) -> int | None:
    """GET a URL with no credentials and return the HTTP status (None on a
    network error). Used to tell whether a form's responder page is public."""
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=15) as r:  # noqa: S310
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001
        return None


@handle_google_errors
async def forms_create(
    title: str,
    document_title: str | None = None,
    description: str | None = None,
    folder_id: str | None = None,
    questions: list | None = None,
    check_access: bool = True,
) -> dict:
    """Create a NEW Google Form (forms.create), then in one batchUpdate set the
    description and add `questions`, then move the file into `folder_id`.

    `title`: the title respondents see. `document_title`: the Drive file name
    (defaults to `title`). `questions`: list of {"title", "type", "options",
    "required"} using forms_add_question's vocabulary, created in list order.
    `check_access`: anonymous-fetch the responder URL and report whether the
    form is restricted to the organization (a Workspace default that no API
    setting changes; the returned hint says which UI toggle lifts it)."""
    svc = get_forms_service()
    info = {"title": title, "documentTitle": document_title or title}
    created = await asyncio.to_thread(lambda: svc.forms().create(body={"info": info}).execute())
    form_id = created["formId"]
    edit_url = f"https://docs.google.com/forms/d/{form_id}/edit"

    requests: list = []
    if description:
        requests.append(
            {"updateFormInfo": {"info": {"description": description}, "updateMask": "description"}}
        )
    titles = []
    for i, q in enumerate(questions or []):
        try:
            question = _build_question(q.get("type", "PARAGRAPH"), q.get("options"), q.get("required", False))
        except ValueError as e:
            return {
                "success": False,
                "error": f"question {i} ({q.get('title', '')!r}): {e}",
                "data": {"form_id": form_id, "edit_url": edit_url},
            }
        requests.append(
            {
                "createItem": {
                    "item": {"title": q.get("title", ""), "questionItem": {"question": question}},
                    "location": {"index": i},
                }
            }
        )
        titles.append(q.get("title", ""))
    replies = []
    if requests:
        body = {"requests": requests, "includeFormInResponse": False}
        res = await asyncio.to_thread(
            lambda: svc.forms().batchUpdate(formId=form_id, body=body).execute()
        )
        replies = res.get("replies", [])
    item_ids = [r["createItem"]["itemId"] for r in replies if "createItem" in r]

    moved = None
    if folder_id:
        from .drive import gdrive_move_file

        moved = await gdrive_move_file(form_id, folder_id)

    final = await asyncio.to_thread(lambda: svc.forms().get(formId=form_id).execute())
    responder = final.get("responderUri", "")
    access = None
    if check_access and responder:
        status = await asyncio.to_thread(_anonymous_status, responder)
        restricted = status != 200
        access = {"anonymous_http_status": status, "restricted_to_organization": restricted}
        if restricted:
            access["hint"] = _RESTRICTED_HINT

    return {
        "success": True,
        "data": {
            "form_id": form_id,
            "edit_url": edit_url,
            "responder_uri": responder,
            "title": title,
            "document_title": info["documentTitle"],
            "item_count": len(final.get("items", [])),
            "created_item_ids": item_ids,
            "created_item_titles": titles,
            "folder_id": folder_id,
            "moved": (moved or {}).get("data", {}).get("moved") if moved else None,
            "publish_settings": final.get("publishSettings"),
            "access": access,
        },
    }


@handle_google_errors
async def forms_add_question(
    form_id: str,
    title: str,
    type: str = "CHECKBOX",
    options: list | None = None,
    required: bool = False,
    index: int | None = None,
) -> dict:
    """Add ONE question to an existing form in place (URL preserved).

    `type`: CHECKBOX | RADIO | DROP_DOWN (need `options`), or SHORT_TEXT | PARAGRAPH.
    `options`: list of choice strings (choice types only).
    `required`: default False.
    `index`: 0-based position among items; None appends at the end.

    For choice types each option string becomes a {"value": ...}. Returns the new
    item's id (from the createItem reply)."""
    svc = get_forms_service()
    t = (type or "").upper()

    if index is None:
        cur = await asyncio.to_thread(lambda: svc.forms().get(formId=form_id).execute())
        index = len(cur.get("items", []))

    try:
        question = _build_question(t, options, required)
    except ValueError as e:
        return {"success": False, "error": str(e), "data": {"form_id": form_id}}

    request = {
        "createItem": {
            "item": {"title": title, "questionItem": {"question": question}},
            "location": {"index": int(index)},
        }
    }
    body = {"requests": [request], "includeFormInResponse": False}
    res = await asyncio.to_thread(
        lambda: svc.forms().batchUpdate(formId=form_id, body=body).execute()
    )
    replies = res.get("replies", [])
    new_id = None
    if replies and "createItem" in replies[0]:
        new_id = replies[0]["createItem"].get("itemId")
    return {
        "success": True,
        "data": {
            "form_id": form_id,
            "created_item_id": new_id,
            "index": index,
            "title": title,
            "type": t,
        },
    }
