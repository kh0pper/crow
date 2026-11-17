"""
Google Slides API tools — read, notes-safe text ops, and full authoring.

Phase 1 (read + safe scoped write): gslides_read, gslides_get_structure,
gslides_read_notes, gslides_find_replace. find/replace defaults to
scope="slides", which is notes-safe: speaker notes live on a separate
notesPage Page object, so scoping replaceAllText to slide pageObjectIds
provably cannot reach them.

Phase 2 (authoring): gslides_create, gslides_add_slide,
gslides_duplicate_slide, gslides_delete_slide, gslides_reorder_slides,
gslides_add_text_box, gslides_add_image, gslides_format_text,
gslides_format_paragraph, gslides_edit_text (style-preserving),
gslides_edit_notes (deliberate notes edit), gslides_batch_update (raw
passthrough), gslides_export (pdf/pptx via Drive).

All tools return structured dicts via @handle_google_errors.
"""

import asyncio
import logging
import uuid
from typing import Optional

from .auth import get_slides_service, get_drive_service
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- low-level fetch
def _get_presentation(presentation_id: str) -> dict:
    """Fetch the full presentation structure (blocking)."""
    slides = get_slides_service()
    return slides.presentations().get(presentationId=presentation_id).execute()


# ---------------------------------------------------------------- parse helpers
def _shape_text(element: dict) -> str:
    """Concatenate the text of a single pageElement's shape, if any."""
    shape = element.get("shape")
    if not shape:
        return ""
    text = shape.get("text")
    if not text:
        return ""
    parts = []
    for te in text.get("textElements", []):
        run = te.get("textRun")
        if run and run.get("content"):
            parts.append(run["content"])
    return "".join(parts)


def _iter_text_elements(page: dict):
    """Yield (object_id, placeholder_type, text) for shapes with text on a page."""
    for el in page.get("pageElements", []):
        shape = el.get("shape")
        if not shape:
            continue
        txt = _shape_text(el)
        if not txt.strip():
            continue
        ph_type = shape.get("placeholder", {}).get("type", "")
        yield el.get("objectId", ""), ph_type, txt


def _notes_for_slide(slide: dict) -> tuple[str, Optional[str]]:
    """Return (speaker_notes_text, speaker_notes_object_id) for a slide page.

    The notes shape may not be rendered yet on a blank deck; in that case the
    object id is still returned (insertText would auto-create it) but the text
    is empty. Returns ("", None) if there is no notesPage at all.
    """
    notes_page = slide.get("slideProperties", {}).get("notesPage")
    if not notes_page:
        return "", None
    notes_id = notes_page.get("notesProperties", {}).get("speakerNotesObjectId")
    text = ""
    if notes_id:
        for el in notes_page.get("pageElements", []):
            if el.get("objectId") == notes_id:
                text = _shape_text(el)
                break
    return text, notes_id


def _slide_title(slide: dict) -> str:
    """Best-effort title: first TITLE/CENTERED_TITLE placeholder, else first text."""
    first_text = ""
    for obj_id, ph_type, txt in _iter_text_elements(slide):
        if ph_type in ("TITLE", "CENTERED_TITLE"):
            return txt.strip()
        if not first_text:
            first_text = txt.strip()
    return first_text


# ---------------------------------------------------------------- tools
@handle_google_errors
async def gslides_read(presentation_id: str, include_notes: bool = True) -> dict:
    """Read a presentation into a readable per-slide digest (live API)."""
    pres = await asyncio.to_thread(_get_presentation, presentation_id)
    slides_out = []
    for i, slide in enumerate(pres.get("slides", []), 1):
        shapes = [
            {"object_id": oid, "placeholder_type": ph, "text": txt}
            for oid, ph, txt in _iter_text_elements(slide)
        ]
        entry = {
            "index": i,
            "slide_id": slide.get("objectId", ""),
            "shapes": shapes,
        }
        if include_notes:
            notes_text, notes_id = _notes_for_slide(slide)
            entry["speaker_notes"] = notes_text
            entry["speaker_notes_object_id"] = notes_id
        slides_out.append(entry)

    return {
        "success": True,
        "data": {
            "presentation_id": presentation_id,
            "title": pres.get("title", ""),
            "slide_count": len(slides_out),
            "slides": slides_out,
        },
    }


@handle_google_errors
async def gslides_get_structure(presentation_id: str) -> dict:
    """Return a light outline (slide ids, titles, element ids) for navigation."""
    pres = await asyncio.to_thread(_get_presentation, presentation_id)
    outline = []
    for i, slide in enumerate(pres.get("slides", []), 1):
        outline.append({
            "index": i,
            "slide_id": slide.get("objectId", ""),
            "title": _slide_title(slide),
            "element_ids": [el.get("objectId", "") for el in slide.get("pageElements", [])],
        })
    return {
        "success": True,
        "data": {
            "presentation_id": presentation_id,
            "title": pres.get("title", ""),
            "slide_count": len(outline),
            "slides": outline,
        },
    }


@handle_google_errors
async def gslides_read_notes(
    presentation_id: str, slide_id: Optional[str] = None
) -> dict:
    """Return speaker-notes text per slide (read-only). Optionally one slide."""
    pres = await asyncio.to_thread(_get_presentation, presentation_id)
    notes = []
    for i, slide in enumerate(pres.get("slides", []), 1):
        sid = slide.get("objectId", "")
        if slide_id and sid != slide_id:
            continue
        text, notes_id = _notes_for_slide(slide)
        notes.append({
            "index": i,
            "slide_id": sid,
            "speaker_notes": text,
            "speaker_notes_object_id": notes_id,
        })
    return {
        "success": True,
        "data": {"presentation_id": presentation_id, "notes": notes},
    }


@handle_google_errors
async def gslides_find_replace(
    presentation_id: str,
    find: Optional[str] = None,
    replace: Optional[str] = None,
    match_case: bool = True,
    scope: str = "slides",
    slide_ids: Optional[list[str]] = None,
    pairs: Optional[list[dict]] = None,
) -> dict:
    """
    Find-replace text in a presentation, preserving formatting (in-place
    replaceAllText). scope controls reach and is the speaker-notes safety gate:

      scope="slides" (default, notes-safe): only slide pages (or `slide_ids`);
        speaker notes live on a separate notesPage and are never touched.
      scope="notes": only the target slides' notes pages.
      scope="all": everywhere, including notes (explicit opt-in).

    Single mode: find + replace. Batch mode: pairs=[{"find","replace"}, ...]
    as one atomic batchUpdate. replaceAllText is a literal substring match;
    a 0 occurrence count means the find string did not match (likely a line
    break rendered as vertical tab, smart quotes, or a Unicode minus), not a
    successful no-op.
    """
    if scope not in ("slides", "notes", "all"):
        return {"success": False, "error": "scope must be 'slides', 'notes', or 'all'."}

    if pairs:
        replacements = pairs
    elif find is not None and replace is not None:
        replacements = [{"find": find, "replace": replace}]
    else:
        return {"success": False, "error": "Provide find+replace or a pairs list."}

    # Resolve page object ids for scoping (None => whole presentation).
    page_object_ids = None
    if scope != "all":
        pres = await asyncio.to_thread(_get_presentation, presentation_id)
        page_object_ids = []
        for slide in pres.get("slides", []):
            sid = slide.get("objectId", "")
            if slide_ids and sid not in slide_ids:
                continue
            if scope == "slides":
                page_object_ids.append(sid)
            elif scope == "notes":
                notes_page = slide.get("slideProperties", {}).get("notesPage", {})
                npid = notes_page.get("objectId")
                if npid:
                    page_object_ids.append(npid)
        if not page_object_ids:
            return {"success": False, "error": "No matching pages for the given scope/slide_ids."}

    requests = []
    for pair in replacements:
        contains = {
            "text": pair["find"],
            "matchCase": pair.get("match_case", match_case),
        }
        req = {"replaceAllText": {"containsText": contains, "replaceText": pair["replace"]}}
        if page_object_ids is not None:
            req["replaceAllText"]["pageObjectIds"] = page_object_ids
        requests.append(req)

    def _run():
        return get_slides_service().presentations().batchUpdate(
            presentationId=presentation_id, body={"requests": requests}
        ).execute()

    result = await asyncio.to_thread(_run)

    replies = result.get("replies", [])
    counts = []
    for i, reply in enumerate(replies):
        n = reply.get("replaceAllText", {}).get("occurrencesChanged", 0)
        counts.append({
            "find": replacements[i]["find"],
            "replace": replacements[i]["replace"],
            "occurrences": n,
        })

    return {
        "success": True,
        "data": {
            "presentation_id": presentation_id,
            "scope": scope,
            "pages_scoped": len(page_object_ids) if page_object_ids is not None else "all",
            "replacements": counts,
            "total_changes": sum(c["occurrences"] for c in counts),
        },
    }


# ================================================================ Phase 2: authoring
EMU_PER_INCH = 914400


def _emu(inches: float) -> int:
    return int(round(inches * EMU_PER_INCH))


def _hex_to_rgb(hex_color: str) -> dict:
    """'#1F3A5F' or '1F3A5F' -> {red,green,blue} floats in 0..1."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"Expected a 6-digit hex color, got {hex_color!r}")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return {"red": r, "green": g, "blue": b}


def _find_shape(pres: dict, object_id: str) -> Optional[dict]:
    """Find a pageElement by objectId across slides and notes pages."""
    pages = list(pres.get("slides", []))
    for slide in pres.get("slides", []):
        np = slide.get("slideProperties", {}).get("notesPage")
        if np:
            pages.append(np)
    masters_layouts = pres.get("masters", []) + pres.get("layouts", [])
    for page in pages + masters_layouts:
        for el in page.get("pageElements", []):
            if el.get("objectId") == object_id:
                return el
    return None


def _first_run_style(element: dict) -> dict:
    shape = element.get("shape", {})
    for te in shape.get("text", {}).get("textElements", []):
        run = te.get("textRun")
        if run and run.get("content", "").strip():
            return run.get("style", {}) or {}
    return {}


async def _batch(presentation_id: str, requests: list) -> dict:
    def _run():
        return get_slides_service().presentations().batchUpdate(
            presentationId=presentation_id, body={"requests": requests}
        ).execute()
    return await asyncio.to_thread(_run)


@handle_google_errors
async def gslides_batch_update(presentation_id: str, requests: list) -> dict:
    """Raw Slides API batchUpdate passthrough (power tool). `requests` is a list of request dicts."""
    if not requests:
        return {"success": False, "error": "requests must be a non-empty list."}
    result = await _batch(presentation_id, requests)
    return {"success": True, "data": {"presentation_id": presentation_id, "replies": result.get("replies", [])}}


@handle_google_errors
async def gslides_create(title: str, folder_id: Optional[str] = None) -> dict:
    """Create a new presentation; optionally move it into a Drive folder."""
    def _create():
        return get_slides_service().presentations().create(body={"title": title}).execute()
    pres = await asyncio.to_thread(_create)
    pid = pres["presentationId"]
    if folder_id:
        def _move():
            drive = get_drive_service()
            cur = drive.files().get(fileId=pid, fields="parents").execute()
            prev = ",".join(cur.get("parents", []))
            drive.files().update(
                fileId=pid, addParents=folder_id, removeParents=prev, fields="id,parents"
            ).execute()
        await asyncio.to_thread(_move)
    return {
        "success": True,
        "data": {
            "presentation_id": pid,
            "title": title,
            "web_view_link": f"https://docs.google.com/presentation/d/{pid}/edit",
            "folder_id": folder_id,
        },
    }


@handle_google_errors
async def gslides_add_slide(
    presentation_id: str, layout: str = "BLANK", index: Optional[int] = None
) -> dict:
    """Add a slide using a predefined layout (BLANK, TITLE, TITLE_AND_BODY, SECTION_HEADER, ...)."""
    new_id = "slide_" + uuid.uuid4().hex[:12]
    req = {
        "createSlide": {
            "objectId": new_id,
            "slideLayoutReference": {"predefinedLayout": layout},
        }
    }
    if index is not None:
        req["createSlide"]["insertionIndex"] = index
    await _batch(presentation_id, [req])
    return {"success": True, "data": {"presentation_id": presentation_id, "slide_id": new_id, "layout": layout}}


@handle_google_errors
async def gslides_duplicate_slide(presentation_id: str, slide_id: str) -> dict:
    """Duplicate a slide (and its contents); returns the new slide id."""
    result = await _batch(presentation_id, [{"duplicateObject": {"objectId": slide_id}}])
    new_id = result.get("replies", [{}])[0].get("duplicateObject", {}).get("objectId", "")
    return {"success": True, "data": {"presentation_id": presentation_id, "new_slide_id": new_id}}


@handle_google_errors
async def gslides_delete_slide(presentation_id: str, slide_id: str) -> dict:
    """Delete a slide (or any object) by id."""
    await _batch(presentation_id, [{"deleteObject": {"objectId": slide_id}}])
    return {"success": True, "data": {"presentation_id": presentation_id, "deleted": slide_id}}


@handle_google_errors
async def gslides_reorder_slides(
    presentation_id: str, slide_ids: list, insertion_index: int
) -> dict:
    """Move the given slide ids to a new position (updateSlidesPosition)."""
    req = {"updateSlidesPosition": {"slideObjectIds": slide_ids, "insertionIndex": insertion_index}}
    await _batch(presentation_id, [req])
    return {"success": True, "data": {"presentation_id": presentation_id, "moved": slide_ids, "to": insertion_index}}


@handle_google_errors
async def gslides_add_text_box(
    presentation_id: str,
    slide_id: str,
    text: str,
    x: float = 1.0,
    y: float = 1.0,
    width: float = 8.0,
    height: float = 1.0,
    font_size: Optional[float] = None,
) -> dict:
    """Add a text box (inches) to a slide and fill it with text."""
    box_id = "tb_" + uuid.uuid4().hex[:12]
    requests = [
        {
            "createShape": {
                "objectId": box_id,
                "shapeType": "TEXT_BOX",
                "elementProperties": {
                    "pageObjectId": slide_id,
                    "size": {
                        "width": {"magnitude": _emu(width), "unit": "EMU"},
                        "height": {"magnitude": _emu(height), "unit": "EMU"},
                    },
                    "transform": {
                        "scaleX": 1, "scaleY": 1,
                        "translateX": _emu(x), "translateY": _emu(y), "unit": "EMU",
                    },
                },
            }
        },
        {"insertText": {"objectId": box_id, "insertionIndex": 0, "text": text}},
    ]
    if font_size is not None:
        requests.append({
            "updateTextStyle": {
                "objectId": box_id,
                "textRange": {"type": "ALL"},
                "style": {"fontSize": {"magnitude": font_size, "unit": "PT"}},
                "fields": "fontSize",
            }
        })
    await _batch(presentation_id, requests)
    return {"success": True, "data": {"presentation_id": presentation_id, "slide_id": slide_id, "object_id": box_id}}


@handle_google_errors
async def gslides_add_image(
    presentation_id: str,
    slide_id: str,
    image_url: str,
    x: float = 1.0,
    y: float = 1.0,
    width: float = 4.0,
    height: float = 3.0,
) -> dict:
    """Add an image (by public URL) to a slide at the given inch geometry."""
    img_id = "img_" + uuid.uuid4().hex[:12]
    req = {
        "createImage": {
            "objectId": img_id,
            "url": image_url,
            "elementProperties": {
                "pageObjectId": slide_id,
                "size": {
                    "width": {"magnitude": _emu(width), "unit": "EMU"},
                    "height": {"magnitude": _emu(height), "unit": "EMU"},
                },
                "transform": {
                    "scaleX": 1, "scaleY": 1,
                    "translateX": _emu(x), "translateY": _emu(y), "unit": "EMU",
                },
            },
        }
    }
    await _batch(presentation_id, [req])
    return {"success": True, "data": {"presentation_id": presentation_id, "slide_id": slide_id, "object_id": img_id}}


@handle_google_errors
async def gslides_format_text(
    presentation_id: str,
    object_id: str,
    bold: Optional[bool] = None,
    italic: Optional[bool] = None,
    underline: Optional[bool] = None,
    font_size: Optional[float] = None,
    color_hex: Optional[str] = None,
    font_family: Optional[str] = None,
) -> dict:
    """Apply text styling to all text in a shape (updateTextStyle)."""
    style, fields = {}, []
    if bold is not None:
        style["bold"] = bold; fields.append("bold")
    if italic is not None:
        style["italic"] = italic; fields.append("italic")
    if underline is not None:
        style["underline"] = underline; fields.append("underline")
    if font_size is not None:
        style["fontSize"] = {"magnitude": font_size, "unit": "PT"}; fields.append("fontSize")
    if color_hex is not None:
        style["foregroundColor"] = {"opaqueColor": {"rgbColor": _hex_to_rgb(color_hex)}}
        fields.append("foregroundColor")
    if font_family is not None:
        style["fontFamily"] = font_family; fields.append("fontFamily")
    if not fields:
        return {"success": False, "error": "Provide at least one style attribute."}
    req = {"updateTextStyle": {"objectId": object_id, "textRange": {"type": "ALL"},
                               "style": style, "fields": ",".join(fields)}}
    await _batch(presentation_id, [req])
    return {"success": True, "data": {"presentation_id": presentation_id, "object_id": object_id, "applied": fields}}


@handle_google_errors
async def gslides_format_paragraph(
    presentation_id: str, object_id: str, alignment: Optional[str] = None
) -> dict:
    """Set paragraph alignment for all text in a shape (START, CENTER, END, JUSTIFIED)."""
    if not alignment:
        return {"success": False, "error": "Provide alignment (START, CENTER, END, JUSTIFIED)."}
    req = {"updateParagraphStyle": {"objectId": object_id, "textRange": {"type": "ALL"},
                                    "style": {"alignment": alignment}, "fields": "alignment"}}
    await _batch(presentation_id, [req])
    return {"success": True, "data": {"presentation_id": presentation_id, "object_id": object_id, "alignment": alignment}}


@handle_google_errors
async def gslides_edit_text(presentation_id: str, object_id: str, new_text: str) -> dict:
    """Replace all text in one shape, re-applying the first run's style (so bold/size/color survive)."""
    pres = await asyncio.to_thread(_get_presentation, presentation_id)
    el = _find_shape(pres, object_id)
    if el is None:
        return {"success": False, "error": f"No shape with object_id {object_id!r}."}
    current = _shape_text(el)
    style = _first_run_style(el)
    requests = []
    if current.strip():
        requests.append({"deleteText": {"objectId": object_id, "textRange": {"type": "ALL"}}})
    requests.append({"insertText": {"objectId": object_id, "insertionIndex": 0, "text": new_text}})
    if style:
        requests.append({"updateTextStyle": {"objectId": object_id, "textRange": {"type": "ALL"},
                                             "style": style, "fields": ",".join(style.keys())}})
    await _batch(presentation_id, requests)
    return {"success": True, "data": {"presentation_id": presentation_id, "object_id": object_id, "style_preserved": bool(style)}}


@handle_google_errors
async def gslides_edit_notes(
    presentation_id: str, slide_id: str, text: str, mode: str = "replace"
) -> dict:
    """Replace or append a slide's speaker notes (deliberate notes edit)."""
    if mode not in ("replace", "append"):
        return {"success": False, "error": "mode must be 'replace' or 'append'."}
    pres = await asyncio.to_thread(_get_presentation, presentation_id)
    slide = next((s for s in pres.get("slides", []) if s.get("objectId") == slide_id), None)
    if slide is None:
        return {"success": False, "error": f"No slide with id {slide_id!r}."}
    current, notes_id = _notes_for_slide(slide)
    if not notes_id:
        return {"success": False, "error": "Slide has no speaker-notes placeholder (no notesProperties)."}
    requests = []
    if mode == "replace":
        if current.strip():
            requests.append({"deleteText": {"objectId": notes_id, "textRange": {"type": "ALL"}}})
        requests.append({"insertText": {"objectId": notes_id, "insertionIndex": 0, "text": text}})
    else:  # append (insertText auto-creates the shape if needed)
        idx = max(len(current) - 1, 0) if current.endswith("\n") else len(current)
        requests.append({"insertText": {"objectId": notes_id, "insertionIndex": idx, "text": text}})
    await _batch(presentation_id, requests)
    return {"success": True, "data": {"presentation_id": presentation_id, "slide_id": slide_id, "mode": mode}}


@handle_google_errors
async def gslides_export(
    presentation_id: str, fmt: str = "pdf", out_path: Optional[str] = None
) -> dict:
    """Export the deck via Drive to a local file. fmt: 'pdf' or 'pptx'. Returns the path."""
    mimes = {
        "pdf": "application/pdf",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
    if fmt not in mimes:
        return {"success": False, "error": "fmt must be 'pdf' or 'pptx'."}
    path = out_path or f"/tmp/{presentation_id}.{fmt}"

    def _export():
        data = get_drive_service().files().export(
            fileId=presentation_id, mimeType=mimes[fmt]
        ).execute()
        with open(path, "wb") as fh:
            fh.write(data)
        return len(data)

    size = await asyncio.to_thread(_export)
    return {"success": True, "data": {"presentation_id": presentation_id, "path": path, "bytes": size, "format": fmt}}
