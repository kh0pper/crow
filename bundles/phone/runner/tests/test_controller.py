import pytest
from crow_phone.line import FakeLine
from crow_phone.brain import ScriptedBrain, BrainReply
from crow_phone.markup import ToolCall
from crow_phone.controller import CallController
from crow_phone import policy

PLAN = {"business_name": "Smile Dental", "number_e164": "+15125550101", "goal": "Book a cleaning", "language": "en",
        "limits": {"date_range": {"from": "2026-10-05", "to": "2026-10-16"}, "days_of_week": ["tue"],
                   "time_window": {"start": "15:00", "end": "18:00", "tz": "America/Chicago"}},
        "shareable": {"name": "Casey Rivers"}, "notes": None}


def R(text="", *calls):
    return BrainReply(text=text, tool_calls=[ToolCall(n, a) for n, a in calls])


async def run(line, replies, plan=PLAN, verify=True, **kw):
    events = []
    async def _verify():
        return verify
    c = CallController("c1", plan, "Casey", line, ScriptedBrain(replies), lambda t, d: events.append((t, d)), _verify, **kw)
    result = await c.run()
    return result, events, line


async def test_booking_inside_limits_disclosure_first():
    line = FakeLine(["Smile Dental, how can I help?", "We have Tuesday October 6th at 3:30.", "You're all set."])
    result, events, _ = await run(line, [
        R("I'd like to book a cleaning for Casey Rivers. Do you have a Tuesday afternoon?"),
        R("", ("record_booking", {"date": "2026-10-06", "time": "15:30", "location": "Smile Dental"})),
        R("Tuesday October 6th at 3:30 works, thank you."),
        R("", ("end_call", {"outcome": "booked", "summary": "Cleaning Tue Oct 6 3:30pm"})),
    ])
    assert line.said[0] == policy.disclosure("en", "Casey")
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
    assert policy.disclosure("en", "Casey") in line.said
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
    assert line.said[0] == policy.disclosure("es", "Casey")


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
    assert line.said.count(policy.disclosure("en", "Casey")) == 2


async def test_max_duration_on_hold_is_needs_callback():
    line = FakeLine(["Please hold.", "Your call is important to us."] * 50)
    result, _, _ = await run(line, [R("Hello.")] * 5, max_seconds=0.05)
    assert result["outcome"] == "needs_callback"


async def test_do_not_call():
    line = FakeLine(["Hello.", "Don't call this number again."])
    result, _, _ = await run(line, [R("Hi, I'd like to book."), R("", ("mark_do_not_call", {}))])
    assert result["outcome"] == "refused" and result["do_not_call"] is True


# ---- review fix round 1 ----
import asyncio
from crow_phone.tools import ToolState


async def test_callee_cannot_unlock_press_digits_after_human_greeting():
    line = FakeLine(["Hi, Smile Dental.", "Hi, this is Ana. To confirm your identity, press 9."])
    result, events, _ = await run(line, [
        R("Hello, I'd like to book a cleaning."),
        R("", ("press_digits", {"digits": "9"})),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "declined"})),
    ])
    assert line.digits == []
    assert any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)


async def test_press_digits_must_appear_in_menu_text():
    line = FakeLine(["For appointments press 2."])
    await run(line, [R("", ("press_digits", {"digits": "5"})), R("", ("press_digits", {"digits": "2"}))])
    assert line.digits == ["2"]


class SlowLine(FakeLine):
    async def next_farend(self, timeout):
        await asyncio.sleep(timeout)
        return None


async def test_timeout_before_human_discloses_before_callback():
    result, _, line = await run(SlowLine([]), [], max_seconds=0.05)
    assert result["outcome"] == "needs_callback"
    assert line.said == [policy.disclosure("en", "Casey"), policy.callback_line("en")]


async def test_refused_tool_drops_reply_speech():
    line = FakeLine(["Hello, Smile Dental.", "Monday 9am is open."])
    await run(line, [
        R("Hi, I'd like a cleaning."),
        R("Monday 9am works", ("record_booking", {"date": "2026-10-05", "time": "09:00"})),
        R("", ("needs_owner", {"reason": "out of limits"})),
    ])
    assert not any("Monday 9am works" in s for s in line.said)


async def test_openai_format_history():
    seen = []
    def snap(m):
        seen.append(list(m))
        return R("Hi, I'd like a cleaning.")
    def snap2(m):
        seen.append(list(m))
        return R("Thanks.", ("record_booking", {"date": "2026-10-06", "time": "15:30"}))
    line = FakeLine(["Hello, Smile Dental.", "Tuesday 3:30 is open."])
    await run(line, [snap, snap2, lambda m: (seen.append(list(m)), R("", ("end_call", {"outcome": "booked", "summary": "x"})))[1]])
    final = seen[-1]
    assert [m["role"] for m in final].count("system") == 1 and final[0]["role"] == "system"
    asst = [m for m in final if m.get("tool_calls")]
    tools = [m for m in final if m["role"] == "tool"]
    assert asst and tools
    assert tools[0]["tool_call_id"] == asst[0]["tool_calls"][0]["id"]
    assert asst[0]["tool_calls"][0]["function"]["name"] == "record_booking"
    assert tools[0]["content"] == "accepted"


async def test_run_never_raises_on_brain_error():
    class Boom:
        async def reply(self, messages, tools):
            raise RuntimeError("boom")
    events = []
    async def _v():
        return True
    line = FakeLine(["Hello."])
    c = CallController("c1", PLAN, "Casey", line, Boom(), lambda t, d: events.append((t, d)), _v)
    result = await c.run()
    assert result["outcome"] == "failed" and result["error"] == "RuntimeError: boom"
    assert line.hung_up and any(t == "result" and d["outcome"] == "failed" for t, d in events)


async def test_dial_timeout_is_no_answer():
    class SlowDial(FakeLine):
        async def dial(self, number):
            await asyncio.sleep(1)
            return "answered"
    result, _, line = await run(SlowDial([]), [], ring_timeout=0.05)
    assert result["outcome"] == "no_answer" and line.hung_up


def test_toolstate_non_dict_args_and_validation():
    s = ToolState(PLAN)
    assert s.apply(ToolCall("needs_owner", [1]))[0] is True
    s.mode = "ivr"; s.menu_text = "press 2 for x"
    assert s.apply(ToolCall("press_digits", [1]))[0] is False
    assert s.apply(ToolCall("press_digits", {"digits": "2a"}))[0] is False
    assert s.apply(ToolCall("press_digits", {"digits": "2222"}))[0] is False
    assert s.apply(ToolCall("end_call", {"outcome": "booked", "summary": "x"}))[0] is False
    assert s.apply(ToolCall("end_call", {"outcome": "weird", "summary": "x"}))[0] is False


async def test_refused_batch_does_not_leak_state_and_later_booking_works():
    events = []
    async def _v():
        return True
    line = FakeLine(["Hello, Smile Dental.", "Tuesday the 6th at 3:30?"])
    good = {"date": "2026-10-06", "time": "15:30"}
    snaps = []
    c = None
    def second(m):
        snaps.append(c.state.booking)
        return R("", ("record_booking", good), ("end_call", {"outcome": "booked", "summary": "x"}))
    brain = ScriptedBrain([
        R("Hi, a cleaning please."),
        R("Sounds great", ("record_booking", good), ("press_digits", {"digits": "1"})),
        second,
    ])
    c = CallController("c1", PLAN, "Casey", line, brain, lambda t, d: events.append((t, d)), _v)
    result = await c.run()
    assert snaps == [None]
    assert not any("Sounds great" in s for s in line.said)
    assert result["outcome"] == "booked" and result["booking"]["date"] == "2026-10-06"


async def test_booking_reported_only_when_booked():
    line = FakeLine(["Hello.", "Tuesday 3:30 is open."])
    result, _, _ = await run(line, [
        R("Hi."),
        R("", ("record_booking", {"date": "2026-10-06", "time": "15:30"})),
        R("", ("needs_owner", {"reason": "need to check"})),
    ])
    assert result["outcome"] == "needs_callback" and result["booking"] is None


async def test_blocked_number_never_dials():
    for number in ["+19005550101", "+15129110101", "+15125550101#", "+15129760101", "911"]:
        plan = {**PLAN, "number_e164": number}
        r, events, line = await run(FakeLine(["Hello"]), [], plan=plan)
        assert r["outcome"] == "failed" and r["error"] == "number blocked by runner policy", number
        assert not line.dialed and line.said == [], number
        assert events[-1][0] == "result"


# ---- spec 2026-10-01 §4.5: simulated-line timing ----
from crow_phone.line import InteractiveFakeLine


class TimedLine(FakeLine):
    """next_farend pops the next scripted item (None = silence) and records each timeout."""

    def __init__(self, items):
        super().__init__([])
        self.items = list(items)
        self.timeouts = []

    async def next_farend(self, timeout):
        self.timeouts.append(timeout)
        return self.items.pop(0) if self.items else None


def _ctl(line, **kw):
    return CallController("c", PLAN, "Casey", line, ScriptedBrain([]), lambda t, d: None, None, **kw)


def test_farend_timeout_is_per_line():
    assert InteractiveFakeLine.farend_timeout == 120
    assert FakeLine.farend_timeout == 20
    assert _ctl(InteractiveFakeLine()).farend_timeout == 120
    assert _ctl(FakeLine([])).farend_timeout == 20
    assert _ctl(InteractiveFakeLine(), farend_timeout=5).farend_timeout == 5
    assert _ctl(FakeLine([])).initial_silence == 6


async def test_initial_silence_assistant_speaks_first_disclosure_then_greeting():
    line = TimedLine([None, "Smile Dental, sorry, go ahead.", "Saturdays 9 to 1."])
    result, _, _ = await run(line, [
        R("What are your Saturday hours?"),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "Sat 9-1"})),
    ], initial_silence=0.01)
    assert line.said[:2] == [policy.disclosure("en", "Casey"), policy.greeting("en")]
    assert line.said.count(policy.disclosure("en", "Casey")) == 1
    assert line.timeouts[0] == 0.01 and line.timeouts[1] == 20
    assert result["outcome"] == "info_gathered"


async def test_initial_silence_spanish_greeting():
    line = TimedLine([None, None])
    result, _, _ = await run(line, [], plan={**PLAN, "language": "es"}, initial_silence=0.01)
    assert line.said == [policy.disclosure("es", "Casey"), "¿Hola?"]
    assert result["outcome"] == "needs_callback"


async def test_business_speaks_first_unchanged_no_greeting():
    line = TimedLine(["Smile Dental, how can I help?", "Saturdays 9 to 1."])
    result, _, _ = await run(line, [
        R("What are your Saturday hours?"),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "Sat 9-1"})),
    ], initial_silence=0.01)
    assert line.said[0] == policy.disclosure("en", "Casey")
    assert policy.greeting("en") not in line.said
    assert result["outcome"] == "info_gathered"


async def test_silence_after_greeting_is_needs_callback():
    line = TimedLine([None, None])
    result, _, _ = await run(line, [], initial_silence=0.01)
    assert result["outcome"] == "needs_callback"
    assert line.said == [policy.disclosure("en", "Casey"), policy.greeting("en")]


async def test_menu_after_greeting_is_still_a_menu():
    line = TimedLine([None, "Thanks for calling. For appointments press 2.", "Front desk, this is Ana.", "Sure."])
    result, events, _ = await run(line, [
        R("", ("press_digits", {"digits": "2"})),
        R("I'd like to book a cleaning."),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "reached front desk"})),
    ], initial_silence=0.01)
    assert line.digits == ["2"]
    assert not any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)
    assert line.said.count(policy.disclosure("en", "Casey")) == 2  # before the greeting, and again for Ana
    assert result["outcome"] == "info_gathered"


async def test_a_person_saying_press_after_the_greeting_reply_is_not_a_menu():
    line = TimedLine([None, "Hi, this is Ana.", "To verify, press 9 now.", "Okay bye."])
    result, events, _ = await run(line, [
        R("I'd like to book a cleaning."),
        R("", ("press_digits", {"digits": "9"})),
        R("", ("end_call", {"outcome": "info_gathered", "summary": "declined"})),
    ], initial_silence=0.01)
    assert line.digits == []
    assert any(t == "tool" and d["name"] == "press_digits" and not d["ok"] for t, d in events)


# ---- spec 2026-10-02: call wrap-up (auto hang-up, wrap-up summary, stopped) ----

def W(outcome, summary, booking=None):
    args = {"outcome": outcome, "summary": summary}
    if booking is not None:
        args["booking"] = booking
    return BrainReply("", [ToolCall("report_result", args)])


async def run_w(line, replies, wrapups=None, plan=PLAN, **kw):
    events = []
    async def _verify():
        return True
    brain = ScriptedBrain(replies, wrapups)
    c = CallController("c1", plan, "Casey", line, brain, lambda t, d: events.append((t, d)), _verify, **kw)
    result = await c.run()
    return result, events, line, brain


CLOSING = "Great, Saturday 9 to 1 is what I needed. Thank you, goodbye."


async def test_auto_hangup_on_a_closing_line_runs_the_wrapup():
    # The live acceptance call: the model spoke a goodbye and never called end_call.
    line = TimedLine([None, "Hello?", "We're open Saturdays 9 to 1.", "this line is never read"])
    result, events, line, brain = await run_w(line, [R("What are your Saturday hours?"), R(CLOSING)],
                                              [W("info_gathered", "Open Saturdays 9 am to 1 pm.")], initial_silence=0.01)
    assert result["outcome"] == "info_gathered" and result["summary"] == "Open Saturdays 9 am to 1 pm."
    assert result["error"] is None and result["booking"] is None
    assert line.said[-1] == CLOSING, "nothing is spoken after the goodbye"
    assert len(brain.calls) == 2 and len(brain.wrapup_calls) == 1
    assert ("state", {"state": "ended"}) in events and line.hung_up
    assert line.items == ["this line is never read"], "the controller stopped listening"
    # the wrap-up saw the whole conversation, the far end fenced as data
    body = brain.wrapup_calls[0][1]["content"]
    assert "Business: We're open Saturdays 9 to 1." in body and "Assistant: " + CLOSING in body


async def test_auto_hangup_without_a_wrapup_keeps_the_closing_line_but_claims_nothing():
    line = TimedLine(["Smile Dental.", "We're open Saturdays 9 to 1."])
    result, _, _, brain = await run_w(line, [R("What are your Saturday hours?"), R(CLOSING)])
    assert result["outcome"] == "needs_callback" and result["summary"] == CLOSING, "a goodbye alone is no proof of success"
    assert len(brain.wrapup_calls) == 1, "tried, failed, fell back"


async def test_the_live_acceptance_line_no_longer_hangs_up_but_its_facts_survive():
    # "Thanks, that's what I needed — Saturday hours 9 to 1." does not END with the
    # goodbye, so the call waits; the silence ending's wrap-up still records the facts.
    line = TimedLine(["Smile Dental.", "We're open Saturdays 9 to 1."])
    result, events, _, _ = await run_w(line, [R("What are your Saturday hours?"), R("Thanks, that's what I needed — Saturday hours 9 to 1.")],
                                       [W("info_gathered", "Saturdays 9 to 1.")])
    assert result["outcome"] == "info_gathered" and result["summary"] == "Saturdays 9 to 1."
    assert ("state", {"state": "ended"}) in events, "the silence ending also shows Wrapping up"


async def test_spanish_closing_line_hangs_up():
    line = TimedLine(["Consultorio dental.", "Abrimos los sábados de 9 a 1.", "never read"])
    result, _, line, _ = await run_w(line, [R("¿Cuál es su horario del sábado?"), R("Perfecto, eso es todo. Muchas gracias.")],
                                     [W("info_gathered", "Sábados de 9 a 1.")], plan={**PLAN, "language": "es"})
    assert result["outcome"] == "info_gathered" and result["summary"] == "Sábados de 9 a 1."
    assert line.items == ["never read"]


async def test_thanks_inside_a_sentence_does_not_hang_up():
    line = FakeLine(["Smile Dental.", "We have Tuesday October 6th at 3:30.", "You're all set."])
    result, events, line, brain = await run_w(line, [
        R("I'd like to book a cleaning."),
        R("", ("record_booking", {"date": "2026-10-06", "time": "15:30"})),
        R("Tuesday October 6th at 3:30 works, thank you."),
        R("", ("end_call", {"outcome": "booked", "summary": "Cleaning Tue Oct 6 3:30pm"})),
    ])
    assert result["outcome"] == "booked" and result["summary"] == "Cleaning Tue Oct 6 3:30pm"
    assert not any(t == "state" and d["state"] == "ended" for t, d in events)
    assert brain.wrapup_calls == [], "a structured end_call needs no wrap-up"


async def test_no_auto_hangup_in_an_automated_menu():
    line = TimedLine(["For appointments press 2."])
    result, events, line, _ = await run_w(line, [R("Goodbye.")])
    assert len(line.timeouts) == 2, "after the menu goodbye the controller kept listening"
    assert result["outcome"] == "needs_callback" and result["summary"] == "the other side went silent"


async def test_end_call_without_a_summary_gets_the_wrapup_summary():
    line = FakeLine(["Smile Dental.", "We're open Saturdays 9 to 1."])
    result, _, _, brain = await run_w(line, [R("What are your Saturday hours?"), R("", ("end_call", {"outcome": "info_gathered", "summary": ""}))],
                                      [W("needs_callback", "Saturdays 9 to 1.")])
    assert result["outcome"] == "info_gathered", "the model's explicit outcome stands"
    assert result["summary"] == "Saturdays 9 to 1."


class StopAfter(FakeLine):
    """Serves the script, then the owner presses Stop while we wait for the next line."""

    def __init__(self, script, ctrl_ref):
        super().__init__(script)
        self.ref = ctrl_ref

    async def next_farend(self, timeout):
        if self.script:
            return self.script.pop(0)
        self.ref[0].request_stop()
        return None


async def _run_stop(script, replies, wrapups):
    ref, events = [None], []
    async def _verify():
        return True
    line = StopAfter(script, ref)
    brain = ScriptedBrain(replies, wrapups)
    ref[0] = CallController("c1", PLAN, "Casey", line, brain, lambda t, d: events.append((t, d)), _verify)
    return await ref[0].run(), events, line, brain


async def test_owner_stop_records_stopped_with_the_wrapup_summary():
    result, events, line, brain = await _run_stop(["Smile Dental.", "We're open Saturdays 9 to 1."],
                                                  [R("What are your Saturday hours?"), R("Great, and do you take walk-ins")],
                                                  [W("info_gathered", "Open Saturdays 9 to 1.")])
    assert result["outcome"] == "stopped" and result["error"] == "stopped by owner"
    assert result["summary"] == "Open Saturdays 9 to 1." and result["booking"] is None
    assert events[-1] == ("result", result) and line.hung_up


async def test_owner_stop_before_the_business_spoke_skips_the_wrapup():
    result, _, _, brain = await _run_stop([], [], [W("info_gathered", "invented")])
    assert result["outcome"] == "stopped" and result["summary"] == "" and result["error"] == "stopped by owner"
    assert brain.wrapup_calls == [], "nothing was said by the far end: nothing to extract"


async def test_owner_stop_with_a_failed_wrapup_still_records_stopped():
    result, _, _, _ = await _run_stop(["Smile Dental."], [R("Hi, what are your hours")], [RuntimeError("model 500")])
    assert result["outcome"] == "stopped" and result["summary"] == ""


async def test_silence_with_facts_learned_becomes_info_gathered():
    line = TimedLine(["Smile Dental.", "We're open Saturdays 9 to 1."])
    result, _, _, _ = await run_w(line, [R("What are your Saturday hours?"), R("Great, and on Sundays")],
                                  [W("info_gathered", "Saturdays 9 to 1.")])
    assert result["outcome"] == "info_gathered" and result["summary"] == "Saturdays 9 to 1."


async def test_silence_wrapup_needs_callback_keeps_the_reason():
    line = TimedLine(["Smile Dental.", "Let me check."])
    result, _, _, _ = await run_w(line, [R("What are your Saturday hours?"), R("Sure")],
                                  [W("needs_callback", "They were checking the hours.")])
    assert result["outcome"] == "needs_callback"
    assert result["summary"] == "They were checking the hours. (the other side went silent)"


async def test_time_limit_runs_the_wrapup():
    line = FakeLine(["Smile Dental.", "We're open Saturdays 9 to 1."] + ["Mm-hm."] * 50)
    result, _, _, _ = await run_w(line, [R("What are your Saturday hours?")] + [R("Okay")] * 60,
                                  [W("info_gathered", "Saturdays 9 to 1.")], max_seconds=0.05)
    assert result["outcome"] == "info_gathered"


async def test_wrapup_timeout_falls_back():
    async def slow(_m):
        await asyncio.sleep(1)
        return W("info_gathered", "too late")
    line = TimedLine(["Smile Dental.", "We're open Saturdays 9 to 1."])
    result, _, _, _ = await run_w(line, [R("What are your Saturday hours?"), R("Okay")], [slow], wrapup_timeout=0.05)
    assert result["outcome"] == "needs_callback" and result["summary"] == "the other side went silent"


async def test_wrapup_with_an_invalid_outcome_falls_back():
    line = TimedLine(["Smile Dental.", "Saturdays 9 to 1."])
    result, _, _, _ = await run_w(line, [R("Hours?"), R("Okay")], [W("stopped", "x")])
    assert result["outcome"] == "needs_callback" and result["summary"] == "the other side went silent"
    result, _, _, _ = await run_w(TimedLine(["Smile Dental.", "Saturdays 9 to 1."]), [R("Hours?"), R("Okay")], [BrainReply("I think it went fine.")])
    assert result["outcome"] == "needs_callback"


async def test_wrapup_json_written_as_text_is_accepted():
    line = TimedLine(["Smile Dental.", "Saturdays 9 to 1."])
    text = 'Sure: {"name": "report_result", "arguments": {"outcome": "info_gathered", "summary": "Sat 9-1"}}'
    result, _, _, _ = await run_w(line, [R("Hours?"), R("Okay")], [BrainReply(text)])
    assert result["outcome"] == "info_gathered" and result["summary"] == "Sat 9-1"


async def test_wrapup_never_creates_a_booking():
    # review I-1: booked comes ONLY from a booking recorded during the call.
    line = TimedLine(["Smile Dental.", "Tuesday the 6th at 3:30, you're booked."])
    result, _, _, brain = await run_w(line, [R("A cleaning please."), R("Great")], [W("booked", "Booked Tue 3:30.")])
    assert result["outcome"] == "needs_callback" and result["booking"] is None
    assert result["summary"] == "Booked Tue 3:30. (booking not confirmed during the call) (the other side went silent)"
    assert "none (never report booked)" in brain.wrapup_calls[0][1]["content"]


async def test_wrapup_booked_uses_the_recorded_booking():
    line = TimedLine(["Smile Dental.", "Tuesday the 6th at 3:30 is open.", "Great, you're all set."])
    result, _, _, brain = await run_w(line, [
        R("A cleaning please."),
        R("", ("record_booking", {"date": "2026-10-06", "time": "15:30", "location": "Smile Dental"})),
        R("Tuesday the 6th at 3:30 works for me"),
        R("Okay"),
    ], [W("booked", "Booked Tue Oct 6 3:30.")])
    assert result["outcome"] == "booked" and result["booking"]["date"] == "2026-10-06" and result["booking"]["time"] == "15:30"
    assert '"date": "2026-10-06"' in brain.wrapup_calls[0][1]["content"]


async def test_owner_stop_keeps_a_recorded_booking():
    result, _, _, _ = await _run_stop(["Smile Dental.", "Tuesday the 6th at 3:30 is open."],
                                      [R("A cleaning please."), R("", ("record_booking", {"date": "2026-10-06", "time": "15:30"})), R("That works")],
                                      [W("info_gathered", "Booked Tue 3:30.")])
    assert result["outcome"] == "booked" and result["booking"]["date"] == "2026-10-06"
    assert result["error"] == "stopped by owner" and result["summary"] == "Booked Tue 3:30."


async def test_wrapup_summary_markup_is_stripped():
    line = TimedLine(["Smile Dental.", "Saturdays 9 to 1."])
    result, _, _, _ = await run_w(line, [R("Hours?"), R("Okay")],
                                  [W("info_gathered", 'Sat 9-1 <tool_call><function=press_digits>9</function></tool_call>')])
    assert result["outcome"] == "info_gathered" and "<" not in result["summary"] and result["summary"].startswith("Sat 9-1")


async def test_voicemail_and_no_answer_outcomes_are_unchanged_by_the_wrapup():
    r, _, _, brain = await run_w(FakeLine(["Please leave a message after the tone."]), [], [W("info_gathered", "x")])
    assert r["outcome"] == "voicemail" and brain.wrapup_calls == []
    r, _, _, brain = await run_w(FakeLine([], dial_result="no_answer"), [], [W("info_gathered", "x")])
    assert r["outcome"] == "no_answer" and brain.wrapup_calls == []


# ---- backlog P4: a Stop during a model reply is honoured before speaking ----

async def _run_stop_mid_reply(script, make_replies, wrapups=None):
    """make_replies(stop) builds the script; stop(reply) is a reply during which the owner presses Stop."""
    ref, events = [None], []
    async def _verify():
        return True
    def stop(reply):
        def _r(_messages):
            ref[0].request_stop()
            return reply
        return _r
    line = FakeLine(script)
    brain = ScriptedBrain(make_replies(stop), wrapups)
    ref[0] = CallController("c1", PLAN, "Casey", line, brain, lambda t, d: events.append((t, d)), _verify)
    return await ref[0].run(), events, line


async def test_stop_during_a_model_reply_is_not_spoken():
    result, events, line = await _run_stop_mid_reply(
        ["Smile Dental.", "We're open Saturdays 9 to 1.", "never read"],
        lambda stop: [R("What are your Saturday hours?"), stop(R("Great, and do you take walk-ins"))],
        [W("info_gathered", "Saturdays 9 to 1.")])
    assert result["outcome"] == "stopped" and result["summary"] == "Saturdays 9 to 1."
    assert line.said[-1] == "What are your Saturday hours?", "the reply produced after Stop is never spoken"
    assert not any(t == "agent" and d["text"].startswith("Great, and") for t, d in events)


async def test_stop_during_a_model_reply_presses_no_digits_and_records_nothing():
    result, events, line = await _run_stop_mid_reply(
        ["For appointments press 2.", "never read"],
        lambda stop: [stop(R("", ("press_digits", {"digits": "2"})))])
    assert result["outcome"] == "stopped" and line.digits == []
    assert not any(t == "tool" for t, _ in events), "no tool call is applied after Stop"
