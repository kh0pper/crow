import math
import re
from datetime import date

OUTCOMES = [
    "booked",
    "info_gathered",
    "needs_callback",
    "no_answer",
    "voicemail",
    "busy",
    "not_in_service",
    "refused",
    "phone_busy",
    "phone_unreachable",
    "line_lost",
    "taken_over",
    "not_admissible",
    "stopped",
    "failed",
]
MODEL_OUTCOMES = {"booked", "info_gathered", "needs_callback", "refused"}
_DIGITS = re.compile(r"^[0-9*#]{1,20}$")
_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# Mirror of the gateway's plan.js number policy: the runner re-checks the number
# it is about to dial, so a bad plan can never reach the line.
_NANP = re.compile(r"\+1[2-9]\d{2}[2-9]\d{6}")
_DIAL_CODES = re.compile(r"[*#,;wWpP]")
_N11 = re.compile(r"[2-9]11")

_DISCLOSURE = {
    "en": "Hi, I'm an automated assistant calling on behalf of {owner}. This call may be recorded.",
    "es": "Hola, soy un asistente automatizado que llama de parte de {owner}. Esta llamada puede ser grabada.",
}
_FILLER = {"en": "One moment, please.", "es": "Un momento, por favor."}
_CALLBACK = {
    "en": "Thank you. I'll check and call you back.",
    "es": "Gracias. Voy a consultarlo y le vuelvo a llamar.",
}


def valid_digits(s) -> bool:
    return isinstance(s, str) and bool(_DIGITS.match(s))


def normalize_number(raw) -> str | None:
    """US/Canada number -> E.164, or None. Dial codes (* # , ; w p) are never normalized away."""
    s = str(raw if raw is not None else "").strip()
    if _DIAL_CODES.search(s):
        return None
    d = re.sub(r"[\s().\-]", "", s)
    if d.startswith("+"):
        d = d[1:]
    if not d.isdigit():
        return None
    if len(d) == 10:
        d = "1" + d
    e164 = "+" + d
    return e164 if _NANP.fullmatch(e164) else None


def check_number(e164) -> tuple[bool, str]:
    """Is this exact string a dialable NANP E.164 number under the policy?"""
    if not isinstance(e164, str):
        return False, "not a number"
    if _DIAL_CODES.search(e164):
        return False, "dial codes"
    if not _NANP.fullmatch(e164):
        return False, "not NANP E.164"
    area, exch = e164[2:5], e164[5:8]
    if _N11.fullmatch(area) or _N11.fullmatch(exch):
        return False, "n11"
    if area == "900" or exch in ("900", "976"):
        return False, "premium"
    return True, "ok"


def disclosure(lang: str, owner_name: str) -> str:
    return _DISCLOSURE["es" if lang == "es" else "en"].format(
        owner=owner_name or "my client"
    )


def filler(lang: str) -> str:
    return _FILLER["es" if lang == "es" else "en"]


def callback_line(lang: str) -> str:
    return _CALLBACK["es" if lang == "es" else "en"]


# Spec 2026-10-02 (call wrap-up §1): a model line that closes the call.
# The goodbye must END the line: only the last sentence counts (trailing
# sentences that are nothing but thanks are skipped first), and the closing
# phrase must be the end of that sentence. "Thanks for your help. I'd also
# like to book..." and "Bye the way, I need the price" are NOT goodbyes. Bare
# "thank you" never counts ("Tuesday at 3:30 works, thank you." agrees to a
# slot; "Thanks." answers "let me check"), nor do bare "that's all" / "era
# todo" forms, nor agreement forms ("that's (exactly) what I needed" agrees to
# what was just offered). Any question mark disqualifies the line, and so does
# an agreement to wait or hold in the goodbye sentence or the one before it.
_CLOSING_TAIL = re.compile(
    r"(?:^|[\s,;:\u2014\u2013-])(?:good\s?-?bye|bye(?:[\s-]+(?:now|bye))?"
    r"|have\s+a\s+(?:great|good|nice|wonderful|lovely)\s+(?:day|one|afternoon|evening|weekend|night)"
    r"|that'?s\s+all\s+i\s+(?:needed|need|wanted|was\s+looking\s+for)"
    r"|thanks?(?:\s+you)?(?:\s+(?:so|very)\s+much)?\s+for\s+(?:your|all\s+your)\s+(?:help|time)"
    r"|adi[oó]s|hasta\s+luego|que\s+tenga\s+(?:un\s+)?(?:buen|lindo|excelente)\s+(?:d[ií]a|fin\s+de\s+semana)"
    r"|que\s+tenga\s+(?:una\s+)?buena\s+(?:tarde|noche)"
    r"|eso\s+es\s+todo|es\s+todo\s+lo\s+que\s+necesitaba|(?:muchas\s+)?gracias\s+por\s+su\s+(?:ayuda|tiempo))"
    r"(?:[\s,]+(?:thanks|thank\s+you|thanks\s+so\s+much|thank\s+you\s+so\s+much|gracias|muchas\s+gracias|bye|adi[oó]s))?\s*$",
    re.I,
)
# Backlog P1 (2026-10-02): agreeing to WAIT or HOLD is never a goodbye, even
# when the line ends with one ("Okay, I'll wait. Bye", "Sure, I can hold.
# Thanks for your time.", "Esperaré. Adiós."). The business is about to come
# back; hanging up would drop the call mid-task. Checked per sentence, on the
# goodbye sentence and the one just before it (review I1), so an earlier,
# unrelated "wait" never vetoes a real goodbye. Deferral and future-contact
# forms are NOT holds: "I'll hold off", "I can wait until Tuesday", "I will
# wait for your call", "No rush on the quote", "Espero su llamada".
_CONTACT_NOUN = r"(?:call|email|e-mail|text|confirmation|reply|quote|message|callback|answer|estimate|invoice)"
_WAITING = re.compile(
    r"\b(?:i'?ll|i\s+will|i\s+can|i\s+could|i'?m\s+happy\s+to|happy\s+to|i\s+don'?t\s+mind\s+to|i\s+don'?t\s+mind)\s+"
    r"(?:just\s+|gladly\s+)?(?:wait|hold|stay\s+on(?:\s+the\s+line)?|be\s+on\s+hold)\b"
    r"(?!\s+(?:off|until|till|for\s+(?:your|the|their|his|her|an?)\s+(?:\w+\s+)?" + _CONTACT_NOUN + r"))"
    r"|\bi'?ll\s+be\s+(?:right\s+)?here\s*$|\btake\s+your\s+time\b|^(?:(?:sure|okay|ok|of\s+course|that'?s\s+fine)[\s,]+)*no\s+(?:rush|hurry)(?:\s+at\s+all)?\s*$"
    r"|\b(?:puedo|voy\s+a|con\s+gusto)\s+(?:esperar|aguardar)\b(?!\s+(?:hasta|a\s+que|su|tu)\b)|\b(?:le|lo|la)\s+espero\b(?!\s+(?:el|la|ma[nñ]ana|hasta)\b)"
    r"|\bespero\s+(?:en\s+la\s+l[ií]nea|aqu[ií])\b|\baqu[ií]\s+(?:espero|aguardo)\b|\bno\s+hay\s+(?:prisa|apuro)\s*$"
    r"|\bt[oó]mese\s+su\s+tiempo\b|\bsigo\s+en\s+la\s+l[ií]nea\b"
    r"|\b(?:esperar[eé]|aguardar[eé]|aguardo)\b(?!\s+(?:su|tu|sus|tus|que|hasta|a\s+que)\b)"
    r"|^(?:(?:s[ií]|claro|ok(?:ay)?|bueno|vale|perfecto|est[aá]\s+bien|de\s+acuerdo|no\s+se\s+preocupe)[\s,]+)*(?:yo\s+)?espero\b(?!\s+(?:que|su|tu|sus|tus|verl[oa]s?|poder|hablar|saber)\b)",
    re.I,
)
_THANKS_SENTENCE = re.compile(r"^(?:(?:ok(?:ay)?|great|perfect|perfecto)[\s,]+)?(?:thanks?(?:\s+you)?(?:\s+(?:so|very)\s+much)?|thank\s+you|(?:muchas\s+)?gracias)$", re.I)
_SENTENCE_END = re.compile(r"[.!\u2026]+")


def is_closing(text) -> bool:
    """Does this assistant line END with a goodbye (en/es)? Used to end a call the model forgot to end."""
    s = str(text or "").replace("\u2019", "'").strip()
    if not s or "?" in s or "\u00bf" in s:
        return False
    parts = [p.strip(" \t\n,;:") for p in _SENTENCE_END.split(s)]
    parts = [p for p in parts if p]
    while parts and _THANKS_SENTENCE.match(parts[-1]):
        parts.pop()
    if not parts or not _CLOSING_TAIL.search(parts[-1]):
        return False
    # The goodbye sentence and the sentence before it (thanks-only sentences skipped).
    before = [p for p in parts[:-1] if not _THANKS_SENTENCE.match(p)][-1:]
    return not any(_WAITING.search(p) for p in [parts[-1]] + before)


_GREETING = {"en": "Hello?", "es": "¿Hola?"}


def greeting(lang: str) -> str:
    """Spoken after the disclosure when the business is silent after answering (spec 2026-10-01 §4.5)."""
    return _GREETING["es" if lang == "es" else "en"]


def booking_within_limits(booking: dict, limits: dict) -> tuple[bool, str]:
    try:
        # Handle None inputs
        if booking is None or limits is None:
            return False, "invalid limits/booking"

        # Parse and validate date
        try:
            d = date.fromisoformat(str(booking.get("date", "")))
        except ValueError:
            return False, "date is not YYYY-MM-DD"

        # Validate time
        t = str(booking.get("time", ""))
        if not _TIME.match(t):
            return False, "time is not HH:MM"

        # Validate date range
        dr = limits.get("date_range")
        if dr:
            try:
                if not (dr["from"] <= d.isoformat() <= dr["to"]):
                    return False, "date outside the allowed range"
            except (KeyError, TypeError):
                return False, "invalid limits/booking"

        # Validate days of week
        days = limits.get("days_of_week")
        if days:
            if not isinstance(days, list):
                return False, "invalid limits/booking"
            if _DAYS[d.weekday()] not in days:
                return False, "day of week not allowed"

        # Validate time window
        tw = limits.get("time_window")
        if tw:
            try:
                if not (tw["start"] <= t < tw["end"]):
                    return False, "time outside the allowed window"
            except (KeyError, TypeError):
                return False, "invalid limits/booking"

        # Validate max price (fail closed)
        mp = limits.get("max_price")
        if mp:
            try:
                # max_price.amount must be int/float (not bool, not string)
                amount_val = mp["amount"]
                if isinstance(amount_val, bool):
                    return False, "invalid price limit"
                if not isinstance(amount_val, (int, float)):
                    return False, "invalid price limit"
                max_amount = float(amount_val)
                if not math.isfinite(max_amount):
                    return False, "invalid price limit"

                # When max_price is set, booking must have a finite price (not bool, not None, not string)
                price_val = booking.get("price")
                if price_val is None:
                    return False, "price required by the price limit"
                # Reject bool (bool is technically numeric in Python)
                if isinstance(price_val, bool):
                    return False, "price required by the price limit"
                # Reject string prices
                if isinstance(price_val, str):
                    return False, "price required by the price limit"
                # Must be int or float
                if not isinstance(price_val, (int, float)):
                    return False, "price required by the price limit"
                price = float(price_val)
                if not math.isfinite(price):
                    return False, "price required by the price limit"
                if price > max_amount:
                    return False, "price above the allowed maximum"
            except (KeyError, TypeError, AttributeError):
                return False, "invalid limits/booking"

        return True, "ok"
    except (KeyError, TypeError, AttributeError, ValueError):
        return False, "invalid limits/booking"
