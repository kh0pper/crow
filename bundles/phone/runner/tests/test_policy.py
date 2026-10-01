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


def test_price_fail_closed_when_limits_has_max_price():
    """Price must be required and finite when max_price is set."""
    limits_with_price = {"max_price": {"amount": 150}}
    # Missing price when max_price is set
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30"}, limits_with_price
    )
    assert not ok and "price" in reason.lower(), (ok, reason)
    # Price is None when max_price is set
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": None},
        limits_with_price,
    )
    assert not ok and "price" in reason.lower(), (ok, reason)
    # Price is bool when max_price is set (must fail even though bool is technically numeric)
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": True}, limits_with_price
    )
    assert not ok and "price" in reason.lower(), (ok, reason)
    # Invalid max_price.amount
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": 100},
        {"max_price": {"amount": "invalid"}},
    )
    assert not ok and "limit" in reason.lower(), (ok, reason)


def test_price_optional_when_no_limit():
    """Price may be absent when max_price is not set."""
    limits_no_price = {"date_range": {"from": "2026-10-05", "to": "2026-10-16"}}
    ok, _ = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30"}, limits_no_price
    )
    assert ok


def test_booking_limits_never_raises():
    """Must handle all malformed inputs without raising."""
    test_cases = [
        (None, {"max_price": {"amount": 150}}),  # booking is None
        ({"date": "2026-10-06", "time": "15:30"}, None),  # limits is None
        (
            {"date": "2026-10-06", "time": "15:30"},
            {"days_of_week": "tue"},
        ),  # days_of_week is string not list
        (
            {"date": "2026-10-06", "time": "15:30"},
            {"time_window": {"start": "15:00"}},
        ),  # missing end
        (
            {"date": "2026-10-06", "time": "15:30"},
            {"date_range": {"from": "2026-10-05"}},
        ),  # missing to
    ]
    for booking, limits in test_cases:
        ok, reason = policy.booking_within_limits(booking, limits)
        assert not ok, (
            f"Expected False for booking={booking}, limits={limits}, got {ok}"
        )


def test_price_must_be_int_or_float_not_string():
    """Price must be int/float, not string."""
    limits_with_price = {"max_price": {"amount": 150}}
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": "100"}, limits_with_price
    )
    assert not ok and "price" in reason.lower(), (ok, reason)


def test_max_price_amount_must_be_int_or_float():
    """max_price.amount must be int/float, not bool."""
    ok, reason = policy.booking_within_limits(
        {"date": "2026-10-06", "time": "15:30", "price": 100},
        {"max_price": {"amount": True}},
    )
    assert not ok and "limit" in reason.lower(), (ok, reason)


def test_check_number_blocks_bad_numbers():
    assert policy.check_number("+15125550101") == (True, "ok")
    for bad in ["+19115550101", "+15129110101", "+19005550101", "+15129000101", "+15129760101",
                "+15125550101#", "*67+15125550101", "+15125550101,1", "+15125550101;1", "+15125550101w1", "+15125550101p1",
                "+1512555010", "+11125550101", "+15121550101", "5125550101", "+445125550101", None, 15125550101]:
        ok, _ = policy.check_number(bad)
        assert not ok, bad


def test_normalize_number():
    assert policy.normalize_number("(512) 555-0101") == "+15125550101"
    assert policy.normalize_number("+1 512.555.0101") == "+15125550101"
    for bad in ["512-555-0101#", "*67 512 555 0101", "512555", "abc", None]:
        assert policy.normalize_number(bad) is None, bad
