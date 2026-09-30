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
        d = date.fromisoformat(str(booking.get("date", "")))
    except ValueError:
        return False, "date is not YYYY-MM-DD"
    t = str(booking.get("time", ""))
    if not _TIME.match(t):
        return False, "time is not HH:MM"
    dr = limits.get("date_range")
    if dr and not (dr["from"] <= d.isoformat() <= dr["to"]):
        return False, "date outside the allowed range"
    days = limits.get("days_of_week")
    if days and _DAYS[d.weekday()] not in days:
        return False, "day of week not allowed"
    tw = limits.get("time_window")
    if tw and not (tw["start"] <= t < tw["end"]):
        return False, "time outside the allowed window"
    mp = limits.get("max_price")
    if mp and booking.get("price") is not None:
        try:
            if float(booking["price"]) > float(mp["amount"]):
                return False, "price above the allowed maximum"
        except (TypeError, ValueError):
            return False, "price is not a number"
    return True, "ok"
