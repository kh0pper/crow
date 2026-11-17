"""Pure helpers for building Google Forms API question bodies (no Google client
imports, so unit tests run without the API libraries)."""

# Map a friendly question type -> how to build its question body.
_CHOICE_TYPES = {"CHECKBOX", "RADIO", "DROP_DOWN"}

def _build_question(type: str, options: list | None, required: bool) -> dict:
    """Build a Forms API `question` body from the friendly type used by
    forms_add_question / forms_create. Raises ValueError on a bad type or
    a choice type without options."""
    t = (type or "").upper()
    q: dict = {"required": bool(required)}
    if t in _CHOICE_TYPES:
        if not options:
            raise ValueError(f"type {t} requires a non-empty `options` list.")
        q["choiceQuestion"] = {"type": t, "options": [{"value": str(o)} for o in options]}
    elif t in ("SHORT_TEXT", "TEXT"):
        q["textQuestion"] = {"paragraph": False}
    elif t in ("PARAGRAPH", "PARAGRAPH_TEXT"):
        q["textQuestion"] = {"paragraph": True}
    else:
        raise ValueError(f"unsupported type {t!r}; use CHECKBOX|RADIO|DROP_DOWN|SHORT_TEXT|PARAGRAPH.")
    return q

