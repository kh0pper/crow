"""
Google Docs <-> Markdown conversion functions.

Pure conversion with no API dependencies (independently testable).
Handles reading (Docs structure -> markdown) and writing (markdown -> Docs API requests).
"""

import re
from dataclasses import dataclass
from typing import Any

# --- Reading: Google Docs structure -> Markdown ---

_HEADING_MAP = {
    "HEADING_1": "# ",
    "HEADING_2": "## ",
    "HEADING_3": "### ",
    "HEADING_4": "#### ",
    "HEADING_5": "##### ",
    "HEADING_6": "###### ",
}


def _paragraph_text_runs(paragraph: dict) -> str:
    """Render a paragraph's inline elements as a single line of markdown text."""
    line_parts = []
    for elem in paragraph.get("elements", []):
        text_run = elem.get("textRun")
        if not text_run:
            continue

        text = text_run.get("content", "")
        style = text_run.get("textStyle", {})

        bold = style.get("bold", False)
        italic = style.get("italic", False)

        if text.endswith("\n"):
            text = text[:-1]

        if not text:
            continue

        if bold and italic:
            text = f"***{text}***"
        elif bold:
            text = f"**{text}**"
        elif italic:
            text = f"*{text}*"

        line_parts.append(text)

    return "".join(line_parts)


def _paragraph_to_markdown(paragraph: dict, lists_info: dict) -> str:
    """Render a top-level paragraph element to one markdown line (heading / list / plain)."""
    para_style = paragraph.get("paragraphStyle", {})
    named_style = para_style.get("namedStyleType", "NORMAL_TEXT")
    heading_prefix = _HEADING_MAP.get(named_style, "")

    bullet = paragraph.get("bullet")
    list_prefix = ""
    if bullet:
        list_id = bullet.get("listId", "")
        nesting_level = bullet.get("nestingLevel", 0)
        indent = "  " * nesting_level

        list_props = lists_info.get(list_id, {}).get("listProperties", {})
        nesting_levels = list_props.get("nestingLevels", [])

        is_ordered = False
        if nesting_levels and nesting_level < len(nesting_levels):
            glyph_type = nesting_levels[nesting_level].get("glyphType", "")
            if glyph_type and glyph_type != "GLYPH_TYPE_UNSPECIFIED":
                is_ordered = True

        list_prefix = f"{indent}1. " if is_ordered else f"{indent}- "

    line_text = _paragraph_text_runs(paragraph)

    if heading_prefix and line_text:
        return f"{heading_prefix}{line_text}"
    if list_prefix:
        return f"{list_prefix}{line_text}"
    return line_text


def _cell_content_to_text(cell_content: list) -> str:
    """Flatten a table cell's content (list of paragraphs) to a single inline string.

    GFM table cells don't support block structure, so bullets/headings are
    rendered as inline text with formatting preserved. Pipes are escaped and
    newlines collapsed to spaces so the row stays on one line.
    """
    parts = []
    for element in cell_content:
        paragraph = element.get("paragraph")
        if not paragraph:
            continue
        parts.append(_paragraph_text_runs(paragraph))
    text = " ".join(p for p in parts if p).strip()
    return text.replace("|", "\\|").replace("\n", " ")


def _table_to_gfm(table: dict) -> str:
    """Convert a Google Docs table element to a GFM markdown table.

    The first row is treated as the header. If a cell has no text (empty
    header), a non-breaking placeholder is inserted so column count is
    preserved. Returns '' if the table is empty.
    """
    rows = table.get("tableRows", [])
    if not rows:
        return ""

    rendered_rows = []
    n_cols = 0
    for row in rows:
        cells = row.get("tableCells", [])
        if len(cells) > n_cols:
            n_cols = len(cells)
        cell_texts = [_cell_content_to_text(c.get("content", [])) for c in cells]
        rendered_rows.append(cell_texts)

    if n_cols == 0:
        return ""

    for row in rendered_rows:
        while len(row) < n_cols:
            row.append("")
        for i, cell in enumerate(row):
            if cell == "":
                row[i] = " "

    header = "| " + " | ".join(rendered_rows[0]) + " |"
    separator = "| " + " | ".join(["---"] * n_cols) + " |"
    body = ["| " + " | ".join(r) + " |" for r in rendered_rows[1:]]
    return "\n".join([header, separator, *body])


def docs_structure_to_markdown(doc_body: dict, doc_title: str, lists_info: dict) -> str:
    """
    Convert a Google Docs API document body to markdown.

    Args:
        doc_body: The "body" field from documents.get() response
        doc_title: Document title (used as H1 if not already a heading)
        lists_info: The "lists" field from documents.get() response

    Returns:
        Markdown string
    """
    content = doc_body.get("content", [])
    lines = []
    has_title_heading = False

    for element in content:
        paragraph = element.get("paragraph")
        table = element.get("table")

        if paragraph is not None:
            para_style = paragraph.get("paragraphStyle", {})
            named_style = para_style.get("namedStyleType", "NORMAL_TEXT")
            if _HEADING_MAP.get(named_style) and not has_title_heading:
                has_title_heading = True

            rendered = _paragraph_to_markdown(paragraph, lists_info)
            lines.append(rendered if rendered else "")
        elif table is not None:
            gfm = _table_to_gfm(table)
            if gfm:
                lines.append(gfm)

    result = "\n\n".join(lines)
    result = re.sub(r"\n{3,}", "\n\n", result)

    if not has_title_heading and doc_title:
        result = f"# {doc_title}\n\n{result}"

    return result.strip()


# --- Writing: Markdown -> Google Docs API requests ---


@dataclass
class TextSpan:
    """A span of text with formatting flags."""

    text: str
    bold: bool = False
    italic: bool = False


def _parse_inline_formatting(text: str) -> list[TextSpan]:
    """Parse inline markdown formatting into spans."""
    if "*" not in text:
        return [TextSpan(text=text)]

    spans = []
    pos = 0
    bold = False
    italic = False

    while pos < len(text):
        star_count = 0
        while pos < len(text) and text[pos] == "*":
            star_count += 1
            pos += 1

        if star_count == 0:
            chunk_start = pos
            while pos < len(text) and text[pos] != "*":
                pos += 1
            spans.append(TextSpan(text=text[chunk_start:pos], bold=bold, italic=italic))
        elif star_count >= 3:
            bold = not bold
            italic = not italic
        elif star_count == 2:
            bold = not bold
        elif star_count == 1:
            italic = not italic

    if bold or italic:
        return [TextSpan(text=text)]

    return [s for s in spans if s.text]


def _utf16_len(text: str) -> int:
    """UTF-16 code unit length. Google Docs API counts positions in UTF-16."""
    return len(text.encode("utf-16-le")) // 2


# --- Soft wraps ---

_HEADING_LINE_RE = re.compile(r"^#{1,6}\s+")
_BULLET_LINE_RE = re.compile(r"^[-*+]\s+")
_ORDERED_LINE_RE = re.compile(r"^\d+\.\s+")


def _starts_own_block(stripped: str) -> bool:
    """True if this line opens a block that must not fold into the line above."""
    return bool(
        _HEADING_LINE_RE.match(stripped)
        or _BULLET_LINE_RE.match(stripped)
        or _ORDERED_LINE_RE.match(stripped)
        or stripped.startswith("|")
        or stripped.startswith(">")
    )


def _ends_with_hard_break(raw: str) -> bool:
    """Markdown hard line break: two trailing spaces, or a trailing backslash."""
    without_newline = raw.rstrip("\n")
    return without_newline.endswith("  ") or without_newline.endswith("\\")


def fold_soft_wraps(lines: list[str]) -> list[str]:
    """
    Join lines that markdown treats as soft wraps inside one block.

    A single newline wraps text within a paragraph or list item; only a blank
    line starts a new paragraph. Without this, source markdown hard-wrapped for
    readability renders with a paragraph break at every wrap point.

    Headings, list markers, table rows, and blockquotes each open their own
    block and never fold upward. A heading never absorbs the line beneath it.
    Lines ending in two spaces or a backslash keep their break, which is how a
    stacked block such as an email signature stays stacked.
    """
    folded: list[str] = []
    # Whether the last emitted line can still take a continuation.
    open_for_continuation = False

    for raw in lines:
        stripped = raw.strip()

        if not stripped:
            folded.append("")
            open_for_continuation = False
            continue

        if open_for_continuation and not _starts_own_block(stripped):
            folded[-1] = f"{folded[-1]} {stripped}"
        else:
            folded.append(stripped)

        last = folded[-1]
        open_for_continuation = (
            not _ends_with_hard_break(raw)
            and not _HEADING_LINE_RE.match(last)
            and not last.startswith("|")
        )

    # Strip the hard-break markers now that they have done their job.
    return [line.rstrip("\\").rstrip() for line in folded]


# --- GFM pipe tables ---

_TABLE_SEPARATOR_RE = re.compile(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$")


def _parse_table_row(line: str) -> list[str]:
    """Split one GFM pipe-table row into stripped cell strings."""
    row = line.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|"):
        row = row[:-1]
    return [c.strip() for c in row.split("|")]


def split_markdown_segments(markdown: str) -> "list[tuple[str, Any]]":
    """
    Split markdown into ("md", text) and ("table", rows) segments.

    A table block is a pipe row followed by a GFM separator row (|---|---|),
    plus every consecutive following line starting with "|". The separator row
    is dropped; each row is a list of cell strings padded/truncated to the
    header's column count. Everything else stays in "md" segments, preserving
    line order, for markdown_to_docs_requests.

    Native-table rendering lives in docs.py (insertTable needs its own API
    round trips); this splitter stays pure.
    """
    lines = markdown.split("\n")
    segments: "list[tuple[str, Any]]" = []
    md_buf: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        stripped = lines[i].strip()
        nxt = lines[i + 1].strip() if i + 1 < n else ""
        if (
            stripped.startswith("|")
            and "|" in stripped[1:]
            and "-" in nxt
            and _TABLE_SEPARATOR_RE.match(nxt)
        ):
            header = _parse_table_row(stripped)
            cols = len(header)
            rows = [header]
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                cells = _parse_table_row(lines[i])
                rows.append((cells + [""] * cols)[:cols])
                i += 1
            if md_buf:
                segments.append(("md", "\n".join(md_buf)))
                md_buf = []
            segments.append(("table", rows))
            continue
        md_buf.append(lines[i])
        i += 1
    if md_buf:
        segments.append(("md", "\n".join(md_buf)))
    return segments


def markdown_to_docs_requests(
    markdown: str,
    start_index: int = 1,
    reset_normal_text: bool = False,
    font_family: str | None = None,
) -> tuple[list[dict], int]:
    """
    Convert markdown to Google Docs batchUpdate requests.

    Args:
        markdown: Source markdown.
        start_index: Document index the content is inserted at.
        reset_normal_text: Emit a NORMAL_TEXT reset over the inserted range,
            for insertions that land after a heading (see ordering note below).
        font_family: Apply this font to every inserted run, so the text cannot
            inherit the document's default font on export.

    Request order is load-bearing. Google applies a named style's full
    definition when namedStyleType is set, so a NORMAL_TEXT reset emitted after
    the styling requests wipes both the heading styles and the character
    formatting of everything it covers. Emission order is therefore:
    insert -> NORMAL_TEXT reset -> heading styles -> bullets -> font -> runs.

    Returns:
        (requests, end_index) -- list of API requests and the new end index
    """
    lines = fold_soft_wraps(markdown.split("\n"))

    parsed_lines = []
    for line in lines:
        stripped = line.strip()

        if not stripped:
            parsed_lines.append({"type": "empty", "text": "", "spans": []})
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            content = heading_match.group(2)
            parsed_lines.append(
                {
                    "type": "heading",
                    "level": level,
                    "text": content,
                    "spans": _parse_inline_formatting(content),
                }
            )
            continue

        bullet_match = re.match(r"^[-*+]\s+(.+)$", stripped)
        if bullet_match:
            content = bullet_match.group(1)
            parsed_lines.append(
                {
                    "type": "bullet",
                    "text": content,
                    "spans": _parse_inline_formatting(content),
                }
            )
            continue

        ordered_match = re.match(r"^\d+\.\s+(.+)$", stripped)
        if ordered_match:
            content = ordered_match.group(1)
            parsed_lines.append(
                {
                    "type": "ordered",
                    "text": content,
                    "spans": _parse_inline_formatting(content),
                }
            )
            continue

        parsed_lines.append(
            {
                "type": "normal",
                "text": stripped,
                "spans": _parse_inline_formatting(stripped),
            }
        )

    plain_lines = []
    formatting = []
    paragraph_styles = []
    bullet_ranges = []
    current_offset = 0

    for parsed in parsed_lines:
        if parsed["type"] == "empty":
            plain_lines.append("\n")
            current_offset += 1
            continue

        line_text_parts = []
        for span in parsed["spans"]:
            span_start = current_offset
            line_text_parts.append(span.text)
            span_len = _utf16_len(span.text)
            span_end = span_start + span_len
            current_offset = span_end

            if span.bold or span.italic:
                formatting.append((span_start, span_end, span.bold, span.italic))

        line_text = "".join(line_text_parts)
        plain_lines.append(line_text + "\n")
        current_offset += 1

        line_start = current_offset - _utf16_len(line_text) - 1
        line_end = current_offset

        if parsed["type"] == "heading":
            paragraph_styles.append(
                (line_start, line_end, f"HEADING_{parsed['level']}")
            )
        elif parsed["type"] == "bullet":
            bullet_ranges.append((line_start, line_end, "BULLET_DISC_CIRCLE_SQUARE"))
        elif parsed["type"] == "ordered":
            bullet_ranges.append((line_start, line_end, "NUMBERED_DECIMAL_ALPHA_ROMAN"))

    plain_text = "".join(plain_lines)

    if not plain_text.strip():
        return [], start_index

    requests = []
    end_index = start_index + _utf16_len(plain_text)

    # 1. Insert the plain text
    requests.append(
        {
            "insertText": {
                "location": {"index": start_index},
                "text": plain_text,
            }
        }
    )

    # 2. Reset the whole range to NORMAL_TEXT, before anything is styled.
    # Text inserted after a heading otherwise inherits that heading's style.
    if reset_normal_text:
        requests.append(
            {
                "updateParagraphStyle": {
                    "range": {
                        "startIndex": start_index,
                        "endIndex": end_index,
                    },
                    "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
                    "fields": "namedStyleType",
                }
            }
        )

    # 3. Apply heading styles
    for line_start, line_end, style_name in paragraph_styles:
        requests.append(
            {
                "updateParagraphStyle": {
                    "range": {
                        "startIndex": start_index + line_start,
                        "endIndex": start_index + line_end,
                    },
                    "paragraphStyle": {"namedStyleType": style_name},
                    "fields": "namedStyleType",
                }
            }
        )

    # 4. Apply bullet/ordered list styles
    for line_start, line_end, bullet_preset in bullet_ranges:
        requests.append(
            {
                "createParagraphBullets": {
                    "range": {
                        "startIndex": start_index + line_start,
                        "endIndex": start_index + line_end,
                    },
                    "bulletPreset": bullet_preset,
                }
            }
        )

    # 5. Pin the font across the range. After the named styles, which each
    # carry their own font, and before the runs, so bold survives.
    if font_family:
        requests.append(
            {
                "updateTextStyle": {
                    "range": {
                        "startIndex": start_index,
                        "endIndex": end_index,
                    },
                    "textStyle": {"weightedFontFamily": {"fontFamily": font_family}},
                    "fields": "weightedFontFamily",
                }
            }
        )

    # 6. Apply inline formatting last, so nothing downstream flattens it
    for span_start, span_end, is_bold, is_italic in formatting:
        fields = []
        style = {}
        if is_bold:
            fields.append("bold")
            style["bold"] = True
        if is_italic:
            fields.append("italic")
            style["italic"] = True

        requests.append(
            {
                "updateTextStyle": {
                    "range": {
                        "startIndex": start_index + span_start,
                        "endIndex": start_index + span_end,
                    },
                    "textStyle": style,
                    "fields": ",".join(fields),
                }
            }
        )

    return requests, end_index
