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
