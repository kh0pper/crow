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
