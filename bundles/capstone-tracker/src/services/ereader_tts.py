"""
E-Reader TTS Service - Paragraph-level Text-to-Speech with word timing.

Uses Edge TTS WordBoundary events to provide per-word timing data for
synchronized highlighting in the e-reader frontend.
"""

import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Lazy import
edge_tts = None


def _ensure_edge_tts():
    """Lazily import edge_tts module."""
    global edge_tts
    if edge_tts is None:
        import edge_tts as _edge_tts
        edge_tts = _edge_tts


def split_into_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs on double newlines, filtering empties."""
    parts = re.split(r'\n\s*\n', text.strip())
    return [p.strip() for p in parts if p.strip()]


def reflow_pdf_text(text: str) -> str:
    """Clean up PDF-extracted text: rejoin wrapped lines, detect paragraphs.

    PDF extraction produces hard line breaks at column edges and hyphenated
    word breaks. This function:
    1. Removes [Page N] markers (keeps content)
    2. Rejoins hyphenated line breaks (e.g. "selec-\\ntive" -> "selective")
    3. Detects paragraph boundaries via heuristics
    4. Outputs clean text with double-newline paragraph separators
    """
    # Collapse page markers into a single newline (not double) so reflow
    # can join sentences that span page boundaries.
    text = re.sub(r'\n*\[Page \d+\]\n*', '\n', text)

    # Remove page numbers that appear alone on a line (e.g. "615", "616")
    text = re.sub(r'\n\d{3}\n', '\n', text)

    # Remove common running headers:
    # "622 Educational Policy" or "West et al. / ... 617"
    # General pattern: line that's just a page number + journal name,
    # or author et al. + page number
    text = re.sub(
        r'\n\d{2,4}\s+[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*\n', '\n', text
    )
    text = re.sub(
        r'\n[A-Z][a-z]+(?:\s+et\s+al\.)[^\n]*?\d{2,4}\s*\n', '\n', text
    )

    # Rejoin hyphenated line breaks
    text = re.sub(r'-\s*\n\s*', '', text)

    lines = text.split('\n')
    paragraphs = []
    current = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            # Blank line = paragraph break
            if current:
                paragraphs.append(' '.join(current))
                current = []
            continue

        # Detect paragraph boundaries within continuous text:
        # Previous line ends with sentence-ending punctuation (possibly
        # followed by footnote numbers, closing quotes/parens) and
        # current line starts with a capital letter
        if (current
                and len(current[-1]) > 1
                and re.search(r'[.?!][\d"\')\]]*$', current[-1])
                and stripped[0].isupper()):
            # Check it's not a mid-sentence capital (common abbreviations)
            last_word = current[-1].split()[-1] if current[-1].split() else ""
            # Strip trailing footnote numbers for abbreviation check
            check_word = re.sub(r'\d+$', '', last_word)
            # Don't break after common abbreviations or single initials
            if not re.match(r'^[A-Z]\.$', check_word) and check_word not in (
                'Dr.', 'Mr.', 'Mrs.', 'Ms.', 'St.', 'Jr.', 'Sr.',
                'vs.', 'Vol.', 'No.', 'pp.', 'ed.', 'eds.',
                'al.', 'etc.', 'i.e.', 'e.g.', 'U.S.',
            ):
                paragraphs.append(' '.join(current))
                current = []

        current.append(stripped)

    if current:
        paragraphs.append(' '.join(current))

    # Clean up extra spaces
    paragraphs = [re.sub(r'\s{2,}', ' ', p).strip() for p in paragraphs]
    # Filter empty and very short paragraphs (page artifacts)
    paragraphs = [p for p in paragraphs if len(p) > 5]

    return '\n\n'.join(paragraphs)


def strip_chart_axis_data(text: str) -> str:
    """Strip chart axis data (runs of consecutive numbers) from text.

    PDF chart extraction produces axis tick marks and data-point values
    as regular text — either appended to figure captions or merged into
    body paragraphs. This strips runs of 6+ consecutive bare numbers
    and any trailing axis-label fragments.
    """
    lines = text.split('\n')
    result = []
    for line in lines:
        result.append(_strip_number_run(line))
    return '\n'.join(result)


def _strip_number_run(line: str, min_run: int = 6) -> str:
    """Remove the first run of min_run+ consecutive bare numbers from a line.

    Preserves numbers that end a year range (e.g. "1997 to 2013").
    """
    words = line.split()
    if len(words) < min_run:
        return line

    run_start = None
    run_len = 0

    for i, word in enumerate(words):
        if re.match(r'^\d[\d,.%$]*$', word):
            if run_len == 0:
                run_start = i
            run_len += 1
        else:
            if run_len >= min_run:
                # Preserve end of year range ("to 2013")
                keep_to = run_start
                if (run_start > 0
                        and words[run_start - 1].lower()
                        in ('to', 'through', '\u2013', '-')):
                    keep_to = run_start + 1
                return ' '.join(words[:keep_to]).rstrip()
            run_start = None
            run_len = 0

    # Run extends to end of line
    if run_len >= min_run:
        keep_to = run_start
        if (run_start > 0
                and words[run_start - 1].lower()
                in ('to', 'through', '\u2013', '-')):
            keep_to = run_start + 1
        return ' '.join(words[:keep_to]).rstrip()

    return line


def strip_running_headers(text: str) -> str:
    """Auto-detect and strip running headers from PDF-extracted text.

    Academic PDFs have running headers (shortened title on odd pages,
    author name on even pages). PDF extraction sometimes merges these
    into content lines. This detects repeated short phrases at line
    starts and removes them.
    """
    lines = text.split('\n')
    non_empty = [l.strip() for l in lines if l.strip()]

    if len(non_empty) < 10:
        return text

    # Count occurrences and line positions of each short phrase at line starts
    prefix_counts = {}  # prefix -> {standalone: N, as_prefix: N}
    prefix_lines = {}   # prefix -> [line_indices] (for spread check)
    for idx, line in enumerate(non_empty):
        words = line.split()
        for n in range(1, min(13, len(words) + 1)):
            prefix = ' '.join(words[:n])
            if prefix not in prefix_counts:
                prefix_counts[prefix] = {'standalone': 0, 'as_prefix': 0}
                prefix_lines[prefix] = []
            prefix_lines[prefix].append(idx)
            if len(words) == n:
                prefix_counts[prefix]['standalone'] += 1
            else:
                prefix_counts[prefix]['as_prefix'] += 1

    # Find headers: repeated short phrases starting with a capital letter
    headers = []
    total_lines = len(non_empty)
    for prefix, counts in prefix_counts.items():
        words = prefix.split()
        # Single-word headers must start uppercase
        if len(words) == 1 and not words[0][0].isupper():
            continue
        # Single words must be 4+ chars (skip "The", "For", etc.)
        if len(words) == 1 and len(prefix) < 4:
            continue
        # Multi-word: standalone + prefix path (original, conservative)
        if len(words) >= 2 and counts['standalone'] >= 1 and counts['as_prefix'] >= 2:
            if words[0][0].isupper():
                headers.append(prefix)
        # Multi-word: prefix-only path (catches lowercase headers like
        # "journal of education finance" that never appear standalone)
        elif len(words) >= 2 and counts['as_prefix'] >= 4:
            positions = prefix_lines[prefix]
            span = positions[-1] - positions[0]
            if span >= total_lines * 0.4:
                headers.append(prefix)
        # Single-word: standalone 3+ times AND spread across the document
        # (filters out charter school names clustered in table rows)
        elif counts['standalone'] >= 3:
            positions = prefix_lines[prefix]
            span = positions[-1] - positions[0]
            if span >= total_lines * 0.6:
                headers.append(prefix)

    if not headers:
        return text

    # Keep longest non-overlapping headers (remove sub-prefixes)
    headers.sort(key=len, reverse=True)
    final_headers = []
    for h in headers:
        if not any(fh.startswith(h) for fh in final_headers):
            final_headers.append(h)

    # Strip headers from lines
    result = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue
        modified = False
        for header in final_headers:
            if stripped == header:
                result.append('')
                modified = True
                break
            elif stripped.startswith(header + ' '):
                remainder = stripped[len(header):].strip()
                # Strip leading page number (1-3 digits only — avoids
                # stripping 4-digit years like 2019, 2023)
                remainder = re.sub(r'^\d{1,3}\s+', '', remainder)
                result.append(remainder)
                modified = True
                break
        if not modified:
            result.append(line)

    return '\n'.join(result)


def strip_publisher_watermarks(text: str) -> str:
    """Strip publisher download watermarks and page margin artifacts.

    Academic PDFs from Wiley, Elsevier, etc. contain per-page artifacts
    that pdftotext extracts alongside content:
    - Download notices ("Downloaded from https://... Online Library on ...")
    - Terms and Conditions URLs
    - Bare DOI fragments ("10.1002/asi")
    - Merged-word sidebar artifacts ("OFASSOCIATION")
    - Journal citation fragments in headers/footers
    - Submission/revision metadata ("Received...; revised...; accepted...")
    - Publisher URLs and short DOI lines
    - Merged year+page numbers ("20162015 1173")
    - Color figure boilerplate notices
    """
    # ── Inline substitutions (strip boilerplate from within lines) ──
    # JSTOR download notice + terms (often merged inline with content)
    text = re.sub(
        r'This content downloaded from \d[\d.]+\s+on\s+\w+,\s+\d+\s+\w+\s+\d{4}\s+[\d:]+\s+UTC\s*'
        r'All use subject to https?://about\.jstor\.org/terms\s*',
        '\n\n', text, flags=re.IGNORECASE,
    )
    # Standalone variants
    text = re.sub(
        r'All use subject to https?://about\.jstor\.org/terms\s*',
        '', text, flags=re.IGNORECASE,
    )
    text = re.sub(
        r'This content downloaded from \d[\d.]+[^\n]*UTC\s*',
        '', text, flags=re.IGNORECASE,
    )

    # Wiley color figure notice in captions
    text = re.sub(
        r'\s*\[Color figure can be viewed in the online issue,'
        r'[^]]*\]\.?',
        '', text,
    )

    lines = text.split('\n')
    result = []

    # ── Compiled patterns for line removal ──
    remove_patterns = [
        # Publisher download watermark
        re.compile(
            r'Downloaded from https?://.*(?:Online Library|wiley\.com'
            r'|elsevier\.com|springer\.com|sagepub\.com|tandfonline\.com)',
            re.IGNORECASE,
        ),
        # Terms and Conditions notice
        re.compile(
            r'Terms and Conditions.*(?:wiley|elsevier|springer'
            r'|Creative Commons)',
            re.IGNORECASE,
        ),
    ]

    # Bare DOI fragment (just "10.NNNN/xxx" with no prose around it)
    bare_doi_re = re.compile(r'^10\.\d{4,}/\S*$')
    # Short DOI line: "DOI: 10.NNNN/xxx" possibly with publisher URL
    short_doi_re = re.compile(r'^DOI:\s*10\.\d{4,}')
    # Merged-word sidebar artifacts (ALL CAPS, no spaces, 8+ chars)
    merged_caps_re = re.compile(r'^[A-Z]{8,}$')
    # Short ALL-CAPS lines (journal sidebar fragments)
    caps_frag_re = re.compile(r'^[A-Z][A-Z\s,–—•]+$')
    # Journal citation header/footer fragments
    citation_frag_re = re.compile(r'\d+\(\d+\):\d+[–-]\d+')
    # Bullet-char citation placeholders: "••(••):••–••, 2015"
    bullet_re = re.compile(r'••')
    # Merged year+page numbers: "20162015 1173"
    year_page_re = re.compile(r'^\d{8}\s+\d{3,4}$')
    # Journal submission metadata: "Received Month DD, YYYY; revised..."
    received_re = re.compile(r'^Received\s+\w+\s+\d{1,2},\s*\d{4}')
    # Short publisher URL fragments
    pub_url_re = re.compile(
        r'wileyonlinelibrary\.com|onlinelibrary\.wiley\.com'
        r'|sciencedirect\.com|link\.springer\.com',
        re.IGNORECASE,
    )
    # Publisher/society name fragments: "ASIS&T", "inLibrary", "Published"
    # (short lines only — these appear as garbled sidebar text)
    pub_frag_re = re.compile(
        r'(?:ASIS&T|inLibrary|Publishedonline|Published\s*online'
        r'|Wiley\s+Online)',
        re.IGNORECASE,
    )
    # Bare "DOI:" or "DOI:DOI:" without a number
    bare_doi_label_re = re.compile(r'^DOI:\s*(?:DOI:)?\s*$')
    # Lowercase "doi: 10.NNNN/..." line
    lowercase_doi_re = re.compile(r'^doi:\s*10\.\d{4,}', re.IGNORECASE)
    # Copyright line: "© 2011 ..." or "Ⓒ 2011 ..."
    copyright_re = re.compile(r'^[©Ⓒ]\s*\d{4}\s+')

    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        # Regex-search patterns (any match → remove)
        if any(p.search(stripped) for p in remove_patterns):
            result.append('')
            continue

        # Bare DOI fragment
        if bare_doi_re.match(stripped):
            result.append('')
            continue
        # Short standalone DOI line (< 60 chars)
        if len(stripped) < 60 and short_doi_re.match(stripped):
            result.append('')
            continue
        # Bare "DOI:" label
        if bare_doi_label_re.match(stripped):
            result.append('')
            continue
        # Lowercase DOI line (short)
        if len(stripped) < 60 and lowercase_doi_re.match(stripped):
            result.append('')
            continue
        # Copyright line
        if len(stripped) < 80 and copyright_re.match(stripped):
            result.append('')
            continue
        # Merged ALL-CAPS word
        if merged_caps_re.match(stripped) and len(stripped) >= 10:
            result.append('')
            continue
        # Short ALL-CAPS fragments (3-30 chars)
        if 3 <= len(stripped) < 30 and caps_frag_re.match(stripped):
            result.append('')
            continue
        # Citation fragment in short line
        if len(stripped) < 60 and citation_frag_re.search(stripped):
            result.append('')
            continue
        # Bullet placeholders in short line
        if len(stripped) < 40 and bullet_re.search(stripped):
            result.append('')
            continue
        # Merged year+page numbers
        if year_page_re.match(stripped):
            result.append('')
            continue
        # Journal submission metadata
        if received_re.match(stripped):
            result.append('')
            continue
        # Short publisher URL fragments (< 60 chars)
        if len(stripped) < 60 and pub_url_re.search(stripped):
            result.append('')
            continue
        # Publisher/society name fragments (< 60 chars)
        if len(stripped) < 60 and pub_frag_re.search(stripped):
            result.append('')
            continue
        # Wiley ISSN/download ID lines
        if re.match(r'^\d{7,},\s*\d{4},', stripped):
            result.append('')
            continue

        result.append(line)

    return '\n'.join(result)


def split_figure_captions(text: str) -> str:
    """Separate figure captions from body text when merged on one line.

    PDF extraction sometimes puts a figure caption and the following
    body text on the same line. This splits them apart when the line
    starts with "Figure N." and is long enough to contain body text.
    """
    lines = text.split('\n')
    result = []
    for line in lines:
        stripped = line.strip()
        # Only process long lines starting with "Figure N"
        if len(stripped) > 150 and re.match(r'Figure\s+\d', stripped):
            # Split after the last year in the caption, before body text
            m = re.match(
                r'(Figure\s+\d+\.?\s+.+\b\d{4})\s+([A-Z][a-z])',
                stripped,
            )
            if m:
                result.append(m.group(1))
                result.append('')  # blank line forces paragraph break in reflow
                result.append(m.group(2) + stripped[m.end():])
                continue
        result.append(line)
    return '\n'.join(result)


def presplit_long_lines(text: str, max_len: int = 300) -> str:
    """Pre-split very long lines at sentence boundaries.

    PDF extraction sometimes puts an entire page on one line (1000+ chars).
    reflow_pdf_text() only detects paragraph breaks across lines, not
    within them. This splits long lines at sentence endings so reflow
    can find paragraph boundaries.
    """
    lines = text.split('\n')
    result = []
    for line in lines:
        if len(line.strip()) > max_len:
            parts = re.split(r'(?<=[.!?])\s+', line.strip())
            result.extend(parts)
        else:
            result.append(line)
    return '\n'.join(result)


def extract_table_blocks(text: str) -> tuple[str, dict[str, str]]:
    """Extract [TABLE] blocks from text, replacing with placeholders.

    Before reflow_pdf_text() runs, this pulls out table markdown so it
    won't be destroyed by line-joining heuristics.

    Returns:
        (text_with_placeholders, {placeholder_key: table_markdown})
    """
    tables = {}
    counter = 0
    lines = text.split('\n')
    result_lines = []
    i = 0

    while i < len(lines):
        stripped = lines[i].strip()
        if stripped == '[TABLE]' or '[TABLE]' in stripped:
            # Handle [TABLE] embedded mid-line (e.g. "Debt Service [TABLE]")
            if stripped != '[TABLE]' and '[TABLE]' in stripped:
                before = stripped.split('[TABLE]')[0].strip()
                if before:
                    result_lines.append(before)

            # Collect table lines (pipe-delimited rows) until blank or non-pipe
            table_lines = []
            i += 1
            while i < len(lines):
                line = lines[i].strip()
                if not line:
                    break
                if line.startswith('|') or re.match(r'^[-|:\s]+$', line):
                    table_lines.append(lines[i])
                    i += 1
                else:
                    break
            if table_lines:
                placeholder = f'__TABLE_PLACEHOLDER_{counter}__'
                tables[placeholder] = '\n'.join(table_lines)
                result_lines.append('')
                result_lines.append(placeholder)
                result_lines.append('')
                counter += 1
            else:
                # [TABLE] with no table content — keep as-is
                result_lines.append(lines[i - 1] if i > 0 else stripped)
        else:
            result_lines.append(lines[i])
            i += 1

    return '\n'.join(result_lines), tables


def restore_table_blocks(
    paragraphs: list[str], tables: dict[str, str]
) -> list[str]:
    """Replace table placeholders in paragraphs with [TABLE] blocks.

    After reflow + split, find placeholder strings and restore original
    table markdown as standalone paragraphs.
    """
    result = []
    for para in paragraphs:
        stripped = para.strip()
        # Check if this paragraph IS a placeholder (most common case)
        if stripped in tables:
            result.append(f'[TABLE]\n{tables[stripped]}')
            continue
        # Check if placeholder is embedded in merged text
        found = False
        for placeholder, table_md in tables.items():
            if placeholder in para:
                # Split around placeholder, emit non-empty parts
                parts = para.split(placeholder)
                before = parts[0].strip()
                after = parts[1].strip() if len(parts) > 1 else ''
                if before:
                    result.append(before)
                result.append(f'[TABLE]\n{table_md}')
                if after:
                    result.append(after)
                found = True
                break
        if not found:
            result.append(para)
    return result


def table_to_speech_text(table_markdown: str) -> str:
    """Convert markdown table to readable prose for TTS.

    Skips separator rows, strips markdown formatting, joins cells with
    semicolons and rows with periods.
    """
    lines = table_markdown.strip().split('\n')
    spoken_rows = []

    for line in lines:
        line = line.strip()
        # Skip separator rows
        if re.match(r'^\|[-|:\s]+\|$', line):
            continue
        if not line.startswith('|') or not line.endswith('|'):
            continue
        cells = [c.strip() for c in line.split('|')[1:-1]]
        # Clean cells: strip <br>, bold markers
        cleaned = []
        for cell in cells:
            cell = cell.replace('<br>', ' ')
            cell = re.sub(r'\*\*([^*]+)\*\*', r'\1', cell)
            cell = cell.strip()
            if cell:
                cleaned.append(cell)
        if cleaned:
            spoken_rows.append('; '.join(cleaned))

    if not spoken_rows:
        return 'Table.'
    return 'Table. ' + '. '.join(spoken_rows) + '.'


def split_long_paragraph(text: str, max_words: int = 500) -> list[str]:
    """Split a long paragraph at sentence boundaries if it exceeds max_words."""
    words = text.split()
    if len(words) <= max_words:
        return [text]

    # Split on sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current = []
    current_count = 0

    for sentence in sentences:
        word_count = len(sentence.split())
        if current_count + word_count > max_words and current:
            chunks.append(' '.join(current))
            current = [sentence]
            current_count = word_count
        else:
            current.append(sentence)
            current_count += word_count

    if current:
        chunks.append(' '.join(current))

    return chunks


class EReaderTTS:
    """
    Paragraph-level TTS with word timing for e-reader synchronization.

    Generates MP3 audio and JSON timing data per paragraph, cached by
    content hash for fast re-reads.
    """

    def __init__(self, cache_dir: Optional[str] = None):
        # In the crow bundle, src/services/ereader_tts.py + bind-mount of
        # ~/.crow/data/capstone-tracker/ereader-cache/audio onto
        # /app/src/static/audio means the default below writes directly to
        # the persistent host volume.
        if cache_dir:
            self.cache_dir = Path(cache_dir)
        else:
            project_root = Path(__file__).parent.parent
            self.cache_dir = project_root / "static" / "audio" / "ereader"

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.default_voice = "en-US-BrianNeural"

    def _cache_key(self, text: str, voice: str, rate: str) -> str:
        """Generate cache key from content hash."""
        return hashlib.md5(f"{text}{voice}{rate}".encode()).hexdigest()

    def _para_dir(self, cache_key: str) -> Path:
        """Get cache directory for a content item."""
        d = self.cache_dir / cache_key
        d.mkdir(parents=True, exist_ok=True)
        return d

    def is_cached(self, cache_key: str, para_index: int) -> bool:
        """Check if a paragraph's audio + timing are cached."""
        d = self._para_dir(cache_key)
        mp3 = d / f"para_{para_index:04d}.mp3"
        timing = d / f"para_{para_index:04d}_timing.json"
        return mp3.exists() and mp3.stat().st_size > 0 and timing.exists()

    def get_cached_status(self, cache_key: str, total_paragraphs: int) -> list[bool]:
        """Return list of booleans indicating which paragraphs are cached."""
        return [self.is_cached(cache_key, i) for i in range(total_paragraphs)]

    async def generate_paragraph(
        self,
        text: str,
        cache_key: str,
        para_index: int,
        voice: Optional[str] = None,
        rate: str = "+0%",
    ) -> dict:
        """
        Generate TTS audio + word timing for a single paragraph.

        Returns dict with audio_url, timing data, and metadata.
        """
        _ensure_edge_tts()
        voice = voice or self.default_voice

        d = self._para_dir(cache_key)
        mp3_path = d / f"para_{para_index:04d}.mp3"
        timing_path = d / f"para_{para_index:04d}_timing.json"

        # Return cached
        if mp3_path.exists() and mp3_path.stat().st_size > 0 and timing_path.exists():
            timing_data = json.loads(timing_path.read_text())
            return {
                "success": True,
                "audio_url": f"/static/audio/ereader/{cache_key}/para_{para_index:04d}.mp3",
                "timing": timing_data,
                "cached": True,
                "para_index": para_index,
            }

        # Generate
        try:
            communicate = edge_tts.Communicate(
                text, voice, rate=rate, boundary="WordBoundary"
            )

            audio_bytes = bytearray()
            word_timings = []

            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_bytes.extend(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    # Edge TTS provides offset and duration in 100ns ticks
                    offset_ticks = chunk["offset"]
                    duration_ticks = chunk["duration"]
                    word_timings.append({
                        "text": chunk["text"],
                        "offset_ms": offset_ticks / 10000,  # 100ns -> ms
                        "duration_ms": duration_ticks / 10000,
                    })

            # Write audio file
            mp3_path.write_bytes(bytes(audio_bytes))

            # Write timing file
            timing_path.write_text(json.dumps(word_timings))

            return {
                "success": True,
                "audio_url": f"/static/audio/ereader/{cache_key}/para_{para_index:04d}.mp3",
                "timing": word_timings,
                "cached": False,
                "para_index": para_index,
            }

        except Exception as e:
            logger.exception(f"EReader TTS failed for para {para_index}: {e}")
            # Clean up partial files
            if mp3_path.exists():
                mp3_path.unlink()
            if timing_path.exists():
                timing_path.unlink()
            return {
                "success": False,
                "error": str(e),
                "para_index": para_index,
            }

    async def generate_range(
        self,
        paragraphs: list[str],
        cache_key: str,
        start: int,
        end: int,
        voice: Optional[str] = None,
        rate: str = "+0%",
    ) -> list[dict]:
        """Generate TTS for a range of paragraphs concurrently."""
        end = min(end, len(paragraphs))
        tasks = []
        for i in range(start, end):
            tasks.append(
                self.generate_paragraph(paragraphs[i], cache_key, i, voice, rate)
            )
        return await asyncio.gather(*tasks)

    def get_popular_voices(self, language: str = "en") -> list[dict]:
        """Curated voice list for the e-reader."""
        en_voices = [
            {"name": "en-US-BrianNeural", "display": "Brian (US)", "gender": "Male"},
            {"name": "en-US-GuyNeural", "display": "Guy (US)", "gender": "Male"},
            {"name": "en-US-JennyNeural", "display": "Jenny (US)", "gender": "Female"},
            {"name": "en-US-AriaNeural", "display": "Aria (US)", "gender": "Female"},
            {"name": "en-US-DavisNeural", "display": "Davis (US)", "gender": "Male"},
            {"name": "en-GB-RyanNeural", "display": "Ryan (UK)", "gender": "Male"},
            {"name": "en-GB-SoniaNeural", "display": "Sonia (UK)", "gender": "Female"},
        ]
        es_voices = [
            {"name": "es-MX-DaliaNeural", "display": "Dalia (MX)", "gender": "Female"},
            {"name": "es-MX-JorgeNeural", "display": "Jorge (MX)", "gender": "Male"},
            {"name": "es-ES-ElviraNeural", "display": "Elvira (ES)", "gender": "Female"},
            {"name": "es-ES-AlvaroNeural", "display": "Alvaro (ES)", "gender": "Male"},
            {"name": "es-AR-ElenaNeural", "display": "Elena (AR)", "gender": "Female"},
            {"name": "es-CO-SalomeNeural", "display": "Salome (CO)", "gender": "Female"},
        ]
        if language == "es":
            return es_voices + en_voices
        return en_voices + es_voices


# Singleton
ereader_tts = EReaderTTS()
