package press.maestro.crow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Queue item 21c: the guard's scheduling rules (plan rev 2, R2.7). */
public class AudioCheckQueueTest {

    @Test
    public void aTriggerRunsOnceAfterItsDelay() {
        AudioCheckQueue q = new AudioCheckQueue();
        assertTrue(q.idle());
        q.trigger("capture_end", false, 600, 1000);
        assertEquals(1600, q.nextAt());
        assertNull(q.poll(1599));
        AudioCheckQueue.Due d = q.poll(1600);
        assertEquals("capture_end", d.trigger);
        assertFalse(d.report);
        assertFalse(d.followUp);
        assertTrue("no follow-up for a silent check", q.idle());
        assertNull(q.poll(99_999));
    }

    @Test
    public void theEarlierDeadlineWins() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("page", true, 600, 1000);          // due 1600
        q.trigger("mode", false, 3000, 1100);        // due 4100: must not push the page check back
        assertEquals(1600, q.nextAt());
        AudioCheckQueue.Due d = q.poll(1600);
        assertEquals("page", d.trigger);
        assertTrue(d.report);

        AudioCheckQueue r = new AudioCheckQueue();
        r.trigger("mode", false, 3000, 1000);        // due 4000
        r.trigger("capture_end", false, 600, 2000);  // due 2600: earlier, takes over
        assertEquals(2600, r.nextAt());
        assertEquals("capture_end", r.poll(2600).trigger);
    }

    @Test
    public void repeatedTriggersCannotStarveTheCheck() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("capture_end", false, 600, 0);
        for (long t = 100; t < 600; t += 100) q.trigger("capture_end", false, 600, t);
        assertEquals(600, q.nextAt());
        assertTrue(q.poll(600) != null);
    }

    @Test
    public void aCaptureStartCancelsEverythingIncludingTheFollowUp() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("page", true, 600, 0);
        q.cancelAll();
        assertTrue(q.idle());
        assertNull(q.poll(10_000));

        q.trigger("mode", true, 0, 20_000);
        assertTrue(q.poll(20_000).report);           // arms a follow-up at 27 000
        assertEquals(27_000, q.nextAt());
        q.cancelAll();
        assertTrue(q.idle());
        assertNull(q.poll(30_000));
    }

    @Test
    public void aReportingCheckGetsOneFollowUp() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("page", true, 600, 0);
        assertTrue(q.poll(600).report);
        assertEquals(600 + AudioCheckQueue.FOLLOW_UP_MS, q.nextAt());
        assertNull(q.poll(7599));
        AudioCheckQueue.Due f = q.poll(7600);
        assertTrue(f.followUp);
        assertEquals(AudioCheckQueue.FOLLOW_UP, f.trigger);
        assertTrue(f.report);
        assertTrue("the follow-up does not chain", q.idle());
    }

    @Test
    public void thePendingCheckComesBeforeTheFollowUp() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("page", true, 600, 0);
        q.poll(600);                                 // follow-up at 7600
        q.trigger("capture_end", false, 600, 7000);  // due 7600 as well
        AudioCheckQueue.Due a = q.poll(8000);
        assertFalse(a.followUp);
        AudioCheckQueue.Due b = q.poll(8000);
        assertTrue(b.followUp);
    }

    @Test
    public void pageTriggersAreRateLimitedButStillAskForTheLine() {
        AudioCheckQueue q = new AudioCheckQueue();
        assertTrue(q.trigger("page", true, 600, 0));
        q.poll(600);
        q.cancelAll();
        assertFalse("1.9 s later: dropped", q.trigger("page", true, 600, 1900));
        assertTrue(q.idle());
        assertTrue("2 s later: counts", q.trigger("page", true, 600, 2000));

        AudioCheckQueue r = new AudioCheckQueue();
        r.trigger("capture_end", false, 600, 0);
        assertTrue(r.trigger("page", false, 600, 100));
        assertFalse(r.trigger("page", true, 600, 200));
        assertTrue("a dropped page trigger still makes the pending check report", r.poll(600).report);
    }

    @Test
    public void theReportFlagIsSticky() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("page", true, 600, 0);
        q.trigger("capture_end", false, 600, 100);
        assertTrue(q.poll(600).report);
    }

    @Test
    public void negativeDelaysRunNow() {
        AudioCheckQueue q = new AudioCheckQueue();
        q.trigger("resume", false, -5, 50);
        assertEquals(50, q.nextAt());
    }
}
