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
    def __init__(self, call_id, plan, owner_name, line, brain, emit, verify, max_seconds=1200, ring_timeout=60, farend_timeout=20):
        self.call_id, self.plan, self.owner = call_id, plan, owner_name
        self.line, self.brain, self._emit, self.verify = line, brain, emit, verify
        self.max_seconds, self.ring_timeout, self.farend_timeout = max_seconds, ring_timeout, farend_timeout
        self.lang = "es" if plan.get("language") == "es" else "en"
        self.state = ToolState(plan)
        self.messages = [{"role": "system", "content": system_prompt(plan, owner_name)}]
        self._stop = False
        self._disclosed_for_segment = False

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
        return {"outcome": outcome, "booking": self.state.booking, "summary": summary, "do_not_call": self.state.do_not_call, "error": error}

    async def run(self):
        try:
            if not await self.verify():
                return self._finish(self.result("failed", error="start token rejected"))
            self.emit("state", {"state": "dialing"})
            r = await self.line.dial(self.plan["number_e164"])
            if r != "answered":
                return self._finish(self.result({"busy": "busy", "no_answer": "no_answer"}.get(r, "failed"), error=None if r in ("busy", "no_answer") else r))
            self.emit("state", {"state": "answered"})
            return self._finish(await self._converse())
        finally:
            await self.line.hangup()

    def _finish(self, res):
        self.emit("result", res)
        return res

    async def _converse(self):
        deadline = time.monotonic() + self.max_seconds
        while True:
            if self._stop:
                return self.result("failed", error="stopped by owner")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self.state.mode != "hold":
                    await self.say(policy.callback_line(self.lang))
                return self.result("needs_callback", "time limit reached")
            text = await self.line.next_farend(min(self.farend_timeout, remaining))
            if self._stop:
                return self.result("failed", error="stopped by owner")
            if text is None:
                if time.monotonic() >= deadline:
                    continue
                return self.result("needs_callback", "the other side went silent") if self.state.mode != "hold" else self.result("needs_callback", "left on hold")
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
            self.state.mode = "ivr" if kind == "ivr" else "human"
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
                        await self.say(policy.filler(self.lang))
                        await self.say(policy.callback_line(self.lang))
                        return self.result("needs_callback", "model produced unusable output")
                    self.messages.append({"role": "system", "content": "Your last reply contained markup. Reply again with plain speech or a proper tool call."})
                    continue
                spoken = "" if s.had_markup else s.clean
            if spoken:
                self.messages.append({"role": "assistant", "content": spoken})
                await self.say(spoken)
            if not calls:
                return None
            for c in calls:
                ok, reason = self.state.apply(c)
                self.emit("tool", {"name": c.name, "ok": ok, "reason": reason})
                self.messages.append({"role": "system", "content": f"tool {c.name} {'accepted' if ok else 'REFUSED: ' + reason}"})
                if ok and c.name == "press_digits":
                    for d in str(c.args["digits"]):
                        await self.line.send_digit(d)
                        self.emit("dtmf", {"digits": d})
                        await asyncio.sleep(0)
                    self._disclosed_for_segment = False  # whoever answers after the menu hears the disclosure
                    return None
                if ok and c.name == "mark_do_not_call":
                    return self.result("refused", "business asked not to be called again")
                if ok and c.name == "needs_owner":
                    await self.say(policy.callback_line(self.lang))
                    return self.result("needs_callback", self.state.needs_owner)
                if ok and c.name == "end_call":
                    outcome, summary = self.state.end
                    return self.result(outcome, summary)
        return None
