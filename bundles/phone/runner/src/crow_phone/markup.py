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
_UNCLOSED_TAG = re.compile(
    r"<\s*(?:tool_call|function|parameter|"
    + "|".join(KNOWN_TOOLS)
    + r")\b[^>]*(?!>)(?=[^<]*(?:<|$))",
    re.I,
)
_ANY_TAG = re.compile(
    r"<\s*/?\s*(?:tool_call|function|parameter|"
    + "|".join(KNOWN_TOOLS)
    + r")\b[^>]*>|<[^<>]*=[^<>]*>",
    re.S | re.I,
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
                name = obj.get("name", "").lower()
                if name in KNOWN_TOOLS:
                    args = {}
                    for k, v in obj.get("arguments", {}).items():
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

    # Remove complete tool_call blocks
    stripped = _BLOCK.sub(" ", stripped)

    # Remove function tags
    stripped = _FUNC.sub(" ", stripped)

    # Remove unclosed tag fragments (e.g., "<end_call" or "<parameter=x")
    if _UNCLOSED_TAG.search(stripped):
        had = True
    stripped = _UNCLOSED_TAG.sub(" ", stripped)

    # Check for any remaining tag-shaped content
    if _ANY_TAG.search(stripped):
        had = True
    stripped = _ANY_TAG.sub(" ", stripped)

    # Collapse multiple spaces
    clean = re.sub(r"\s+", " ", stripped).strip()

    # Handle stray < and > in normal speech
    # First check if there are any angle brackets left
    if "<" in clean or ">" in clean:
        # A tag-shaped pattern has characteristics like:
        # - <word with space or /
        # - <word= (attribute)
        # - / at end before >
        tag_pattern = re.compile(r"<\s*[a-z_][a-z_]*\s|<\s*[a-z_][a-z_]*=|/\s*>", re.I)
        # If they look tag-shaped, set had_markup; otherwise just replace
        if tag_pattern.search(clean):
            had = True
        # Replace all < and > with spaces
        clean = re.sub(r"[<>]", " ", clean)
        clean = re.sub(r"\s+", " ", clean).strip()

    return Sanitized(clean=clean, had_markup=had, calls=calls)
