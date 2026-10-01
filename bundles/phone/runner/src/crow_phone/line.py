"""Text-level line adapters (plan A). BluetoothLine (audio) arrives in plan B."""
import asyncio


class FakeLine:
    farend_timeout = 20  # scripted tests: a silent far end is a quick needs_callback

    def __init__(self, script, dial_result="answered"):
        self.script = list(script)
        self.dial_result = dial_result
        self.said, self.digits = [], []
        self.hung_up = False
        self.dialed = None

    async def dial(self, number):
        self.dialed = number
        return self.dial_result

    async def say(self, text):
        self.said.append(text)

    async def send_digit(self, d):
        self.digits.append(d)

    async def next_farend(self, timeout):
        while self.script:
            item = self.script[0]
            if isinstance(item, dict):
                if self.digits and self.digits[-1] == item.get("on_digits"):
                    self.script.pop(0)
                    return item["say"]
                return None  # waiting for the right digit
            return self.script.pop(0)
        return None

    async def hangup(self):
        self.hung_up = True


class InteractiveFakeLine(FakeLine):
    """The owner types the business's lines in the Phone panel or the Perch call card."""

    farend_timeout = 120  # a person is typing each business line on a phone (spec 2026-10-01 §4.5)

    def __init__(self):
        super().__init__([])
        self._q = asyncio.Queue()

    def push(self, text):
        self._q.put_nowait(text)

    def wake(self):
        """Unblock next_farend immediately (used by stop)."""
        self._q.put_nowait(None)

    async def next_farend(self, timeout):
        try:
            return await asyncio.wait_for(self._q.get(), timeout)
        except asyncio.TimeoutError:
            return None
