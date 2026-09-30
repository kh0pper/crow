from crow_phone import policy


def test_digits():
    assert policy.valid_digits("2") and policy.valid_digits("*#09")
    for bad in ["", "12a", "1,2", "1;2", "+1", "1" * 21]:
        assert not policy.valid_digits(bad)


LIMITS = {
    "date_range": {"from": "2026-10-05", "to": "2026-10-16"},
    "days_of_week": ["tue", "thu"],
    "time_window": {"start": "15:00", "end": "18:00", "tz": "America/Chicago"},
    "max_price": {"amount": 150},
}


def test_booking_within_limits():
    ok, _ = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": 120}, LIMITS
    )  # Tuesday
    assert ok
    for booking, why in [
        ({"date": "2026-10-05", "time": "15:30"}, "day"),  # Monday
        ({"date": "2026-10-20", "time": "15:30"}, "date"),  # after range
        ({"date": "2026-10-06", "time": "18:00"}, "time"),  # end is exclusive
        ({"date": "2026-10-06", "time": "15:30", "price": 151}, "price"),
        ({"date": "not-a-date", "time": "15:30"}, "date"),
    ]:
        ok, reason = policy.booking_within_limits(booking, LIMITS)
        assert not ok and why in reason, (booking, reason)


def test_disclosure_templates_exact():
    assert (
        policy.disclosure("en", "Kevin")
        == "Hi, I'm an automated assistant calling on behalf of Kevin. This call may be recorded."
    )
    assert (
        policy.disclosure("es", "Kevin")
        == "Hola, soy un asistente automatizado que llama de parte de Kevin. Esta llamada puede ser grabada."
    )
    assert policy.filler("es") and policy.callback_line("en")
