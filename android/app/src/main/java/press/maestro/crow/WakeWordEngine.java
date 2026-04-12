package press.maestro.crow;

import android.content.Context;
import android.util.Log;

/**
 * Wake-word engine stub — fires {@code onWakeWord} when the configured phrase
 * is detected on the glasses' Bluetooth SCO microphone stream.
 *
 * <p>This stub exists so {@link GlassesService} can opt users in without
 * taking a hard dependency on a specific implementation. The MVP ships an
 * empty listener ("wake word disabled") so the in-app push-to-talk button
 * is the only trigger. A real implementation should wrap openWakeWord or a
 * comparable on-device detector.</p>
 *
 * <p>Per the plan: wake word detection on BT SCO is narrowband (8 or 16 kHz
 * with remote-side noise suppression), which significantly degrades
 * accuracy. PR 3 ships this feature disabled-by-default unless validation
 * on real Ray-Ban Meta hardware meets the merge gate:
 * ≥90% true-positive on a 50-utterance calibration set AND
 * ≤1 false wake per 30 min of non-wake audio.</p>
 */
public class WakeWordEngine {
    private static final String TAG = "WakeWordEngine";

    public interface Listener {
        void onWakeWord();
    }

    private final Context context;
    private Listener listener;
    private boolean enabled = false;

    public WakeWordEngine(Context context) {
        this.context = context;
    }

    /** Register a listener. Replaces any prior listener. */
    public void setListener(Listener listener) {
        this.listener = listener;
    }

    /** Enable the engine. No-op in the stub implementation. */
    public void start() {
        if (enabled) return;
        enabled = true;
        Log.i(TAG, "Wake-word engine started (stub — no-op).");
        // TODO: attach to BT SCO audio source and run the detector.
    }

    /** Disable the engine. No-op in the stub implementation. */
    public void stop() {
        if (!enabled) return;
        enabled = false;
        Log.i(TAG, "Wake-word engine stopped.");
    }

    public boolean isEnabled() { return enabled; }

    /** Exposed for test harnesses to simulate a detection. */
    void simulateTrigger() {
        if (listener != null) listener.onWakeWord();
    }
}
