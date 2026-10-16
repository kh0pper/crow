package press.maestro.crow;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.media.AudioRecordingConfiguration;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Queue item 21c: the Android side of the audio-mode guard. The decision is
 * AudioModeGuard.decide(); the timing is AudioCheckQueue. Main thread only:
 * every callback is registered on the main looper and every check runs there.
 *
 * Triggers are hints, never reasons: a check re-reads every fact when it runs.
 * Triggers: the active recordings going to none, the mode becoming
 * IN_COMMUNICATION (checked 3 s later), the page's captureEnded
 * (CrowAudioPort), onResume, and one follow-up 7 s after a reported check.
 * A capture starting (a recording appears, a WebView mic request, the page's
 * captureStarting) cancels whatever is pending.
 */
final class AudioModeWatcher {

    interface Sink { void send(String line); }

    static final String TAG = "CrowAudio";
    /** After a reset, how long a new capture runs before "capture without call mode" is checked. */
    static final long CAPTURE_PROBE_MS = 1000L;

    private final AudioManager am;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BooleanSupplier permissionPending;
    private final BooleanSupplier guardEnabled;
    private final AudioCheckQueue queue = new AudioCheckQueue();
    private final Runnable tick = this::onTick;
    private final Runnable captureProbe = this::onCaptureProbe;
    private Sink sink;
    private boolean started;
    private boolean recordingWasActive;
    private long lastAudioGrantAt; // elapsedRealtime; 0 = never
    private long modeEnteredAt;    // elapsedRealtime of the last change to IN_COMMUNICATION; 0 = never
    /** The last line sent to the page: a follow-up is sent only when it differs. */
    private String lastReported;
    /** Set by a RESET: the next capture is probed once for call mode. */
    private boolean probeNextCapture;

    private final AudioManager.AudioRecordingCallback recordingCallback = new AudioManager.AudioRecordingCallback() {
        @Override
        public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
            boolean active = configs != null && !configs.isEmpty();
            if (active) {
                queue.cancelAll(); // a capture is running: no check may run against it
                reschedule();
                if (!recordingWasActive && probeNextCapture) {
                    probeNextCapture = false;
                    main.removeCallbacks(captureProbe);
                    main.postDelayed(captureProbe, CAPTURE_PROBE_MS);
                }
            } else if (!active && recordingWasActive) {
                trigger("capture_end", false, AudioCheckQueue.CHECK_DELAY_MS);
            }
            recordingWasActive = active;
        }
    };

    private final AudioManager.OnModeChangedListener modeListener = mode -> {
        Log.i(TAG, "mode changed to " + AudioModeGuard.modeName(mode));
        if (mode == AudioModeGuard.MODE_IN_COMMUNICATION) {
            modeEnteredAt = SystemClock.elapsedRealtime();
            trigger("mode", false, AudioCheckQueue.MODE_CHECK_DELAY_MS);
        }
    };

    AudioModeWatcher(Context context, BooleanSupplier permissionPending, BooleanSupplier guardEnabled) {
        this.context = context;
        this.am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.permissionPending = permissionPending;
        this.guardEnabled = guardEnabled;
    }

    void setSink(Sink sink) { this.sink = sink; }

    void start() {
        if (started || am == null) return;
        started = true;
        recordingWasActive = !am.getActiveRecordingConfigurations().isEmpty();
        am.registerAudioRecordingCallback(recordingCallback, main);
        am.addOnModeChangedListener(context.getMainExecutor(), modeListener);
    }

    void stop() {
        if (!started) return;
        started = false;
        queue.cancelAll();
        main.removeCallbacks(tick);
        main.removeCallbacks(captureProbe);
        try { am.unregisterAudioRecordingCallback(recordingCallback); } catch (Exception ignored) { }
        try { am.removeOnModeChangedListener(modeListener); } catch (Exception ignored) { }
        sink = null;
    }

    /** A capture is starting (the WebView asked for the mic, or the page said so): hands off. */
    void noteCaptureStarting() {
        lastAudioGrantAt = SystemClock.elapsedRealtime();
        queue.cancelAll();
        reschedule();
    }

    /** A hint from the page or the activity; report = send the result line to the page. */
    void requestCheck(String trigger, boolean report) {
        trigger(trigger, report, AudioCheckQueue.CHECK_DELAY_MS);
    }

    private void trigger(String kind, boolean report, long delayMs) {
        if (!started) return;
        queue.trigger(kind, report, delayMs, SystemClock.uptimeMillis());
        reschedule();
    }

    private void reschedule() {
        main.removeCallbacks(tick);
        long at = queue.nextAt();
        if (started && at >= 0) main.postAtTime(tick, at);
    }

    private void onTick() {
        if (!started) return;
        AudioCheckQueue.Due d;
        while ((d = queue.poll(SystemClock.uptimeMillis())) != null) check(d);
        reschedule();
    }

    private void check(AudioCheckQueue.Due due) {
        int mode = am.getMode();
        int[] sources = recordingSources();
        AudioModeGuard.Facts f = new AudioModeGuard.Facts();
        f.recordingActive = sources.length > 0;
        f.glassesScoHeld = GlassesService.isScoHeld();
        f.btScoOn = isBluetoothScoOn();
        f.commDeviceType = commDeviceType();
        f.permissionPending = permissionPending.getAsBoolean();
        f.msSinceAudioGrant = lastAudioGrantAt == 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - lastAudioGrantAt;
        f.msSinceModeEntered = modeEnteredAt == 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - modeEnteredAt;
        f.guardEnabled = guardEnabled.getAsBoolean();
        AudioModeGuard.Action a = AudioModeGuard.decide(mode, f);

        String error = null;
        int after = mode;
        if (a == AudioModeGuard.Action.RESET) {
            try {
                am.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception e) {
                error = e.getClass().getSimpleName();
            }
            after = am.getMode();
            probeNextCapture = error == null;
        }
        String rec = AudioModeGuard.recordingSummary(sources);
        String line = AudioModeGuard.line(a, after, error, summary(), rec, commDeviceType());
        Log.i(TAG, "check (" + due.trigger + "): " + line);
        if ("page".equals(due.trigger)) Log.i(TAG, "recordings: " + recordingDetail());

        if (a == AudioModeGuard.Action.KEEP_RECENT_GRANT) {
            // Re-review N1: a quiet-window keep must not be the last word — look again just after it.
            long left = Math.max(AudioModeGuard.GRANT_QUIET_MS - f.msSinceAudioGrant,
                    AudioModeGuard.MODE_QUIET_MS - f.msSinceModeEntered);
            trigger("quiet", due.report, Math.max(0L, left) + 100L);
        }

        boolean send;
        if (due.followUp) send = !line.equals(lastReported);
        else send = due.report || a == AudioModeGuard.Action.RESET;
        if (send) report(line);
    }

    /** After a reset, a capture has run for CAPTURE_PROBE_MS: is it in call mode? (report only) */
    private void onCaptureProbe() {
        if (!started) return;
        int[] sources = recordingSources();
        // Only a call-type capture (Chromium's AEC path) is expected to be in call mode;
        // the glasses pump (VOICE_RECOGNITION over SCO) or another app's recorder is not.
        if (!AudioModeGuard.hasVoiceCommunication(sources) || GlassesService.isScoHeld()) {
            probeNextCapture = true; // re-review N4: not the capture we meant to probe; wait for the next one
            return;
        }
        int mode = am.getMode();
        if (mode == AudioModeGuard.MODE_IN_COMMUNICATION) return;
        String line = AudioModeGuard.captureWithoutCallModeLine(mode, AudioModeGuard.recordingSummary(sources));
        Log.w(TAG, line);
        report(line);
    }

    private void report(String line) {
        lastReported = line;
        Sink s = sink;
        if (s != null) s.send(line);
    }

    private String summary() {
        int[][] p = players();
        return AudioModeGuard.usageSummary(p[0], p[1]);
    }

    @SuppressWarnings("deprecation")
    private boolean isBluetoothScoOn() {
        try { return am.isBluetoothScoOn(); } catch (Exception e) { return false; }
    }

    private int commDeviceType() {
        try {
            AudioDeviceInfo d = am.getCommunicationDevice();
            return d == null ? -1 : d.getType();
        } catch (Exception e) {
            return -1;
        }
    }

    /** The client audio source of every active recording this app can see. */
    private int[] recordingSources() {
        try {
            List<AudioRecordingConfiguration> rs = am.getActiveRecordingConfigurations();
            int[] out = new int[rs.size()];
            for (int i = 0; i < rs.size(); i++) out[i] = rs.get(i).getClientAudioSource();
            return out;
        } catch (Exception e) {
            return new int[0];
        }
    }

    /** For logcat only: source, session id and silenced flag of each active recording. */
    private String recordingDetail() {
        try {
            StringBuilder b = new StringBuilder();
            for (AudioRecordingConfiguration r : am.getActiveRecordingConfigurations()) {
                if (b.length() > 0) b.append("; ");
                b.append(AudioModeGuard.sourceName(r.getClientAudioSource()))
                        .append(" session=").append(r.getClientAudioSessionId())
                        .append(r.isClientSilenced() ? " silenced" : "");
            }
            return b.length() == 0 ? "none" : b.toString();
        } catch (Exception e) {
            return "unreadable (" + e.getClass().getSimpleName() + ")";
        }
    }

    /**
     * [usages, device types] of every player AudioManager lists: device-wide
     * (other apps' entries are anonymized but listed), registered players
     * whether playing or not — getPlayerState() is not public API. So
     * "voice 1" may be an idle stream; dumpsys audio shows player state.
     */
    private int[][] players() {
        try {
            List<AudioPlaybackConfiguration> cs = am.getActivePlaybackConfigurations();
            int[] usages = new int[cs.size()];
            int[] devices = new int[cs.size()];
            for (int i = 0; i < cs.size(); i++) {
                AudioPlaybackConfiguration c = cs.get(i);
                usages[i] = c.getAudioAttributes().getUsage();
                AudioDeviceInfo d = c.getAudioDeviceInfo();
                devices[i] = d == null ? -1 : d.getType();
            }
            return new int[][]{ usages, devices };
        } catch (Exception e) {
            return new int[][]{ new int[0], new int[0] };
        }
    }
}
