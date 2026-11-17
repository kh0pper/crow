"""
Google Apps Script API v1 tools — read / edit / push Apps Script project
source (bound or standalone) and, where a deployment allows, run functions.

Requirements:
  - the `script.projects` scope granted (see auth.SCOPES) — needs a re-auth
    after that scope is added;
  - the Apps Script API enabled in the OAuth client's GCP project;
  - the user's Apps Script API setting turned ON at
    https://script.google.com/home/usersettings.

Apps Script file model: each project is a flat list of files, each
{name, type, source}. `name` has NO extension ('Code', 'appsscript', 'Index').
`type` is SERVER_JS (.gs), JSON (the appsscript manifest), or HTML. updateContent
replaces the ENTIRE file set and MUST include the manifest, so single-file edits
go through apps_script_update_file (get -> swap one -> push the full set back).
"""

import asyncio
import logging

from .auth import get_script_service
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


@handle_google_errors
async def apps_script_get_content(script_id: str) -> dict:
    """Read every file in an Apps Script project (the .gs source + the
    appsscript.json manifest + any HTML)."""
    svc = get_script_service()
    res = await asyncio.to_thread(
        lambda: svc.projects().getContent(scriptId=script_id).execute()
    )
    files = res.get("files", [])
    return {
        "success": True,
        "data": {
            "script_id": res.get("scriptId", script_id),
            "file_count": len(files),
            "files": [
                {
                    "name": f.get("name"),
                    "type": f.get("type"),
                    "source": f.get("source", ""),
                }
                for f in files
            ],
        },
    }


@handle_google_errors
async def apps_script_update_file(
    script_id: str, file_name: str, source: str, file_type: str = "SERVER_JS"
) -> dict:
    """Replace the source of ONE file, leaving every other file (incl. the
    manifest) untouched. Fetches current content, swaps the named file's source
    (or appends it if absent), and pushes the full set back.

    `file_name` is the API name with NO extension ('Code', not 'Code.gs') — use
    the name as returned by apps_script_get_content. `file_type` (only used when
    creating a new file) is SERVER_JS, HTML, or JSON.
    """
    svc = get_script_service()
    cur = await asyncio.to_thread(
        lambda: svc.projects().getContent(scriptId=script_id).execute()
    )
    files = cur.get("files", [])
    found = False
    for f in files:
        if f.get("name") == file_name:
            f["source"] = source
            found = True
            break
    if not found:
        files.append({"name": file_name, "type": file_type, "source": source})
    res = await asyncio.to_thread(
        lambda: svc.projects().updateContent(
            scriptId=script_id, body={"files": files}
        ).execute()
    )
    return {
        "success": True,
        "data": {
            "script_id": res.get("scriptId", script_id),
            "updated_file": file_name,
            "created": not found,
            "file_count": len(res.get("files", files)),
        },
    }


@handle_google_errors
async def apps_script_update_content(script_id: str, files: list) -> dict:
    """Advanced: replace the ENTIRE project file set in one call. `files` is a
    list of {name, type, source} and MUST include the manifest
    ({"name": "appsscript", "type": "JSON", "source": "{...}"}) or the call
    fails. Prefer apps_script_update_file for single edits."""
    svc = get_script_service()
    res = await asyncio.to_thread(
        lambda: svc.projects().updateContent(
            scriptId=script_id, body={"files": files}
        ).execute()
    )
    out = res.get("files", files)
    return {
        "success": True,
        "data": {
            "script_id": res.get("scriptId", script_id),
            "file_count": len(out),
            "file_names": [f.get("name") for f in out],
        },
    }


@handle_google_errors
async def apps_script_run(
    script_id: str, function_name: str, parameters: list | None = None, dev_mode: bool = True
) -> dict:
    """Run a function via scripts.run and return its result.

    REQUIRES: the script deployed as an API Executable, the script's GCP project
    == this OAuth client's project, and the token carrying every scope the
    function uses. For container-bound scripts this often is not possible without
    first moving the script to a standard GCP project. On a script-side error,
    returns success=False with the structured error (not an exception).
    """
    svc = get_script_service()
    body = {
        "function": function_name,
        "parameters": parameters or [],
        "devMode": bool(dev_mode),
    }
    res = await asyncio.to_thread(
        lambda: svc.scripts().run(scriptId=script_id, body=body).execute()
    )
    if "error" in res:
        return {
            "success": False,
            "error": res["error"],
            "data": {"script_id": script_id, "function": function_name},
        }
    return {
        "success": True,
        "data": {
            "script_id": script_id,
            "function": function_name,
            "result": res.get("response", {}).get("result"),
        },
    }
