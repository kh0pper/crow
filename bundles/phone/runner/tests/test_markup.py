from crow_phone.markup import sanitize


def test_plain_text_passes():
    r = sanitize("Tuesday at 3:30 works for us.")
    assert (
        r.clean == "Tuesday at 3:30 works for us."
        and not r.had_markup
        and r.calls == []
    )


def test_qwen_malformed_press_digits_is_recovered():
    # Measured failure (pi-lab 2026-09-30): parameter tag missing.
    r = sanitize(
        "<tool_call><function=press_digits>1</parameter></function></tool_call>"
    )
    assert r.had_markup and r.clean == ""
    assert [(c.name, c.args) for c in r.calls] == [("press_digits", {"digits": "1"})]


def test_wellformed_function_parameters():
    r = sanitize(
        "<tool_call><function=record_booking><parameter=date>2026-10-06</parameter><parameter=time>15:30</parameter></function></tool_call>"
    )
    assert r.calls[0].name == "record_booking" and r.calls[0].args == {
        "date": "2026-10-06",
        "time": "15:30",
    }


def test_attribute_style_tag_is_recovered_and_never_spoken():
    r = sanitize('Sure. <end_call outcome="info_gathered" summary="asked hours">')
    assert r.had_markup and "<" not in r.clean and "end_call" not in r.clean
    assert (
        r.calls[0].name == "end_call" and r.calls[0].args["outcome"] == "info_gathered"
    )


def test_json_tool_call_block():
    r = sanitize(
        '<tool_call>{"name": "needs_owner", "arguments": {"reason": "price"}}</tool_call>'
    )
    assert r.calls[0].name == "needs_owner" and r.calls[0].args == {"reason": "price"}


def test_unknown_tag_shaped_fragments_are_stripped():
    r = sanitize("Okay <parameter=x> great")
    assert r.had_markup and "<" not in r.clean and r.calls == []


def test_uppercase_tags_recovered():
    """Uppercase tool tags must be recovered and normalized to lowercase."""
    r = sanitize(
        "<TOOL_CALL><FUNCTION=PRESS_DIGITS>5</PARAMETER></FUNCTION></TOOL_CALL>"
    )
    assert r.had_markup
    assert len(r.calls) == 1 and r.calls[0].name == "press_digits"


def test_unclosed_tag_fragment_stripped():
    """Unclosed tag fragments like <end_call must be stripped."""
    r = sanitize("Sure <end_call outcome=booked>")
    assert r.had_markup and "<" not in r.clean and "end_call" not in r.clean


def test_unclosed_parameter_tag_stripped():
    """Unclosed parameter tag like <parameter=x must be stripped."""
    r = sanitize("Great <parameter=x the value")
    assert r.had_markup and "<" not in r.clean


def test_unclosed_json_block_parsed():
    """<tool_call>{json without closing tag parses through end of text."""
    r = sanitize(
        'Say yes. <tool_call>{"name": "press_digits", "arguments": {"digits": "1"}}'
    )
    assert r.had_markup and r.clean == "Say yes."
    assert len(r.calls) == 1 and r.calls[0].name == "press_digits"


def test_single_quoted_attributes_recovered():
    """Single-quoted attribute values must be recovered."""
    r = sanitize("<end_call outcome='info_gathered' summary='asked hours'>")
    assert r.had_markup
    assert (
        r.calls[0].name == "end_call" and r.calls[0].args["outcome"] == "info_gathered"
    )


def test_unquoted_attributes_recovered():
    """Unquoted attribute values must be recovered."""
    r = sanitize("<end_call outcome=booked summary=success>")
    assert r.had_markup
    assert r.calls[0].name == "end_call" and r.calls[0].args["outcome"] == "booked"


def test_nested_brackets_stripped_from_values():
    """Nested brackets in arg values must be stripped."""
    r = sanitize(
        "<tool_call><function=press_digits><<function=press_digits>1>></function></tool_call>"
    )
    assert r.had_markup and r.clean == ""
    assert r.calls[0].name == "press_digits" and r.calls[0].args["digits"] == "1"


def test_stray_angle_brackets_in_speech_replaced_no_markup_flag():
    """Stray < > in normal speech (not tag-shaped) replaced by space, no had_markup set."""
    r = sanitize("if x<5 then y>3")
    assert not r.had_markup and "<" not in r.clean and ">" not in r.clean
    assert r.calls == []
