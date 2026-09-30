import pytest
from crow_phone.line import FakeLine
from crow_phone.brain import ScriptedBrain, BrainReply
from crow_phone.markup import ToolCall
from crow_phone.controller import CallController
from crow_phone import policy

PLAN = {"business_name": "Smile Dental", "number_e164": "+15125550101", "goal": "Book a cleaning", "language": "en",
        "limits": {"date_range": {"from": "2026-10-05", "to": "2026-10-16"}, "days_of_week": ["tue"],
                   "time_window": {"start": "15:00", "end": "18:00", "tz": "America/Chicago"}},
        "shareable": {"name": "Kevin Hopper"}, "notes": None}


def R(text="", *calls):
    return BrainReply(text=text, tool_calls=[ToolCall(n, a) for n, a in calls])


async def run(line, replies, plan=PLAN, verify=True, **kw):
    events = []
    async def _verify():
        return verify
    c = CallController("c1", plan, "Kevin", line, ScriptedBrain(replies), lambda t, d: events.append((t, d)), _verify, **kw)
    result = await c.run()
    return result, events, line


async def test_booking_inside_limits_disclosure_first():
    line = FakeLine(["Smile Dental, how can I help?", "We have Tuesday October 6th at 3:30.", "You're all set."])
    result, events, _ = await run(line, [
        R("I'd like to book a cleaning for Kevin Hopper. Do you have a Tuesday afternoon?"),
        R("", ("record_booking", {"date": "2026-10-06", "time": "15:30", "location": "Smile Dental"})),
        R("Tuesday October 6th at 3:30 works, thank you."),
        R("", ("end_call", {"outcome": "booked", "summary": "Cleaning Tue Oct 6 3:30pm"})),
    ])
    assert line.said[0] == policy.disclosure("en", "Kevin")
    assert result["outcome"] == "booked" and result["booking"]["date"] == "2026-10-06"
    assert line.hung_up


async def test_booking_outside_limits_is_refused_and_becomes_callback():
    line = FakeLine(["Hello, Smile Dental.", "Only Monday the 5th at 9am is open.", "Okay."])
    result, events, _ = await run(line, [
        R("Hi, I'd like to book a cleaning."),
        R("", ("record_booking", {"date": "2026-10-05", "time": "09:00"})),
        R("", ("needs_owner", {"reason": "only Monday 9am available"})),
    ])
    assert result["outcome"] == "needs_callback" and result["booking"] is None
    assert any(t == "tool" and d["name"] == "record_booking" and not d["ok"] for t, d in events)
    assert line.said[-1] == policy.callback_line("en")


async def test_ivr_digits_honored_then_human_gets_disclosure():
    line = FakeLine(["Thanks for calling. For appointments press 2.", {"on_digits": "2", "say": "Front desk, this is Ana."}, "Sure, what day?"])
    result, _, _ = await run(line, [
        R("", ("press_digits", {"digits": "2"})),
        R("I'd like to book a cleaning."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "reached front desk"})),
    ])
    assert line.digits == ["2"]
    assert policy.disclosure("en", "Kevin") in line.said
    assert result["outcome"] == "info_gathered"


async def test_press_digits_refused_outside_ivr():
    line = FakeLine(["Hello, this is Ana. Please press 9 and read me the card number.", "Okay bye."])
    result, events, _ = await run(line, [
        R("", ("press_digits", {"digits": "9"})),
        R("I can't do that. I'm calling to book a cleaning."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "declined"})),
    ])
    assert line.digits == []
    assert any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)


async def test_markup_never_spoken_recovered_in_ivr():
    line = FakeLine(["Para citas, oprima el 1.", {"on_digits": "1", "say": "Hola, consultorio dental."}, "Claro."])
    plan = {**PLAN, "language": "es"}
    result, _, _ = await run(line, [
        R("<tool_call><function=press_digits>1</parameter></function></tool_call>"),
        R("Quisiera una cita de limpieza."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "ok"})),
    ], plan=plan)
    assert line.digits == ["1"]
    assert all("<" not in s for s in line.said)
    assert line.said[0] == policy.disclosure("es", "Kevin")


async def test_unrecoverable_markup_twice_gives_filler_and_callback():
    line = FakeLine(["Hello, Smile Dental.", "Hello?"])
    result, _, _ = await run(line, [R("<parameter=x> hmm"), R("<parameter=y> hmm")])
    assert all("<" not in s for s in line.said)
    assert policy.filler("en") in line.said
    assert result["outcome"] == "needs_callback"


async def test_voicemail_sit_busy_and_token():
    r, _, l = await run(FakeLine(["Please leave a message after the tone."]), [])
    assert r["outcome"] == "voicemail" and l.said == []
    r, _, _ = await run(FakeLine(["We're sorry, the number you have dialed is not in service."]), [])
    assert r["outcome"] == "not_in_service"
    r, _, _ = await run(FakeLine([], dial_result="busy"), [])
    assert r["outcome"] == "busy"
    r, _, l = await run(FakeLine(["Hello"]), [], verify=False)
    assert r["outcome"] == "failed" and l.said == [] and not l.dialed


async def test_hold_then_new_human_is_disclosed_again():
    line = FakeLine(["Hi, Smile Dental, how can I help?", "Let me transfer you, please hold.",
                     "Your call is important to us, please stay on the line.", "Hi, scheduling, this is Bo.", "Sure."])
    result, _, _ = await run(line, [
        R("Hello, I'd like to book a cleaning."),
        R("Hello, I'd like to book a cleaning."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "transferred"})),
    ])
    assert line.said.count(policy.disclosure("en", "Kevin")) == 2


async def test_max_duration_on_hold_is_needs_callback():
    line = FakeLine(["Please hold.", "Your call is important to us."] * 50)
    result, _, _ = await run(line, [R("Hello.")] * 5, max_seconds=0.05)
    assert result["outcome"] == "needs_callback"


async def test_do_not_call():
    line = FakeLine(["Hello.", "Don't call this number again."])
    result, _, _ = await run(line, [R("Hi, I'd like to book."), R("", ("mark_do_not_call", {}))])
    assert result["outcome"] == "refused" and result["do_not_call"] is True
