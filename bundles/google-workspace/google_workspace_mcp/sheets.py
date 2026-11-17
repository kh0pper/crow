"""
Google Sheets API v4 tools — read/write/append/list cell values in a spreadsheet.
"""

import asyncio
import logging
import re

from .auth import get_drive_service, get_sheets_service
from .guardrails import handle_google_errors

logger = logging.getLogger(__name__)


def _scalarize(v):
    """Coerce a cell to a Sheets-API-safe scalar. The API rejects struct/array
    cells with a 400 (`Invalid values[..]: struct_value`); a stray dict/list is
    JSON-stringified rather than sent raw, so a malformed cell never hard-fails
    (and never triggers a model retry loop). None -> "".
    """
    if v is None:
        return ""
    if isinstance(v, (str, int, float, bool)):
        return v
    import json as _json
    return _json.dumps(v, ensure_ascii=False)


async def _read_header(svc, spreadsheet_id: str, sheet_name: str) -> list:
    res = await asyncio.to_thread(
        lambda: svc.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id, range=f"{sheet_name}!1:1"
        ).execute()
    )
    vals = res.get("values", [])
    return vals[0] if vals else []


async def _coerce_rows(svc, spreadsheet_id: str, sheet_name: str, values) -> list:
    """Normalize append `values` into a 2D array of scalars.

    Accepts what an LLM naturally produces: a single dict keyed by column name,
    a list of such dicts, a single flat row (list of scalars), or a list of
    rows. Dict rows are mapped onto the sheet's header order (missing columns
    -> ""), so the caller can pass {"item": "...", "quantity": 2, ...} directly.
    """
    if isinstance(values, dict):
        values = [values]
    if not isinstance(values, list) or not values:
        return []
    if any(isinstance(r, dict) for r in values):
        header = await _read_header(svc, spreadsheet_id, sheet_name)
        rows = []
        for r in values:
            if isinstance(r, dict):
                rows.append([_scalarize(r.get(col, "")) for col in header])
            elif isinstance(r, list):
                rows.append([_scalarize(c) for c in r])
            else:
                rows.append([_scalarize(r)])
        return rows
    if isinstance(values[0], list):
        return [[_scalarize(c) for c in r] for r in values]
    return [[_scalarize(c) for c in values]]


@handle_google_errors
async def sheets_list(spreadsheet_id: str) -> dict:
    """List the sheet/tab names in a spreadsheet."""
    svc = get_sheets_service()
    result = await asyncio.to_thread(
        lambda: svc.spreadsheets().get(
            spreadsheetId=spreadsheet_id,
            fields="properties.title,sheets.properties(title,sheetId,index,gridProperties)",
        ).execute()
    )
    sheets = result.get("sheets", [])
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "title": result.get("properties", {}).get("title", ""),
            "count": len(sheets),
            "sheets": [
                {
                    "title": s["properties"].get("title", ""),
                    "sheet_id": s["properties"].get("sheetId"),
                    "index": s["properties"].get("index"),
                    "rows": s["properties"].get("gridProperties", {}).get("rowCount"),
                    "columns": s["properties"].get("gridProperties", {}).get("columnCount"),
                }
                for s in sheets
            ],
        },
    }


@handle_google_errors
async def sheets_create(
    title: str,
    folder_id: str | None = None,
    tabs: list | None = None,
    find_existing: bool = True,
) -> dict:
    """Create a new Google Spreadsheet, optionally inside a Drive folder.

    With find_existing=True (default) and a folder_id, an existing spreadsheet with
    the same title in that folder is returned instead of creating a duplicate.
    `tabs` (optional) names the initial tabs: the first replaces the default
    "Sheet1", the rest are appended in order.
    """
    drive = get_drive_service()
    svc = get_sheets_service()

    if find_existing and folder_id:
        safe_title = title.replace("\\", "\\\\").replace("'", "\\'")
        query = (
            f"name = '{safe_title}' and '{folder_id}' in parents "
            f"and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
        )
        result = await asyncio.to_thread(
            lambda: drive.files()
            .list(q=query, spaces="drive", fields="files(id, name, webViewLink)")
            .execute()
        )
        files = result.get("files", [])
        if files:
            return {
                "success": True,
                "data": {
                    "spreadsheet_id": files[0]["id"],
                    "title": files[0]["name"],
                    "web_view_link": files[0].get("webViewLink"),
                    "created": False,
                },
            }

    body: dict = {"name": title, "mimeType": "application/vnd.google-apps.spreadsheet"}
    if folder_id:
        body["parents"] = [folder_id]
    created = await asyncio.to_thread(
        lambda: drive.files()
        .create(body=body, fields="id, name, webViewLink, parents")
        .execute()
    )
    spreadsheet_id = created["id"]

    tab_titles = [t for t in (tabs or []) if t]
    if tab_titles:
        requests = []
        default_id = (await _sheet_props(svc, spreadsheet_id))[0]["sheetId"]
        requests.append(
            {
                "updateSheetProperties": {
                    "properties": {"sheetId": default_id, "title": tab_titles[0]},
                    "fields": "title",
                }
            }
        )
        for i, tab_title in enumerate(tab_titles[1:], start=1):
            requests.append({"addSheet": {"properties": {"title": tab_title, "index": i}}})
        await _batch_update(svc, spreadsheet_id, requests)

    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "title": created.get("name", title),
            "web_view_link": created.get("webViewLink"),
            "parents": created.get("parents", []),
            "tabs": tab_titles or ["Sheet1"],
            "created": True,
        },
    }


_VALUE_RENDER_OPTIONS = {"FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"}


@handle_google_errors
async def sheets_read(
    spreadsheet_id: str, range: str, value_render_option: str = "FORMATTED_VALUE"
) -> dict:
    """Read cell values from an A1 range (e.g. 'Sheet1' or 'Sheet1!A1:E50').

    Returns rows as a list of lists; trailing empty cells/rows are omitted by
    the API, so rows may be ragged.

    `value_render_option` controls what each cell returns:
      - FORMATTED_VALUE (default) — the displayed value, as a string
      - UNFORMATTED_VALUE — the underlying value without display formatting
      - FORMULA — the cell's formula (e.g. '=IF(K2<>"",K2,J2)') instead of its
        computed result; use this to inspect/trace formulas without round-tripping
    """
    render = (value_render_option or "FORMATTED_VALUE").upper()
    if render not in _VALUE_RENDER_OPTIONS:
        return {
            "success": False,
            "error": (
                f"Invalid value_render_option {value_render_option!r}; "
                f"expected one of {sorted(_VALUE_RENDER_OPTIONS)}."
            ),
        }
    svc = get_sheets_service()
    result = await asyncio.to_thread(
        lambda: svc.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=range,
            valueRenderOption=render,
        ).execute()
    )
    values = result.get("values", [])
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "range": result.get("range", range),
            "value_render_option": render,
            "row_count": len(values),
            "values": values,
        },
    }


@handle_google_errors
async def sheets_write(
    spreadsheet_id: str, range: str, values: list, value_input_option: str = "USER_ENTERED"
) -> dict:
    """Write a 2D array of values into an A1 range (overwrites existing cells).

    `values` is a list of rows, each row a list of cell values, e.g.
    [["Item A", "2", "ea", "note"]]. `value_input_option` is
    USER_ENTERED (default; parses numbers/dates like the UI) or RAW.
    """
    svc = get_sheets_service()
    # Accept a single flat row and wrap it; scalarize every cell so a stray
    # dict/array never hits the API as a struct (400).
    if isinstance(values, list) and values and not isinstance(values[0], list):
        values = [values]
    safe = [[_scalarize(c) for c in r] for r in values] if isinstance(values, list) else values
    result = await asyncio.to_thread(
        lambda: svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=range,
            valueInputOption=value_input_option,
            body={"values": safe},
        ).execute()
    )
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "updated_range": result.get("updatedRange", range),
            "updated_rows": result.get("updatedRows", 0),
            "updated_columns": result.get("updatedColumns", 0),
            "updated_cells": result.get("updatedCells", 0),
        },
    }


@handle_google_errors
async def sheets_append(
    spreadsheet_id: str, sheet_name: str, values: list, value_input_option: str = "USER_ENTERED"
) -> dict:
    """Append one or more rows to the end of a sheet/tab.

    `sheet_name` is the tab name (e.g. 'Sheet1'); the API finds the table and
    appends after the last row. `values` is flexible — pass whichever is easiest:
      - a dict keyed by column name: {"item": "Item A", "quantity": 2, ...}
        (mapped onto the sheet's header order; unknown keys ignored, missing -> "")
      - a list of such dicts (multiple rows)
      - a flat list of cell values in column order: ["id-1", "Item A", ...]
      - a list of rows (list of lists)
    """
    svc = get_sheets_service()
    rows = await _coerce_rows(svc, spreadsheet_id, sheet_name, values)
    if not rows:
        return {"success": False, "error": "No rows to append (values was empty)."}
    result = await asyncio.to_thread(
        lambda: svc.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=sheet_name,
            valueInputOption=value_input_option,
            insertDataOption="INSERT_ROWS",
            body={"values": rows},
        ).execute()
    )
    updates = result.get("updates", {})
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "sheet_name": sheet_name,
            "updated_range": updates.get("updatedRange", ""),
            "updated_rows": updates.get("updatedRows", 0),
            "updated_cells": updates.get("updatedCells", 0),
        },
    }


# --- Tab management (batchUpdate) + number formatting ---------------------
#
# Structural operations the Sheets values API can't do: create/rename/delete
# whole tabs and set a range's number format (e.g. force TEXT '@' so IDs,
# leading-zero codes, and dates are stored verbatim instead of being coerced
# to numbers/dates).

_A1_CELL = re.compile(r"^\s*([A-Za-z]+)?(\d+)?\s*$")


def _col_to_index(letters: str) -> int:
    """A1 column letters -> 0-based index ('A'->0, 'Z'->25, 'AA'->26)."""
    idx = 0
    for ch in letters.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def _split_cell(cell: str):
    """'A1' -> ('A', 1); 'A' -> ('A', None); '2' -> (None, 2)."""
    m = _A1_CELL.match(cell)
    if not m or (m.group(1) is None and m.group(2) is None):
        raise ValueError(f"Bad A1 cell reference: {cell!r}")
    col, row = m.group(1), m.group(2)
    return (col or None, int(row) if row else None)


async def _sheet_props(svc, spreadsheet_id: str) -> list:
    res = await asyncio.to_thread(
        lambda: svc.spreadsheets().get(
            spreadsheetId=spreadsheet_id,
            fields="sheets.properties(title,sheetId)",
        ).execute()
    )
    return [s["properties"] for s in res.get("sheets", [])]


async def _resolve_sheet_id(svc, spreadsheet_id: str, title: str) -> int:
    for p in await _sheet_props(svc, spreadsheet_id):
        if p.get("title") == title:
            return p.get("sheetId")
    raise ValueError(f"No tab named {title!r} in this spreadsheet.")


async def _a1_to_gridrange(svc, spreadsheet_id: str, a1: str) -> dict:
    """Convert an A1 range with a tab name ('Tab!A1:C10', 'Tab!A:A', 'Tab!2:5')
    into a GridRange for batchUpdate. The tab name is required so the range is
    unambiguous about which sheet it targets."""
    if "!" not in a1:
        raise ValueError(
            f"Range {a1!r} must include a tab name, e.g. 'Tab!A1:C10'."
        )
    sheet_part, rng = a1.rsplit("!", 1)
    sheet_title = sheet_part.strip().strip("'").replace("''", "'")
    gr = {"sheetId": await _resolve_sheet_id(svc, spreadsheet_id, sheet_title)}
    rng = rng.strip()
    if not rng:
        return gr
    start, end = rng.split(":", 1) if ":" in rng else (rng, rng)
    sc, sr = _split_cell(start)
    ec, er = _split_cell(end)
    if sc is not None:
        gr["startColumnIndex"] = _col_to_index(sc)
    if ec is not None:
        gr["endColumnIndex"] = _col_to_index(ec) + 1
    if sr is not None:
        gr["startRowIndex"] = sr - 1
    if er is not None:
        gr["endRowIndex"] = er
    return gr


async def _batch_update(svc, spreadsheet_id: str, requests: list) -> dict:
    return await asyncio.to_thread(
        lambda: svc.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id, body={"requests": requests}
        ).execute()
    )


@handle_google_errors
async def sheets_add_tab(
    spreadsheet_id: str,
    title: str,
    rows: int = 1000,
    columns: int = 26,
    index: int | None = None,
) -> dict:
    """Create a new tab/sheet. `index` (optional) is its 0-based position."""
    svc = get_sheets_service()
    props = {
        "title": title,
        "gridProperties": {"rowCount": rows, "columnCount": columns},
    }
    if index is not None:
        props["index"] = index
    res = await _batch_update(
        svc, spreadsheet_id, [{"addSheet": {"properties": props}}]
    )
    added = res["replies"][0]["addSheet"]["properties"]
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "title": added.get("title"),
            "sheet_id": added.get("sheetId"),
            "index": added.get("index"),
        },
    }


@handle_google_errors
async def sheets_rename_tab(spreadsheet_id: str, title: str, new_title: str) -> dict:
    """Rename a tab from `title` to `new_title`."""
    svc = get_sheets_service()
    sheet_id = await _resolve_sheet_id(svc, spreadsheet_id, title)
    await _batch_update(svc, spreadsheet_id, [{
        "updateSheetProperties": {
            "properties": {"sheetId": sheet_id, "title": new_title},
            "fields": "title",
        }
    }])
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "sheet_id": sheet_id,
            "old_title": title,
            "new_title": new_title,
        },
    }


@handle_google_errors
async def sheets_get_tabs(spreadsheet_id: str) -> dict:
    """List every tab with its numeric sheetId, index, grid size, frozen-row/col
    counts, and hidden flag. batchUpdate GridRanges reference a tab by sheetId (not
    name), so call this first to get the ids you need for sheets_batch_update."""
    svc = get_sheets_service()
    res = await asyncio.to_thread(
        lambda: svc.spreadsheets().get(
            spreadsheetId=spreadsheet_id,
            fields=("sheets.properties(title,sheetId,index,hidden,"
                    "gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))"),
        ).execute()
    )
    tabs = []
    for s in res.get("sheets", []):
        p = s["properties"]
        g = p.get("gridProperties", {})
        tabs.append({
            "title": p.get("title"),
            "sheet_id": p.get("sheetId"),
            "index": p.get("index"),
            "hidden": p.get("hidden", False),
            "rows": g.get("rowCount"),
            "columns": g.get("columnCount"),
            "frozen_rows": g.get("frozenRowCount", 0),
            "frozen_columns": g.get("frozenColumnCount", 0),
        })
    return {"success": True, "data": {"spreadsheet_id": spreadsheet_id, "tabs": tabs}}


@handle_google_errors
async def sheets_batch_update(spreadsheet_id: str, requests: list) -> dict:
    """Power tool: raw Sheets API spreadsheets.batchUpdate passthrough — for visual
    formatting the other tools don't cover (header bold/background colors, frozen
    rows/cols, column widths, borders, banded rows, hiding helper columns, etc.).
    `requests` is a list of request dicts (repeatCell, updateDimensionProperties,
    updateSheetProperties, updateBorders, addBanding, …). GridRanges reference a tab by
    numeric sheetId — get them from sheets_get_tabs first."""
    svc = get_sheets_service()
    if not isinstance(requests, list) or not requests:
        raise ValueError("requests must be a non-empty list of batchUpdate request dicts")
    res = await _batch_update(svc, spreadsheet_id, requests)
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "applied": len(requests),
            "replies": res.get("replies", []),
        },
    }


@handle_google_errors
async def sheets_delete_tab(spreadsheet_id: str, title: str) -> dict:
    """Delete a tab by name. DESTRUCTIVE and not undoable via the API — the
    caller is responsible for confirming intent first."""
    svc = get_sheets_service()
    sheet_id = await _resolve_sheet_id(svc, spreadsheet_id, title)
    await _batch_update(
        svc, spreadsheet_id, [{"deleteSheet": {"sheetId": sheet_id}}]
    )
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "deleted_title": title,
            "sheet_id": sheet_id,
        },
    }


@handle_google_errors
async def sheets_set_number_format(
    spreadsheet_id: str,
    range: str,
    pattern: str = "@",
    format_type: str = "TEXT",
) -> dict:
    """Set the number format of a range (must include a tab name, e.g.
    'Sheet1!A2:A200'). Defaults force plain TEXT ('@') so IDs, leading-zero
    codes, and dates are stored verbatim. `format_type` is a Sheets
    NumberFormatType (TEXT, NUMBER, PERCENT, CURRENCY, DATE, TIME, DATE_TIME,
    SCIENTIFIC); `pattern` is the format string for that type."""
    svc = get_sheets_service()
    grid = await _a1_to_gridrange(svc, spreadsheet_id, range)
    await _batch_update(svc, spreadsheet_id, [{
        "repeatCell": {
            "range": grid,
            "cell": {
                "userEnteredFormat": {
                    "numberFormat": {"type": format_type, "pattern": pattern}
                }
            },
            "fields": "userEnteredFormat.numberFormat",
        }
    }])
    return {
        "success": True,
        "data": {
            "spreadsheet_id": spreadsheet_id,
            "range": range,
            "format_type": format_type,
            "pattern": pattern,
        },
    }
