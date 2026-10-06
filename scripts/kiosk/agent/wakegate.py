"""Decides whether a wake-word score becomes a wake event.

Rules:
- while the page reports `speaking`, and for `speaking_tail_ms` after it stops, detections are ignored:
  the agent's mic has no echo cancellation, and a Bluetooth speaker keeps sounding after the page's
  own playback has ended (its latency), so the tail must cover that latency;
- while media plays, a separate (higher) threshold applies, and the wake word stays live;
- after a wake, nothing fires for `refractory_ms` (one utterance is several 80 ms frames above threshold);
- a `speaking` flag held longer than `max_speaking_ms` is treated as stale (a page that died mid-reply
  must not leave the wake word deaf).
Time is passed in (milliseconds, monotonic) so the rules are testable without a clock.
"""


class WakeGate:
    def __init__(
        self,
        threshold=0.5,
        media_threshold=0.7,
        speaking_tail_ms=800,
        refractory_ms=2000,
        max_speaking_ms=120000,
    ):
        for name, v in (("threshold", threshold), ("media_threshold", media_threshold)):
            if not 0 < v <= 1:
                raise ValueError(f"{name} must be in (0, 1]")
        self.threshold = threshold
        self.media_threshold = media_threshold
        self.speaking_tail_ms = speaking_tail_ms
        self.refractory_ms = refractory_ms
        self.max_speaking_ms = max_speaking_ms
        self.speaking_since = None
        self.speaking = False
        self.speaking_ended_at = None
        self.media_on = False
        self.last_wake_at = None

    def set_speaking(self, on, now_ms):
        if self.speaking and not on:
            self.speaking_ended_at = now_ms
        if on and not self.speaking:
            self.speaking_since = now_ms
        self.speaking = on

    def set_media(self, on):
        self.media_on = on

    def suppressed(self, now_ms):
        if self.speaking and now_ms - self.speaking_since >= self.max_speaking_ms:
            self.set_speaking(False, now_ms)
        if self.speaking:
            return True
        return (
            self.speaking_ended_at is not None
            and now_ms - self.speaking_ended_at < self.speaking_tail_ms
        )

    def offer(self, score, now_ms):
        """Returns True if this score is a wake."""
        if self.suppressed(now_ms):
            return False
        if (
            self.last_wake_at is not None
            and now_ms - self.last_wake_at < self.refractory_ms
        ):
            return False
        limit = self.media_threshold if self.media_on else self.threshold
        if score < limit:
            return False
        self.last_wake_at = now_ms
        return True
