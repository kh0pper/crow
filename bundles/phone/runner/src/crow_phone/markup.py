"""Spoken-stream markup filter (spec §3.7.5). Nothing tag-shaped may reach the line.

Recovers the tool calls a model wrote as TEXT (measured failure modes of the
Qwen family, pi-lab 2026-09-30) so the call can continue without speaking markup.
"""

import json
import re
from dataclasses import dataclass, field

KNOWN_TOOLS = {
    "press_digits": "digits",
    "record_booking": None,
    "needs_owner": "reason",
    "end_call": None,
    "mark_do_not_call": None,
}


@dataclass
class ToolCall:
    name: str
    args: dict = field(default_factory=dict)


@dataclass
class Sanitized:
    clean: str
    had_markup: bool
    calls: list


# All regexes compiled with re.I for case-insensitive matching
_BLOCK = re.compile(r"<tool_call>(.*?)(?:</tool_call>|$)", re.S | re.I)
_FUNC = re.compile(r"<function=([a-z_]+)>(.*?)(?:</function>|$)", re.S | re.I)
_PARAM = re.compile(r"<parameter=([a-z_]+)>(.*?)</parameter>", re.S | re.I)
_ATTR_TAG = re.compile(r"<\s*(" + "|".join(KNOWN_TOOLS) + r")\b([^>]*)>", re.S | re.I)
# Attributes with double quotes, single quotes, or unquoted
_ATTR = re.compile(r'([a-z_]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]*))', re.I)
# Complete tags with closing > (including self-closing />)
_COMPLETE_TAG = re.compile(
    r"<\s*/?\s*(?:tool_call|function|parameter|"
    + "|".join(KNOWN_TOOLS)
    + r")\b[^>]*(?:>|/>)|<[^<>]*=[^<>]*>",
    re.S | re.I,
)
# Unclosed tag fragments - anchored to not cross > or start of another tag
_UNCLOSED_FRAGMENT = re.compile(
    r"<\s*(?:tool_call|function|parameter|"
    + "|".join(KNOWN_TOOLS)
    + r")\b[^<>]*(?=[<\s]|$)|<[^<>]*=[^<>]*(?=[<\s]|$)",
    re.I,
)


def _strip_angle_brackets(s: str) -> str:
    """Remove < and > from a string and strip whitespace."""
    return re.sub(r"[<>]", "", s).strip()


def _from_function(name: str, body: str):
    name_lower = name.lower()
    if name_lower not in KNOWN_TOOLS:
        return None

    # Extract parameters with proper handling
    params = {}
    for k, v in _PARAM.findall(body):
        params[k.lower()] = _strip_angle_brackets(v)

    # If no parameters found, try to extract bare content
    if not params:
        bare = re.sub(r"<[^>]*>", "", body).strip()
        bare = _strip_angle_brackets(bare)
        single = KNOWN_TOOLS[name_lower]
        if bare and single:
            params[single] = bare

    return ToolCall(name_lower, params)


def sanitize(text: str) -> Sanitized:
    calls = []
    had = False

    # First pass: extract tool_call blocks (including unclosed ones)
    block_ranges = []
    for match in _BLOCK.finditer(text):
        had = True
        block_ranges.append((match.start(), match.end()))
        body = match.group(1).strip()

        # Try JSON parsing first
        if body.startswith("{"):
            try:
                obj = json.loads(body)
                if not isinstance(obj, dict):
                    raise json.JSONDecodeError("not an object", body, 0)
                name = str(obj.get("name", "")).lower()
                if name in KNOWN_TOOLS:
                    args = {}
                    raw_args = obj.get("arguments")
                    for k, v in (raw_args if isinstance(raw_args, dict) else {}).items():
                        if isinstance(v, str):
                            args[k] = _strip_angle_brackets(v)
                        else:
                            args[k] = v
                    calls.append(ToolCall(name, args))
                    continue
            except json.JSONDecodeError:
                pass

        # Try function tag parsing
        for name, fbody in _FUNC.findall(body):
            c = _from_function(name, fbody)
            if c:
                calls.append(c)

    # If no calls found in blocks, try loose function tags
    if not calls:
        for name, fbody in _FUNC.findall(text):
            had = True
            c = _from_function(name, fbody)
            if c:
                calls.append(c)

    # Extract attribute-style tags
    for name, attrs in _ATTR_TAG.findall(text):
        had = True
        name_lower = name.lower()
        args = {}
        for match in _ATTR.finditer(attrs):
            key = match.group(1).lower()
            # One of the three groups will have the value
            value = match.group(2) or match.group(3) or match.group(4)
            if value:
                args[key] = _strip_angle_brackets(value)
        calls.append(ToolCall(name_lower, args))

    # Now process text for removal of markup
    stripped = text

    # FIRST: Remove complete tool_call blocks (including unclosed ones)
    if _BLOCK.search(stripped):
        had = True
    stripped = _BLOCK.sub(" ", stripped)

    # SECOND: Remove function and parameter tags with their content
    if _FUNC.search(stripped):
        had = True
    stripped = _FUNC.sub(" ", stripped)

    # THIRD: Remove complete standalone tags (_COMPLETE_TAG) including self-closing
    if _COMPLETE_TAG.search(stripped):
        had = True
    stripped = _COMPLETE_TAG.sub(" ", stripped)

    # FOURTH: Remove unclosed tag fragments (e.g., "<end_call" or "<parameter=x")
    if _UNCLOSED_FRAGMENT.search(stripped):
        had = True
    stripped = _UNCLOSED_FRAGMENT.sub(" ", stripped)

    # Collapse multiple spaces
    clean = re.sub(r"\s+", " ", stripped).strip()

    # FIFTH: Handle stray < and > in normal speech (not tag-shaped)
    # Replace with spaces without setting had_markup for simple angle brackets
    if "<" in clean or ">" in clean:
        # A tag-shaped pattern has characteristics like:
        # - <word with space
        # - <word= (attribute)
        # - / before >
        tag_pattern = re.compile(r"<\s*[a-z_][a-z_]*\s|<\s*[a-z_][a-z_]*=|/\s*>", re.I)
        # If they look tag-shaped, set had_markup
        if tag_pattern.search(clean):
            had = True
        # Replace all < and > with spaces
        clean = re.sub(r"[<>]", " ", clean)
        clean = re.sub(r"\s+", " ", clean).strip()

    return Sanitized(clean=clean, had_markup=had, calls=calls)
