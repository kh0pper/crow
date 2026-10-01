import asyncio
import json
import re
import time

from . import policy
from .brain import TOOLS, system_prompt
from .markup import sanitize
from .tools import ToolState

_VOICEMAIL = re.compile(r"leave (a|your) message|after the (tone|beep)|deje (su|un) mensaje|despu[eé]s del tono", re.I)
_SIT = re.compile(r"not in service|has been disconnected|number you have dialed|no est[aá] en servicio|el n[uú]mero que usted marc[oó]", re.I)
# Menu phrasing only ("for appointments, press 2" / "para citas, oprima el 1"). A bare
# "press 9" from a person is NOT a menu: that is the callee-injection case.
_IVR = re.compile(r"\b(for|to)\b[^.]{1,40}?,?\s*press\s*\d|\bpress\s*\d\s*(for|to)\b"
                  r"|\bpara\b[^.]{1,40}?,?\s*(oprima|marque|pulse)\s*(el\s*)?\d|\b(oprima|marque|pulse)\s*(el\s*)?\d\s*para\b", re.I)
_HOLD = re.compile(r"please hold|stay on the line|your call is important|permanezca en la l[ií]nea|espere un momento|su llamada es importante", re.I)


def classify(text: str) -> str:
    if _SIT.search(text):
        return "sit"
    if _VOICEMAIL.search(text):
        return "voicemail"
    if _HOLD.search(text):
        return "hold"
    if _IVR.search(text):
        return "ivr"
    return "human"


class CallController:
    def __init__(self, call_id, plan, owner_name, line, brain, emit, verify, max_seconds=1200, ring_timeout=60, farend_timeout=None, initial_silence=6):
        self.call_id, self.plan, self.owner = call_id, plan, owner_name
        self.line, self.brain, self._emit, self.verify = line, brain, emit, verify
        self.max_seconds, self.ring_timeout = max_seconds, ring_timeout
        # Per line (spec 2026-10-01 §4.5): an owner typing on a phone needs far longer than a script.
        self.farend_timeout = farend_timeout if farend_timeout is not None else getattr(line, "farend_timeout", 20)
        self.initial_silence = initial_silence
        self.lang = "es" if plan.get("language") == "es" else "en"
        self.state = ToolState(plan)
        self.messages = [{"role": "system", "content": system_prompt(plan, owner_name)}]
        self._stop = False
        self._disclosed_for_segment = False
        # Set when we spoke first into initial silence and nobody has answered yet:
        # the first far-end line after that may still be an automated menu.
        self._greeted_unanswered = False
        self._n = 0

    def request_stop(self):
        self._stop = True
        wake = getattr(self.line, "wake", None)
        if wake:
            wake()

    def emit(self, t, d):
        self._emit(t, d)

    async def say(self, text):
        self.emit("agent", {"text": text})
        await self.line.say(text)

    def result(self, outcome, summary="", error=None):
        return {"outcome": outcome, "booking": self.state.booking if outcome == "booked" else None, "summary": summary, "do_not_call": self.state.do_not_call, "error": error}

    async def run(self):
        try:
            try:
                ok, _reason = policy.check_number(self.plan.get("number_e164"))
                if not ok:
                    return self._finish(self.result("failed", error="number blocked by runner policy"))
                if not await self.verify():
                    return self._finish(self.result("failed", error="start token rejected"))
                self.emit("state", {"state": "dialing"})
                try:
                    r = await asyncio.wait_for(self.line.dial(self.plan["number_e164"]), self.ring_timeout)
                except asyncio.TimeoutError:
                    r = "no_answer"
                if r != "answered":
                    return self._finish(self.result({"busy": "busy", "no_answer": "no_answer"}.get(r, "failed"), error=None if r in ("busy", "no_answer") else r))
                self.emit("state", {"state": "answered"})
                return self._finish(await self._converse())
            except Exception as e:  # run() never raises
                res = self.result("failed", error=f"{type(e).__name__}: {e}")
                try:
                    self.emit("result", res)
                except Exception:
                    pass
                return res
        finally:
            try:
                await self.line.hangup()
            except Exception:
                pass

    async def _ensure_disclosed(self):
        """Nothing model-generated (or the callback line) is spoken before the disclosure in this segment."""
        if not self._disclosed_for_segment:
            await self.say(policy.disclosure(self.lang, self.owner))
            self._disclosed_for_segment = True

    def _call_id(self):
        self._n += 1
        return f"call_{self._n}"

    def _finish(self, res):
        self.emit("result", res)
        return res

    async def _converse(self):
        deadline = time.monotonic() + self.max_seconds
        first_wait = True
        while True:
            if self._stop:
                return self.result("failed", error="stopped by owner")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self.state.mode != "hold":
                    await self._ensure_disclosed()
                    await self.say(policy.callback_line(self.lang))
                return self.result("needs_callback", "time limit reached")
            wait = self.initial_silence if first_wait else self.farend_timeout
            text = await self.line.next_farend(min(wait, remaining))
            if self._stop:
                return self.result("failed", error="stopped by owner")
            if text is None:
                if time.monotonic() >= deadline:
                    continue
                if first_wait:
                    # Spec 2026-10-01 §4.5: silence right after answering -> speak first.
                    # The templated disclosure ALWAYS precedes the greeting; nothing
                    # model-generated is spoken here.
                    first_wait = False
                    await self._ensure_disclosed()
                    await self.say(policy.greeting(self.lang))
                    self._greeted_unanswered = True
                    continue
                return self.result("needs_callback", "the other side went silent") if self.state.mode != "hold" else self.result("needs_callback", "left on hold")
            first_wait = False
            greeted = self._greeted_unanswered
            self._greeted_unanswered = False
            self.emit("farend", {"text": text})
            kind = classify(text)
            if kind == "sit":
                return self.result("not_in_service", text[:200])
            if kind == "voicemail":
                return self.result("voicemail", "reached voicemail")
            if kind == "hold":
                self.state.mode = "hold"
                self._disclosed_for_segment = False
                self.emit("state", {"state": "on_hold"})
                continue
            # A menu is only honored before we have started talking to a human in this segment;
            # a person saying "press 9" mid-conversation is the callee-injection case. The one
            # exception: the very first line after our speak-first greeting (a slow IVR).
            if kind == "ivr" and (not self._disclosed_for_segment or greeted):
                self.state.mode = "ivr"
                self.state.menu_text = text
            else:
                self.state.mode = "human"
            if self.state.mode == "human" and not self._disclosed_for_segment:
                await self.say(policy.disclosure(self.lang, self.owner))
                self._disclosed_for_segment = True
            self.messages.append({"role": "user", "content": text})
            done = await self._think()
            if done:
                return done

    async def _think(self):
        """One far-end turn: up to 3 brain steps (tool results feed back). Returns a result dict when the call ends."""
        bad_markup = 0
        for _ in range(3):
            reply = await self.brain.reply(self.messages, TOOLS)
            calls = list(reply.tool_calls)
            spoken = ""
            if reply.text:
                s = sanitize(reply.text)
                calls += s.calls
                if s.had_markup and not s.calls:
                    bad_markup += 1
                    if bad_markup >= 2:
                        await self._ensure_disclosed()
                        await self.say(policy.filler(self.lang))
                        await self.say(policy.callback_line(self.lang))
                        return self.result("needs_callback", "model produced unusable output")
                    self._note("Your last reply contained markup. Reply again with plain speech or a proper tool call.")
                    continue
                spoken = "" if s.had_markup else s.clean
            # Validate/apply every tool call BEFORE speaking; a refused call drops the reply's speech.
            ids = [self._call_id() for _ in calls]
            snap = {k: getattr(self.state, k) for k in ("booking", "needs_owner", "end", "do_not_call", "mode", "menu_text")}
            results = [self.state.apply(c) for c in calls]
            refused = any(not ok for ok, _ in results)
            if refused:  # a refused batch leaves no partial state behind
                for k, v in snap.items():
                    setattr(self.state, k, v)
            if calls:
                self.messages.append({"role": "assistant", "content": (None if refused else spoken) or None, "tool_calls": [
                    {"id": i, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.args if isinstance(c.args, dict) else {})}}
                    for i, c in zip(ids, calls)]})
                for i, c, (ok, reason) in zip(ids, calls, results):
                    self.emit("tool", {"name": c.name, "ok": ok, "reason": reason})
                    self.messages.append({"role": "tool", "tool_call_id": i, "content": "accepted" if ok else f"REFUSED: {reason}"})
            elif spoken:
                self.messages.append({"role": "assistant", "content": spoken})
            if refused:
                continue
            if spoken:
                await self._ensure_disclosed()
                await self.say(spoken)
            if not calls:
                return None
            for c in calls:
                if c.name == "press_digits":
                    for d in str(c.args["digits"]):
                        await self.line.send_digit(d)
                        self.emit("dtmf", {"digits": d})
                        await asyncio.sleep(0)
                    self._disclosed_for_segment = False  # whoever answers after the menu hears the disclosure
                    return None
                if c.name == "mark_do_not_call":
                    return self.result("refused", "business asked not to be called again")
                if c.name == "needs_owner":
                    await self._ensure_disclosed()
                    await self.say(policy.callback_line(self.lang))
                    return self.result("needs_callback", self.state.needs_owner)
                if c.name == "end_call":
                    outcome, summary = self.state.end
                    return self.result(outcome, summary)
        return None

    def _note(self, text):
        self.messages.append({"role": "user", "content": f"(note from the call controller) {text}"})
