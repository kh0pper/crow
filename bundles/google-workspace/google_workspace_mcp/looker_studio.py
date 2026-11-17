"""
Looker Studio API (datastudio.googleapis.com) tools — GOVERNANCE / READ-ONLY.

Purpose: an automated *sharing audit* of a finished Looker Studio dashboard —
confirm who can see the report/data source after the build (the same role the
gdrive_get_permissions tool plays for Sheets/folders). Looker Studio has NO
report-authoring API, so building the dashboard + its row-level security stays a
manual UI activity; these tools only read the resulting governance state.

Surface:
  - looker_search_assets    search reports / data sources by owner/title and
                            return id, title, type, owner, timestamps.
  - looker_get_permissions  read an asset's sharing model (OWNER / EDITOR /
                            VIEWER / LINK_VIEWER members) — proves "domain-link
                            viewer, no public" without a screenshot.

Why direct REST (not googleapiclient discovery): the Looker Studio API is NOT in
the static discovery registry, and its live discovery doc
(`$discovery/rest?version=v1`) rejects OAuth-only callers ("use API Key or other
form of API consumer identity") — so `build("datastudio", "v1")` cannot be used
without an API key. The API's own v1 REST endpoints DO accept the OAuth bearer
token, so these tools call them directly via an AuthorizedSession.

Requirements (see auth.SCOPES / get_looker_studio_session):
  - the `datastudio.readonly` scope granted (re-auth after adding the scope);
  - the Looker Studio API enabled in the OAuth client's GCP project.
"""

import asyncio
import logging

from .auth import get_looker_studio_session
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)

_BASE = "https://datastudio.googleapis.com/v1"
# The search method requires EXACTLY ONE asset type per call (the API 400s on
# zero or multiple), so a multi-type request fans out to one call per type.
_ASSET_TYPES = ("REPORT", "DATA_SOURCE")


def _asset_view(a: dict) -> dict:
    """Project a raw search asset to the fields a governance audit cares about."""
    return {
        "asset_id": a.get("name") or a.get("assetId"),
        "title": a.get("title"),
        "type": a.get("assetType"),
        "owner": a.get("owner"),
        "creator": a.get("creator"),
        "trashed": a.get("trashed"),
        "create_time": a.get("createTime"),
        "update_time": a.get("updateTime"),
        "last_access_time": a.get("lastAccessTime"),
    }


@handle_google_errors
async def looker_search_assets(
    asset_types: list | None = None,
    owner: str | None = None,
    title: str | None = None,
    include_trashed: bool = False,
    page_size: int = 50,
    page_token: str | None = None,
) -> dict:
    """Search Looker Studio assets for a sharing/governance audit.

    `asset_types`: subset of REPORT, DATA_SOURCE (default both). `owner`: filter
    to assets owned by an email. `title`: substring match. Returns each asset's
    id, title, type, owner, creator, and timestamps.

    The API allows only ONE asset type per request, so requesting both fans out
    to two calls and merges the results (pagination is per-type; pass a single
    asset_type with page_token to page within one type).

    Read-only. Use after the dashboard is built to record who owns/can see it."""
    session = get_looker_studio_session()
    types = [t.upper() for t in (asset_types or _ASSET_TYPES) if t]
    bad = [t for t in types if t not in _ASSET_TYPES]
    if bad:
        return {
            "success": False,
            "error": f"unsupported asset_types {bad}; use REPORT and/or DATA_SOURCE.",
            "data": {},
        }

    def _search_one(asset_type: str) -> dict:
        params: dict = {"assetTypes": asset_type, "pageSize": int(page_size)}
        if owner:
            params["owner"] = owner
        if title:
            params["title"] = title
        if include_trashed:
            params["includeTrashed"] = "true"
        # page_token only meaningful for a single-type request
        if page_token and len(types) == 1:
            params["pageToken"] = page_token
        r = session.get(f"{_BASE}/assets:search", params=params)
        r.raise_for_status()
        return r.json()

    assets: list = []
    next_token = None
    for t in types:
        res = await asyncio.to_thread(_search_one, t)
        assets.extend(_asset_view(a) for a in res.get("assets", []))
        if len(types) == 1:
            next_token = res.get("nextPageToken")

    return {
        "success": True,
        "data": {
            "asset_count": len(assets),
            "assets": assets,
            "next_page_token": next_token,
        },
    }


@handle_google_errors
async def looker_get_permissions(asset_id: str) -> dict:
    """Read a Looker Studio asset's sharing model — the sharing audit.

    `asset_id` is the report/data-source id (the bare uuid, e.g. from a report
    URL `.../reporting/<id>/...` or from looker_search_assets `asset_id`).

    Returns the permission roles and their members, e.g.
        OWNER:       ["user:owner@domain.org"]
        LINK_VIEWER: ["domain:domain.org"]   ← "Anyone at <domain> with link, Viewer"
    A `LINK_VIEWER` of `allUsers` would indicate PUBLIC (internet) access; its
    absence + a `domain:` member is the re-checkable proof of domain-restricted
    sharing with no public access. Read-only."""
    session = get_looker_studio_session()
    aid = (asset_id or "").strip()
    if not aid:
        return {"success": False, "error": "asset_id is required.", "data": {}}

    def _fetch() -> dict:
        r = session.get(f"{_BASE}/assets/{aid}/permissions")
        r.raise_for_status()
        return r.json()

    res = await asyncio.to_thread(_fetch)
    perms = res.get("permissions", {})
    members_by_role = {role: body.get("members", []) for role, body in perms.items()}
    all_members = [m for ms in members_by_role.values() for m in ms]
    is_public = any(m == "allUsers" or m.startswith("allAuthenticatedUsers") for m in all_members)
    domain_link = [
        m.split(":", 1)[1]
        for m in members_by_role.get("LINK_VIEWER", [])
        if m.startswith("domain:")
    ]
    return {
        "success": True,
        "data": {
            "asset_id": aid,
            "roles": members_by_role,
            "is_public": is_public,
            "domain_link_viewers": domain_link,
            "etag": res.get("etag"),
        },
    }
