from . import policy


class ToolState:
    def __init__(self, plan):
        self.plan = plan
        self.mode = "human"  # human | ivr | hold
        self.booking = None
        self.needs_owner = None
        self.end = None
        self.do_not_call = False

    def apply(self, call):
        """Validate + apply one tool call. Returns (ok, reason). Code, not the model, decides."""
        a = call.args or {}
        if call.name == "press_digits":
            if self.mode != "ivr":
                return False, "press_digits is only allowed in an automated menu"
            if not policy.valid_digits(str(a.get("digits", ""))):
                return False, "digits must be 0-9, * or #"
            return True, "ok"
        if call.name == "record_booking":
            ok, reason = policy.booking_within_limits(a, self.plan.get("limits") or {})
            if ok:
                self.booking = {k: a.get(k) for k in ("date", "time", "location", "price", "confirmation", "notes")}
            return ok, reason
        if call.name == "needs_owner":
            self.needs_owner = str(a.get("reason", ""))[:300]
            return True, "ok"
        if call.name == "end_call":
            outcome = a.get("outcome")
            if outcome not in policy.MODEL_OUTCOMES:
                return False, "invalid outcome"
            if outcome == "booked" and not self.booking:
                return False, "no booking recorded"
            self.end = (outcome, str(a.get("summary", ""))[:500])
            return True, "ok"
        if call.name == "mark_do_not_call":
            self.do_not_call = True
            return True, "ok"
        return False, "unknown tool"
