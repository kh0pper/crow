"""
Google Docs API tools — read, write, and structure operations.

All tools return structured dicts via @handle_google_errors.
No full-document replace tool exists (deliberate guardrail).
"""

import asyncio
import logging
import os
import struct
from typing import Optional, cast

from googleapiclient.http import MediaFileUpload

from .auth import get_docs_service, get_drive_service
from .docs_formatting import (
    _parse_inline_formatting,
    _utf16_len,
    docs_structure_to_markdown,
    markdown_to_docs_requests,
    split_markdown_segments,
)
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


def _default_font() -> Optional[str]:
    """
    Font pinned on every inserted run, from GDOCS_DEFAULT_FONT.

    Unset means inherit the document's default, which is how Docs behaves on its
    own. Setting it stops exported docx from picking up the template default
    (Arial) where the deployment expects something else.
    """
    return os.environ.get("GDOCS_DEFAULT_FONT", "").strip() or None


def _find_anchor_index(doc: dict, anchor: str):
    """Return the start index of the first occurrence of `anchor` text within a
    single text run, or None. (Short tokens/placeholders live in one run.)"""
    for element in doc.get("body", {}).get("content", []):
        para = element.get("paragraph")
        if not para:
            continue
        for el in para.get("elements", []):
            tr = el.get("textRun")
            if not tr:
                continue
            content = tr.get("content", "")
            pos = content.find(anchor)
            if pos >= 0:
                return el.get("startIndex", 0) + pos
    return None


def _find_text_ranges(doc: dict, text: str) -> list:
    """[(start, end), ...] absolute doc-index ranges for each occurrence of `text` in the
    body, mapping characters back to doc indices (handles matches that span multiple runs)."""
    flat, idxs = [], []
    for element in doc.get("body", {}).get("content", []):
        para = element.get("paragraph")
        if not para:
            continue
        for el in para.get("elements", []):
            tr = el.get("textRun")
            if not tr:
                continue
            content = tr.get("content", "")
            start = el.get("startIndex", 0)
            for i, ch in enumerate(content):
                flat.append(ch)
                idxs.append(start + i)
    s = "".join(flat)
    ranges = []
    if not text:
        return ranges
    pos = s.find(text)
    while pos >= 0:
        ranges.append((idxs[pos], idxs[pos + len(text) - 1] + 1))
        pos = s.find(text, pos + len(text))
    return ranges


def _png_size_px(path: str):
    """(width, height) in px for a PNG/GIF/JPEG, or None if not determinable."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(26)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return int.from_bytes(head[16:20], "big"), int.from_bytes(
                head[20:24], "big"
            )
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", head[6:10])
    except Exception:
        pass
    return None


def _get_doc_structure(doc_id: str) -> dict:
    """Fetch full document structure (blocking)."""
    docs = get_docs_service()
    return docs.documents().get(documentId=doc_id).execute()


def _parse_headings(doc: dict) -> list[dict]:
    """Extract heading outline from document structure."""
    headings = []
    body_content = doc.get("body", {}).get("content", [])

    for element in body_content:
        paragraph = element.get("paragraph")
        if not paragraph:
            continue

        para_style = paragraph.get("paragraphStyle", {})
        named_style = para_style.get("namedStyleType", "NORMAL_TEXT")

        if not named_style.startswith("HEADING_"):
            continue

        level = int(named_style.split("_")[1])
        text = ""
        for elem in paragraph.get("elements", []):
            tr = elem.get("textRun")
            if tr:
                text += tr.get("content", "").strip()

        if text:
            headings.append(
                {
                    "level": level,
                    "text": text,
                    "start_index": element.get("startIndex", 0),
                    "end_index": element.get("endIndex", 0),
                }
            )

    return headings


def _find_section_range(
    headings: list[dict], body_content: list[dict], heading_text: str
) -> Optional[tuple[int, int, int]]:
    """
    Find the content range for a section identified by heading text.

    Returns (heading_start, section_end, heading_level) or None.
    The section_end is the start of the next heading at same or higher level,
    or the end of the document.
    """
    target = None
    for i, h in enumerate(headings):
        if h["text"].lower().strip() == heading_text.lower().strip():
            target = i
            break

    if target is None:
        return None

    heading = headings[target]
    heading_start = heading["start_index"]
    heading_level = heading["level"]

    # Find end: next heading at same or higher level
    section_end = None
    for h in headings[target + 1 :]:
        if h["level"] <= heading_level:
            section_end = h["start_index"]
            break

    if section_end is None:
        # End of document
        for element in reversed(body_content):
            if "endIndex" in element:
                section_end = element["endIndex"]
                break
        if section_end is None:
            section_end = heading["end_index"]

    return heading_start, section_end, heading_level


@handle_google_errors
async def gdocs_read(doc_id: str) -> dict:
    """Read a Google Doc as markdown via rich structure reading."""
    doc = await asyncio.to_thread(_get_doc_structure, doc_id)

    body = doc.get("body", {})
    lists_info = doc.get("lists", {})
    title = doc.get("title", "")

    markdown = docs_structure_to_markdown(body, title, lists_info)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "title": title,
            "markdown": markdown,
            "modified_time": doc.get("revisionId", ""),
        },
    }


@handle_google_errors
async def gdocs_get_structure(doc_id: str) -> dict:
    """Return the heading outline with index positions."""
    doc = await asyncio.to_thread(_get_doc_structure, doc_id)
    headings = _parse_headings(doc)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "title": doc.get("title", ""),
            "headings": headings,
        },
    }


@handle_google_errors
async def gdocs_read_section(doc_id: str, heading: str) -> dict:
    """Read a single section by heading name (reduces token usage)."""
    doc = await asyncio.to_thread(_get_doc_structure, doc_id)
    headings_list = _parse_headings(doc)
    body_content = doc.get("body", {}).get("content", [])
    lists_info = doc.get("lists", {})

    result = _find_section_range(headings_list, body_content, heading)
    if result is None:
        return {
            "success": False,
            "error": f"Heading '{heading}' not found. Available: {[h['text'] for h in headings_list]}",
        }

    section_start, section_end, _ = result

    # Extract just the elements in this range
    section_body = {
        "content": [
            el
            for el in body_content
            if el.get("startIndex", 0) >= section_start
            and el.get("endIndex", 0) <= section_end
        ]
    }

    markdown = docs_structure_to_markdown(section_body, "", lists_info)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "heading": heading,
            "markdown": markdown,
            "start_index": section_start,
            "end_index": section_end,
        },
    }


@handle_google_errors
async def gdocs_find_replace(
    doc_id: str,
    find: Optional[str] = None,
    replace: Optional[str] = None,
    match_case: bool = True,
    pairs: Optional[list[dict]] = None,
) -> dict:
    """
    Find-replace preserving formatting. Single pair or batch via `pairs` list.

    For single: provide find + replace.
    For batch: provide pairs=[{"find": "...", "replace": "..."}, ...].
    Batch executes as a SINGLE batchUpdate call (atomic).
    """
    docs = get_docs_service()

    replacements = []
    if pairs:
        replacements = pairs
    elif find is not None and replace is not None:
        replacements = [{"find": find, "replace": replace}]
    else:
        return {"success": False, "error": "Provide find+replace or pairs list."}

    requests = []
    for pair in replacements:
        requests.append(
            {
                "replaceAllText": {
                    "containsText": {
                        "text": pair["find"],
                        "matchCase": pair.get("match_case", match_case),
                    },
                    "replaceText": pair["replace"],
                }
            }
        )

    result = await asyncio.to_thread(
        lambda: (
            docs.documents()
            .batchUpdate(documentId=doc_id, body={"requests": requests})
            .execute()
        )
    )

    replies = result.get("replies", [])
    counts = []
    for i, reply in enumerate(replies):
        count = reply.get("replaceAllText", {}).get("occurrencesChanged", 0)
        counts.append(
            {
                "find": replacements[i]["find"],
                "replace": replacements[i]["replace"],
                "occurrences": count,
            }
        )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "replacements": counts,
            "total_changes": sum(c["occurrences"] for c in counts),
        },
    }


@handle_google_errors
async def gdocs_format_text(
    doc_id: str,
    find: str,
    occurrence: int = 0,
    bold: Optional[bool] = None,
    italic: Optional[bool] = None,
    underline: Optional[bool] = None,
    link_url: Optional[str] = None,
    color_hex: Optional[str] = None,
) -> dict:
    """Apply inline character formatting (bold/italic/underline/link/color) to an existing run of
    visible text, located by `find`. Adds/removes no text — style only. `occurrence`: 0-based match
    index, or -1 for ALL matches. Only the styles you pass are changed.

    This is the only Docs tool that sets a HYPERLINK (find-replace/insert/rewrite cannot)."""
    docs = get_docs_service()
    doc = await asyncio.to_thread(
        lambda: docs.documents().get(documentId=doc_id).execute()
    )
    ranges = _find_text_ranges(doc, find)
    if not ranges:
        return {"success": False, "error": f"Text not found: {find!r}"}
    if occurrence == -1:
        targets = ranges
    elif 0 <= occurrence < len(ranges):
        targets = [ranges[occurrence]]
    else:
        return {
            "success": False,
            "error": f"occurrence {occurrence} out of range (found {len(ranges)} match(es))",
        }

    style: dict = {}
    fields: list[str] = []
    if bold is not None:
        style["bold"] = bold
        fields.append("bold")
    if italic is not None:
        style["italic"] = italic
        fields.append("italic")
    if underline is not None:
        style["underline"] = underline
        fields.append("underline")
    if link_url is not None:
        style["link"] = {"url": link_url}
        fields.append("link")
    if color_hex is not None:
        h = color_hex.lstrip("#")
        style["foregroundColor"] = {
            "color": {
                "rgbColor": {
                    "red": int(h[0:2], 16) / 255.0,
                    "green": int(h[2:4], 16) / 255.0,
                    "blue": int(h[4:6], 16) / 255.0,
                }
            }
        }
        fields.append("foregroundColor")
    if not fields:
        return {
            "success": False,
            "error": "No style provided (set at least one of bold/italic/underline/link_url/color_hex).",
        }

    requests = [
        {
            "updateTextStyle": {
                "range": {"startIndex": s, "endIndex": e},
                "textStyle": style,
                "fields": ",".join(fields),
            }
        }
        for (s, e) in targets
    ]

    await asyncio.to_thread(
        lambda: (
            docs.documents()
            .batchUpdate(documentId=doc_id, body={"requests": requests})
            .execute()
        )
    )
    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "find": find,
            "styled": len(targets),
            "fields": fields,
        },
    }


async def _insert_markdown_with_tables(
    docs,
    doc_id: str,
    markdown: str,
    insert_at: int,
    reset_normal_text: bool = False,
) -> int:
    """
    Insert markdown at insert_at, rendering GFM pipe tables as NATIVE Docs
    tables (insertTable + cell fill + bold header row) instead of literal
    pipe text. Non-table segments go through markdown_to_docs_requests.

    Tables need their own API round trips (insertTable creates empty cells
    whose indices are only knowable from a fresh GET), so this runs one
    batchUpdate per segment plus two GETs per table. Returns the end index
    after all inserted content.
    """
    font = _default_font()
    pos = insert_at
    for kind, payload in split_markdown_segments(markdown):
        if kind == "md":
            requests, new_end = markdown_to_docs_requests(
                cast(str, payload),
                start_index=pos,
                reset_normal_text=reset_normal_text,
                font_family=font,
            )
            if requests:
                await asyncio.to_thread(
                    lambda r=requests: (
                        docs.documents()
                        .batchUpdate(documentId=doc_id, body={"requests": r})
                        .execute()
                    )
                )
                pos = new_end
            continue

        rows = cast("list[list[str]]", payload)
        n_rows, n_cols = len(rows), len(rows[0])
        await asyncio.to_thread(
            lambda p=pos: (
                docs.documents()
                .batchUpdate(
                    documentId=doc_id,
                    body={
                        "requests": [
                            {
                                "insertTable": {
                                    "rows": n_rows,
                                    "columns": n_cols,
                                    "location": {"index": p},
                                }
                            }
                        ]
                    },
                )
                .execute()
            )
        )

        def _find_table(doc, at):
            for el in doc.get("body", {}).get("content", []):
                if "table" in el and el["startIndex"] >= at:
                    return el
            return None

        doc = await asyncio.to_thread(
            lambda: docs.documents().get(documentId=doc_id).execute()
        )
        table = _find_table(doc, pos)
        assert table is not None, "inserted table not found on re-read"

        # Fill cells in reverse document order so indices stay valid.
        fills = []
        for r, trow in enumerate(table["table"]["tableRows"]):
            for c, cell in enumerate(trow["tableCells"]):
                text = "".join(s.text for s in _parse_inline_formatting(rows[r][c]))
                if text:
                    fills.append((cell["content"][0]["startIndex"], text))
        if fills:
            fills.sort(key=lambda t: -t[0])
            await asyncio.to_thread(
                lambda f=fills: (
                    docs.documents()
                    .batchUpdate(
                        documentId=doc_id,
                        body={
                            "requests": [
                                {"insertText": {"location": {"index": i}, "text": t}}
                                for i, t in f
                            ]
                        },
                    )
                    .execute()
                )
            )

        # Re-read for final cell positions: bold the header row and apply
        # any inline bold/italic spans inside cells.
        doc = await asyncio.to_thread(
            lambda: docs.documents().get(documentId=doc_id).execute()
        )
        table = _find_table(doc, pos)
        assert table is not None, "inserted table not found on re-read"
        style_reqs = []
        for r, trow in enumerate(table["table"]["tableRows"]):
            for c, cell in enumerate(trow["tableCells"]):
                para = cell["content"][0]
                cell_start = para["startIndex"]
                if font and para["endIndex"] - 1 > cell_start:
                    style_reqs.append(
                        {
                            "updateTextStyle": {
                                "range": {
                                    "startIndex": cell_start,
                                    "endIndex": para["endIndex"] - 1,
                                },
                                "textStyle": {
                                    "weightedFontFamily": {"fontFamily": font}
                                },
                                "fields": "weightedFontFamily",
                            }
                        }
                    )
                if r == 0 and para["endIndex"] - 1 > cell_start:
                    style_reqs.append(
                        {
                            "updateTextStyle": {
                                "range": {
                                    "startIndex": cell_start,
                                    "endIndex": para["endIndex"] - 1,
                                },
                                "textStyle": {"bold": True},
                                "fields": "bold",
                            }
                        }
                    )
                offset = 0
                for span in _parse_inline_formatting(rows[r][c]):
                    span_len = _utf16_len(span.text)
                    if span.bold or span.italic:
                        style, fields = {}, []
                        if span.bold:
                            style["bold"] = True
                            fields.append("bold")
                        if span.italic:
                            style["italic"] = True
                            fields.append("italic")
                        style_reqs.append(
                            {
                                "updateTextStyle": {
                                    "range": {
                                        "startIndex": cell_start + offset,
                                        "endIndex": cell_start + offset + span_len,
                                    },
                                    "textStyle": style,
                                    "fields": ",".join(fields),
                                }
                            }
                        )
                    offset += span_len
        if style_reqs:
            await asyncio.to_thread(
                lambda s=style_reqs: (
                    docs.documents()
                    .batchUpdate(documentId=doc_id, body={"requests": s})
                    .execute()
                )
            )
        pos = table["endIndex"]
    return pos


@handle_google_errors
async def gdocs_append(doc_id: str, markdown: str) -> dict:
    """Append formatted markdown to end of document. GFM pipe tables render as native tables."""
    docs = get_docs_service()

    # Get current end index
    doc = await asyncio.to_thread(
        lambda: docs.documents().get(documentId=doc_id).execute()
    )
    body_content = doc.get("body", {}).get("content", [])
    end_index = 1
    for element in body_content:
        if "endIndex" in element:
            end_index = max(end_index, element["endIndex"])

    insert_at = end_index - 1
    new_end = await _insert_markdown_with_tables(docs, doc_id, markdown, insert_at)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "inserted_at": insert_at,
            "new_end_index": new_end,
        },
    }


@handle_google_errors
async def gdocs_insert_at_heading(doc_id: str, heading: str, markdown: str) -> dict:
    """
    Insert content after a specific heading.

    Guardrail: auto-applies NORMAL_TEXT reset to prevent heading style inheritance.
    """
    docs = get_docs_service()
    doc = await asyncio.to_thread(
        lambda: docs.documents().get(documentId=doc_id).execute()
    )

    headings_list = _parse_headings(doc)
    body_content = doc.get("body", {}).get("content", [])

    # Find the target heading
    target = None
    for h in headings_list:
        if h["text"].lower().strip() == heading.lower().strip():
            target = h
            break

    if target is None:
        return {
            "success": False,
            "error": f"Heading '{heading}' not found. Available: {[h['text'] for h in headings_list]}",
        }

    # Insert after the heading's end index. GFM pipe tables become native
    # tables; the NORMAL_TEXT guardrail is applied per markdown segment.
    insert_at = target["end_index"]
    new_end = await _insert_markdown_with_tables(
        docs, doc_id, markdown, insert_at, reset_normal_text=True
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "heading": heading,
            "inserted_at": insert_at,
            "new_end_index": new_end,
            "heading_inheritance_fix_applied": True,
        },
    }


@handle_google_errors
async def gdocs_replace_section(doc_id: str, heading: str, markdown: str) -> dict:
    """
    Replace content between two headings (safe heading-to-heading delete+reinsert).

    Guardrail: uses delete+reinsert pattern instead of positional inserts.
    Replaces everything between the target heading and the next same-or-higher-level heading.
    The heading itself is preserved.
    """
    docs = get_docs_service()
    doc = await asyncio.to_thread(
        lambda: docs.documents().get(documentId=doc_id).execute()
    )

    headings_list = _parse_headings(doc)
    body_content = doc.get("body", {}).get("content", [])

    result = _find_section_range(headings_list, body_content, heading)
    if result is None:
        return {
            "success": False,
            "error": f"Heading '{heading}' not found. Available: {[h['text'] for h in headings_list]}",
        }

    heading_start, section_end, heading_level = result

    # Find the heading's end index (content starts after it)
    content_start = None
    for h in headings_list:
        if h["start_index"] == heading_start:
            content_start = h["end_index"]
            break

    if content_start is None or content_start >= section_end:
        return {
            "success": False,
            "error": f"Section '{heading}' has no content to replace.",
        }

    # Step 1: Delete existing section content (after heading, before next heading)
    delete_request = {
        "deleteContentRange": {
            "range": {
                "startIndex": content_start,
                "endIndex": section_end - 1,  # Preserve the newline before next heading
            }
        }
    }
    await asyncio.to_thread(
        lambda: (
            docs.documents()
            .batchUpdate(documentId=doc_id, body={"requests": [delete_request]})
            .execute()
        )
    )

    # Step 2: Insert new content at the deletion point. GFM pipe tables become
    # native tables; the NORMAL_TEXT guardrail is applied per markdown segment.
    new_end = await _insert_markdown_with_tables(
        docs, doc_id, markdown, content_start, reset_normal_text=True
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "heading": heading,
            "old_range": {"start": content_start, "end": section_end},
            "new_end_index": new_end,
        },
    }


@handle_google_errors
async def gdocs_create(
    folder_id: str,
    title: str,
    content: str = "",
    find_existing: bool = True,
) -> dict:
    """
    Create a new Google Doc in a folder.

    With find_existing=True (default), searches for an existing doc with the same
    title in the folder first, returning it instead of creating a duplicate.
    """
    drive = get_drive_service()
    docs = get_docs_service()

    if find_existing:
        safe_title = title.replace("\\", "\\\\").replace("'", "\\'")
        query = (
            f"name = '{safe_title}' and '{folder_id}' in parents "
            f"and mimeType = 'application/vnd.google-apps.document' and trashed = false"
        )
        result = await asyncio.to_thread(
            lambda: (
                drive.files()
                .list(
                    q=query,
                    spaces="drive",
                    fields="files(id, name, webViewLink)",
                )
                .execute()
            )
        )
        files = result.get("files", [])
        if files:
            return {
                "success": True,
                "data": {
                    "doc_id": files[0]["id"],
                    "title": files[0]["name"],
                    "web_view_link": files[0].get("webViewLink"),
                    "created": False,
                },
            }

    # Create new document
    doc = await asyncio.to_thread(
        lambda: docs.documents().create(body={"title": title}).execute()
    )
    doc_id = doc["documentId"]

    # Move to target folder
    await asyncio.to_thread(
        lambda: (
            drive.files()
            .update(
                fileId=doc_id,
                addParents=folder_id,
                removeParents="root",
                fields="id, parents",
            )
            .execute()
        )
    )

    # Insert content if provided (GFM pipe tables render as native tables)
    if content.strip():
        await _insert_markdown_with_tables(docs, doc_id, content, 1)

    # Get final metadata
    file_meta = await asyncio.to_thread(
        lambda: (
            drive.files()
            .get(
                fileId=doc_id,
                fields="id, name, webViewLink, modifiedTime",
            )
            .execute()
        )
    )

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "title": file_meta["name"],
            "web_view_link": file_meta.get("webViewLink"),
            "created": True,
        },
    }


@handle_google_errors
async def gdocs_rewrite_passages(doc_id: str, passages: list[dict]) -> dict:
    """
    Rewrite specific paragraphs by anchored prefix match.

    Each item in `passages` has:
      - match_prefix (str): the first 30-100 characters of the paragraph to rewrite.
        Must match the paragraph's text content starting from index 0 (after any
        leading whitespace is trimmed). Case-sensitive. The match is performed at
        paragraph granularity — a paragraph is matched by checking that its
        leading text (after lstrip) startswith match_prefix.
      - new_text (str): the rewritten paragraph text. May contain '\\n' to split
        into multiple paragraphs, in which case the original single paragraph is
        replaced by the corresponding multiple paragraphs.

    Replacement strategy: for each matched paragraph, the tool deletes the entire
    paragraph content via deleteContentRange (preserving the trailing newline that
    marks the paragraph break) and inserts new_text at the deletion point. All
    replacements are processed in REVERSE document order within a single
    batchUpdate so index shifts from earlier deletes do not invalidate later
    operations.

    Returns per-passage status: matched (bool), paragraph_range, original_length,
    new_length. Pairs that did not match leave the doc unchanged.

    Use case: agent has identified specific paragraphs containing rule violations
    (em-dashes, hedging, banned vocab) and wants to swap each one for a properly
    rewritten version. Paragraph-anchored replacement is far more reliable than
    surrounding-context find/replace for prose-scale edits.
    """
    docs = get_docs_service()
    doc = await asyncio.to_thread(
        lambda: docs.documents().get(documentId=doc_id).execute()
    )
    body_content = doc.get("body", {}).get("content", [])

    paragraphs = []
    for elem in body_content:
        para = elem.get("paragraph")
        if not para:
            continue
        text = "".join(
            r.get("textRun", {}).get("content", "") for r in para.get("elements", [])
        )
        paragraphs.append(
            {
                "start": elem.get("startIndex"),
                "end": elem.get("endIndex"),
                "text": text,
            }
        )

    matches = []
    used_paragraph_starts = set()
    for p in passages:
        prefix = (p.get("match_prefix") or "").strip()
        new_text = p.get("new_text") or ""
        if not prefix:
            matches.append(
                {
                    "match_prefix": "",
                    "matched": False,
                    "error": "Empty match_prefix",
                }
            )
            continue
        # Truncate the prefix to avoid hyper-long fingerprints
        anchor = prefix[:100]
        found = None
        for pg in paragraphs:
            if pg["start"] in used_paragraph_starts:
                continue
            stripped = pg["text"].lstrip()
            if stripped.startswith(anchor):
                found = pg
                break
        if found is None:
            matches.append(
                {
                    "match_prefix": anchor[:60],
                    "matched": False,
                    "error": "No paragraph starts with this prefix",
                }
            )
            continue
        used_paragraph_starts.add(found["start"])
        matches.append(
            {
                "match_prefix": anchor[:60],
                "matched": True,
                "paragraph_range": {"start": found["start"], "end": found["end"]},
                "original_length": len(found["text"]),
                "new_length": len(new_text),
                "_paragraph": found,
                "_new_text": new_text,
            }
        )

    # Build batchUpdate requests in REVERSE document order so index shifts
    # from earlier replacements don't break the indices of later ones.
    matched = [m for m in matches if m.get("matched")]
    matched.sort(key=lambda m: m["_paragraph"]["start"], reverse=True)

    requests = []
    for m in matched:
        pg = m["_paragraph"]
        new_text = m["_new_text"]
        start_idx = pg["start"]
        end_idx = pg["end"]
        # The paragraph's text typically ends with '\n' which marks the paragraph
        # break. Preserve that final '\n' by deleting up to end_idx - 1.
        # If the paragraph somehow has no trailing newline (very rare — last para
        # of doc body), just delete the whole range.
        if pg["text"].endswith("\n"):
            delete_end = end_idx - 1
        else:
            delete_end = end_idx
        if delete_end > start_idx:
            requests.append(
                {
                    "deleteContentRange": {
                        "range": {"startIndex": start_idx, "endIndex": delete_end}
                    }
                }
            )
        if new_text:
            requests.append(
                {
                    "insertText": {
                        "location": {"index": start_idx},
                        "text": new_text,
                    }
                }
            )

    if requests:
        await asyncio.to_thread(
            lambda: (
                docs.documents()
                .batchUpdate(documentId=doc_id, body={"requests": requests})
                .execute()
            )
        )

    # Strip internal '_paragraph' / '_new_text' before returning
    clean_results = []
    for m in matches:
        clean_results.append({k: v for k, v in m.items() if not k.startswith("_")})

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "total_passages": len(passages),
            "matched": sum(1 for m in matches if m.get("matched")),
            "applied_requests": len(requests),
            "results": clean_results,
        },
    }


@handle_google_errors
async def gdocs_insert_image(
    doc_id: str,
    image: str,
    anchor_text: Optional[str] = None,
    index: Optional[int] = None,
    max_width_pt: float = 450.0,
    keep_drive_copy: bool = False,
) -> dict:
    """Insert an inline image into a Google Doc.

    `image`: a LOCAL file path (uploaded to Drive automatically) OR an existing
    Drive file id. `anchor_text`: if given, the image replaces the first occurrence
    of that text (e.g. a `{{IMG:…}}` token or a "[Screenshot placeholder: …]"
    line); otherwise the image is inserted at `index` (or at the document start).
    PNG/GIF dimensions are auto-scaled to `max_width_pt` (preserving aspect ratio).

    HOW IT WORKS: the Docs API fetches the image from a URL once at insert time and
    stores its own copy in the document. A local image is therefore uploaded to
    Drive, shared anyone-with-link **briefly**, inserted, then un-shared and (unless
    keep_drive_copy) trashed — the embedded copy in the doc is self-contained. The
    brief public window means: do NOT use this for images containing student PII."""
    docs = get_docs_service()
    drive = get_drive_service()

    # 1. resolve `image` -> a Drive file id (upload if it's a local path)
    temp_id = None
    is_local = os.path.exists(image)
    if is_local:
        media = MediaFileUpload(image, resumable=False)
        up = await asyncio.to_thread(
            lambda: (
                drive.files()
                .create(
                    body={"name": os.path.basename(image)},
                    media_body=media,
                    fields="id",
                )
                .execute()
            )
        )
        file_id = up["id"]
        temp_id = file_id
    else:
        file_id = image  # assume it is already a Drive file id

    perm_id = None
    try:
        # 2. share anyone-with-link reader so the Docs API can fetch it
        perm = await asyncio.to_thread(
            lambda: (
                drive.permissions()
                .create(
                    fileId=file_id,
                    body={"type": "anyone", "role": "reader"},
                    fields="id",
                )
                .execute()
            )
        )
        perm_id = perm["id"]

        # 3. compute object size from the image header (cap to max_width_pt)
        size_req = {}
        if is_local:
            wh = _png_size_px(image)
            if wh and wh[0] and wh[1]:
                w_px, h_px = wh
                width_pt = min(float(max_width_pt), w_px * 72.0 / 96.0)
                size_req = {
                    "objectSize": {
                        "width": {"magnitude": width_pt, "unit": "PT"},
                        "height": {"magnitude": width_pt * h_px / w_px, "unit": "PT"},
                    }
                }

        # 4. resolve the insertion index
        if anchor_text:
            doc = await asyncio.to_thread(
                lambda: docs.documents().get(documentId=doc_id).execute()
            )
            start = _find_anchor_index(doc, anchor_text)
            if start is None:
                return {
                    "success": False,
                    "error": f"anchor_text not found in doc: {anchor_text!r}",
                    "data": {"doc_id": doc_id},
                }
            requests = [
                {
                    "deleteContentRange": {
                        "range": {
                            "startIndex": start,
                            "endIndex": start + len(anchor_text),
                        }
                    }
                },
            ]
        else:
            start = 1 if index is None else int(index)
            requests = []
        img_req = {
            "location": {"index": start},
            "uri": f"https://drive.google.com/uc?export=view&id={file_id}",
        }
        img_req.update(size_req)
        requests.append({"insertInlineImage": img_req})

        # 5. apply (delete-anchor + insert-image are sequential in one batchUpdate)
        await asyncio.to_thread(
            lambda: (
                docs.documents()
                .batchUpdate(documentId=doc_id, body={"requests": requests})
                .execute()
            )
        )
    finally:
        # 6. always revoke the public permission we added
        if perm_id:
            try:
                await asyncio.to_thread(
                    lambda: (
                        drive.permissions()
                        .delete(fileId=file_id, permissionId=perm_id)
                        .execute()
                    )
                )
            except Exception as e:
                logger.warning(
                    "could not revoke public permission on %s: %s", file_id, e
                )

    # 7. trash the temp upload (the doc holds its own copy now)
    trashed = False
    if temp_id and not keep_drive_copy:
        try:
            await asyncio.to_thread(
                lambda: (
                    drive.files()
                    .update(fileId=temp_id, body={"trashed": True})
                    .execute()
                )
            )
            trashed = True
        except Exception as e:
            logger.warning("could not trash temp upload %s: %s", temp_id, e)

    return {
        "success": True,
        "data": {
            "doc_id": doc_id,
            "inserted_at_index": start,
            "replaced_anchor": anchor_text,
            "image_drive_id": file_id,
            "temp_upload_trashed": trashed,
            "kept_drive_copy": bool(keep_drive_copy and temp_id),
        },
    }
