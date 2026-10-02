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


# ---- spec 2026-10-02: call wrap-up ----

def test_stopped_is_an_outcome_but_not_a_model_outcome():
    assert "stopped" in policy.OUTCOMES and "stopped" not in policy.MODEL_OUTCOMES


def test_is_closing_en_es():
    yes = [
        "Thank you, goodbye.",
        "Muchas gracias, hasta luego.",
        "Great, Saturday 9 to 1 is what I needed. Thank you, goodbye.",
        "That's all I needed, thank you.",
        "Thank you for your help, have a great day.",
        "Thanks so much for your time. Goodbye!",
        "Perfect, that’s everything. Bye.",
        "Muchas gracias, adiós.",
        "Perfecto, eso es todo. Gracias.",
        "Gracias por su ayuda, que tenga buen día.",
        # review I1: deferral / future-contact forms are not holds
        "I will wait for your call. Bye.",
        "Okay, I will wait for your call. Bye.",
        "Thanks, I will wait for your email. Goodbye.",
        "I'll hold off for now. Have a great day.",
        "I'll hold off on booking for now. Thank you, goodbye.",
        "I can wait until Tuesday\u2026 goodbye.",
        "Okay, I can wait until Tuesday for the part. Thanks for your help, goodbye.",
        "No rush on the quote\u2026 Goodbye.",
        "No rush on the quote, thanks for your help. Goodbye.",
        "Great, I'll be here waiting for the confirmation text. Have a great day.",
        "I'll hold. Okay, they found it, that's all I needed. Thank you, goodbye.",  # the hold is two sentences back
        "Espero su llamada. Adiós.",
        "Esperaré su llamada. Hasta luego.",
        "Espero que tenga buen día. Adiós.",
        # re-review N1: until/till/hasta + a TIME is still a deferral
        "I'll wait until tomorrow then. Goodbye.",
        "I can hold off till next week. Have a great day.",
        "Esperaré hasta el martes. Adiós.",
        "Puedo esperar hasta mañana. Hasta luego.",
    ]
    no = [
        # review I-2: a goodbye-ish phrase that does not END the line is not a goodbye
        "Thanks for your help. I'd also like to book a cleaning for Tuesday.",
        "Thanks for the info. I also need to know if you take Aetna.",
        "That's all good. I'd also like to ask about pricing.",
        "Great, that's all set. Next, I need to confirm the address.",
        "Okay, that is all clear. One more thing: I need the price.",
        "Perfect, that's all I needed for Saturday. Please also tell me Sunday hours.",
        "Bye the way, I need the price too.",
        "Gracias por su ayuda. También necesito saber el precio.",
        "Eso es todo lo que tengo anotado. Ahora, el precio, por favor.",
        "Pensé que era todo, pero también necesito el precio.",
        "Hasta luego no puedo, prefiero el martes a las tres.",
        "No hay prisa, que tenga buen día mientras revisa. Espero en la línea.",
        "Great, and do you take walk-ins",                  # a question without its '?'
        "Thanks, that's what I needed — Saturday hours 9 to 1.",  # the facts come after the phrase
        "That's all.",                                      # bare forms dropped
        "Era todo.",
        "Tuesday October 6th at 3:30 works, thank you.",   # agreeing to a slot
        "Thanks.",                                          # answering "let me check"
        "Gracias.",
        "Thanks. What time do you close?",
        "Is that all I need to bring?",
        "¿Eso es todo lo que necesito llevar",
        "Hello, I'd like to book a cleaning.",
        "",
        None,
        # backlog P1: agreeing to wait/hold, or agreeing to an offer, is not a goodbye
        "Okay, I'll wait. Bye",
        "Sure, I can hold. Thanks for your time.",
        "Tuesday at 3:30, that's exactly what I needed.",
        "That's what I needed. Thank you.",
        "That's just what I was looking for, thanks.",
        "No problem, I'll hold. Have a great day.",
        "Sure, take your time. Thank you, goodbye.",
        "I'm happy to wait, thanks for your help.",
        "Claro, puedo esperar. Gracias por su tiempo.",
        "Está bien, lo espero. Adiós.",
        "No hay apuro, sigo en la línea. Hasta luego.",
        # review I2: bare Spanish hold agreements
        "Esperaré. Adiós.",
        "Ok, espero. Gracias, adiós.",
        "Sí, espero. Hasta luego.",
        "Aquí espero. Adiós.",
        "Espero, no se preocupe. Hasta luego.",
        "Claro, aguardo. Gracias por su tiempo.",
        "Sure, no rush. Bye.",
        "Okay, I'll wait. Thanks. Bye.",
        "I'll be right here. Thank you, goodbye.",
        # re-review N1: until/till/hasta + a clause is a hold, not a deferral
        "Okay, I'll wait until you check. Bye.",
        "Sure, I can hold till you find it. Thanks for your time.",
        "Esperaré hasta que regrese. Adiós.",
        "Puedo esperar a que lo revise. Hasta luego.",
        # re-review N2
        "Sure, I'll wait for your answer. Bye.",
        "Gracias, espero. Adiós.",
        "I'll hold. Sure. Bye.",
    ]
    for t in yes:
        assert policy.is_closing(t), t
    for t in no:
        assert not policy.is_closing(t), t


def test_greeting_literals_are_pinned():
    # backlog P14: the speak-first greeting is a fixed literal, never model text.
    assert policy.greeting("en") == "Hello?"
    assert policy.greeting("es") == "\u00bfHola?"
    assert policy.greeting("fr") == "Hello?"  # unknown languages fall back to English
