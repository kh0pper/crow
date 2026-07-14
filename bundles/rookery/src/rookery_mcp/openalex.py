"""OpenAlex search for the lit-review workflow (Phase 2 Task 5).

Kevin's scope decision 2026-07-14: OpenAlex only (UNT library access lapsed —
removed from the plan). Results are returned as crow_add_source-READY dicts
(title, authors, publication_date, publisher, doi, url, abstract,
source_type, relevance_score) so the workspace model can pass kept items
straight through the crow bridge without field mapping. (Deviation from the
plan's "CSL-JSON" phrasing, recorded: the only consumer is crow_add_source,
whose schema this matches; CSL-JSON would need a second mapping step.)

Stdlib-only (urllib) — keeps the bundle's dependency surface at mcp>=1.25.0.
This module runs in the HOST uv process (gateway addon), never inside the
locked container; its network egress is the host's.
"""

import json
import urllib.parse
import urllib.request

OPENALEX_WORKS_URL = "https://api.openalex.org/works"
MAX_PER_PAGE = 25
ABSTRACT_CAP = 1500
USER_AGENT = "rookery-bundle/1.0 (research-mcp; +https://github.com/kh0pper/crow)"


def reconstruct_abstract(inverted_index, cap=ABSTRACT_CAP):
    """OpenAlex ships abstracts as {word: [positions]}; rebuild the text."""
    if not inverted_index:
        return None
    positions = []
    for word, idxs in inverted_index.items():
        for i in idxs:
            positions.append((i, word))
    text = " ".join(w for _, w in sorted(positions))
    if len(text) > cap:
        text = text[:cap].rsplit(" ", 1)[0] + " …"
    return text or None


def _authors(work):
    names = [
        a.get("author", {}).get("display_name") for a in work.get("authorships") or []
    ]
    names = [n for n in names if n]
    return ", ".join(names) or None


def map_work(work):
    """One OpenAlex work → crow_add_source-ready dict."""
    loc = work.get("primary_location") or {}
    source = loc.get("source") or {}
    doi = work.get("doi") or ""
    if doi.startswith("https://doi.org/"):
        doi = doi[len("https://doi.org/") :]
    url = loc.get("landing_page_url") or work.get("doi") or work.get("id")
    return {
        "title": work.get("display_name"),
        "source_type": "academic_paper",
        "authors": _authors(work),
        "publication_date": work.get("publication_date"),
        "publisher": source.get("display_name"),
        "doi": doi or None,
        "url": url,
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "relevance_score": work.get("relevance_score"),
        "cited_by_count": work.get("cited_by_count"),
        "openalex_id": work.get("id"),
        "is_open_access": (work.get("open_access") or {}).get("is_oa"),
    }


def _default_fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def search_openalex(
    query,
    per_page=10,
    year_from=None,
    year_to=None,
    open_access=None,
    mailto=None,
    _fetch=_default_fetch,
):
    """Search OpenAlex works by relevance. Returns a list of mapped dicts.

    mailto joins OpenAlex's polite pool (faster, kinder); pass the operator's
    address via ROOKERY_OPENALEX_MAILTO. `_fetch` is injectable for tests.
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("query must be a non-empty string")
    per_page = max(1, min(int(per_page), MAX_PER_PAGE))

    filters = []
    if year_from is not None:
        filters.append(f"from_publication_date:{int(year_from)}-01-01")
    if year_to is not None:
        filters.append(f"to_publication_date:{int(year_to)}-12-31")
    if open_access is not None:
        filters.append(f"is_oa:{'true' if open_access else 'false'}")

    params = {"search": query, "per-page": str(per_page)}
    if filters:
        params["filter"] = ",".join(filters)
    if mailto:
        params["mailto"] = mailto

    url = f"{OPENALEX_WORKS_URL}?{urllib.parse.urlencode(params)}"
    data = _fetch(url)
    return [map_work(w) for w in data.get("results") or []]
