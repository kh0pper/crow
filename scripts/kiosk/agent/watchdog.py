"""Page-link watchdog: the kiosk page's socket to the agent is the liveness signal for Chromium.

A Chromium renderer killed by the kernel OOM killer (the Pi kernel has the memory cgroup disabled, so no
per-service cap can step in first) shows a "sad tab" and the browser does NOT exit, so cage's
Restart=always never fires. A renderer thrashing in zram looks the same. The page connects to the agent
within seconds of loading, so:

- no page within `first_s` (120 s) of agent start or of the last restart, or
- a page that left and stayed away for `gone_s` (60 s)

=> "restart": the agent ends Chromium (same user, no privilege), cage exits, systemd restarts cage.
Restarts back off (120 s, 240 s, ... up to 30 min) while pages keep failing to connect, so an unreachable
Crow does not turn into a restart loop. The backoff resets once a page has stayed connected for 10 min.

The "no page" rule is armed only once this install has seen a page connect at least once (a marker file
the agent writes on the first connection). Until the page that opens the agent socket is deployed, the
page never connects, and an armed rule would restart the browser all day. The "page left" rule needs no
marker: it only applies after a page has connected.

Also: when the page has been gone for `light_s` (10 s) the backlight goes on ("fail bright"), so a dead
page never leaves the screen dark.
Time is passed in (seconds, monotonic).
"""


class PageWatchdog:
    def __init__(self, now, first_s=120, gone_s=60, light_s=10, max_wait_s=1800, healthy_s=600, armed=True):
        self.first_s, self.gone_s, self.light_s = first_s, gone_s, light_s
        self.max_wait_s, self.healthy_s = max_wait_s, healthy_s
        self.wait_s = first_s       # how long to wait for a page after start / a restart
        self.connected = False
        self.left = False           # True once a connected page went away (until the next restart)
        self.since = now            # start, last restart, or the moment the page left
        self.connected_at = None
        self.lit = True
        self.restarts = 0
        self.armed = armed          # False until a page has ever connected on this install

    def page_connected(self, now):
        self.armed = True
        self.connected = True
        self.left = False
        self.connected_at = now
        self.lit = False            # the page drives the backlight again

    def page_left(self, now):
        if not self.connected:
            return
        if self.connected_at is not None and now - self.connected_at >= self.healthy_s:
            self.wait_s = self.first_s
        self.connected = False
        self.left = True
        self.since = now

    def check(self, now):
        """Returns a set of actions: "light" and/or "restart"."""
        if self.connected:
            return set()
        actions = set()
        away = now - self.since
        if not self.lit and away >= self.light_s:
            self.lit = True
            actions.add("light")
        if not self.left and not self.armed:
            return actions           # never seen a page: nothing to judge the browser by
        limit = self.gone_s if self.left else self.wait_s
        if away >= limit:
            actions.add("restart")
            self.restarts += 1
            if not self.left:
                self.wait_s = min(self.max_wait_s, self.wait_s * 2)   # no page came: back off
            self.left = False
            self.since = now
        return actions
