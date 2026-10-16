package press.maestro.crow;

/**
 * Queue item 21c: when the audio-mode guard checks (pure, clock injected by
 * the caller, so it is unit-tested on a plain JVM). AudioModeWatcher drives
 * it from the main looper.
 *
 * Rules (plan rev 2, R2.7):
 * - one pending check; a new trigger can only bring it EARLIER, never push it back;
 * - a capture starting cancels everything, the follow-up included;
 * - a page trigger counts at most once per PAGE_MIN_INTERVAL_MS (a dropped
 *   one still makes a pending check report);
 * - the report flag is sticky until the check runs;
 * - a check that reports is followed by one follow-up check FOLLOW_UP_MS later.
 */
final class AudioCheckQueue {

    static final long CHECK_DELAY_MS = 600L;
    static final long MODE_CHECK_DELAY_MS = 3000L;
    static final long FOLLOW_UP_MS = 7000L;
    static final long PAGE_MIN_INTERVAL_MS = 2000L;

    static final String FOLLOW_UP = "follow_up";

    static final class Due {
        final String trigger;
        final boolean report;
        final boolean followUp;

        Due(String trigger, boolean report, boolean followUp) {
            this.trigger = trigger;
            this.report = report;
            this.followUp = followUp;
        }
    }

    private long dueAt = -1;
    private String trigger;
    private boolean report;
    private long followUpAt = -1;
    private boolean pageSeen;
    private long lastPageAt;

    /** False when a page trigger was rate-limited (nothing new was scheduled). */
    boolean trigger(String kind, boolean wantReport, long delayMs, long now) {
        if ("page".equals(kind)) {
            if (pageSeen && now - lastPageAt < PAGE_MIN_INTERVAL_MS) {
                if (dueAt >= 0) report |= wantReport;
                return false;
            }
            pageSeen = true;
            lastPageAt = now;
        }
        long at = now + Math.max(0L, delayMs);
        if (dueAt < 0 || at < dueAt) {
            dueAt = at;
            trigger = kind;
        }
        report |= wantReport;
        return true;
    }

    /** A capture is starting: no check (or follow-up) may run against it. */
    void cancelAll() {
        dueAt = -1;
        trigger = null;
        report = false;
        followUpAt = -1;
    }

    boolean idle() { return dueAt < 0 && followUpAt < 0; }

    /** The next time poll() has something, or -1. */
    long nextAt() {
        if (dueAt < 0) return followUpAt;
        if (followUpAt < 0) return dueAt;
        return Math.min(dueAt, followUpAt);
    }

    /** What is due at `now` (the check first, then the follow-up), or null. */
    Due poll(long now) {
        if (dueAt >= 0 && now >= dueAt) {
            Due d = new Due(trigger, report, false);
            dueAt = -1;
            trigger = null;
            report = false;
            if (d.report) followUpAt = now + FOLLOW_UP_MS;
            return d;
        }
        if (followUpAt >= 0 && now >= followUpAt) {
            followUpAt = -1;
            return new Due(FOLLOW_UP, true, true);
        }
        return null;
    }
}
