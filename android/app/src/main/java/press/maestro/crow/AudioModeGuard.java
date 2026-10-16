package press.maestro.crow;

/**
 * Queue item 21c: the audio-mode guard's pure parts (no Android imports, so
 * they run on a plain JVM in unit tests). The Android glue is AudioModeWatcher.
 *
 * Why: Chromium (the WebView) puts the process in MODE_IN_COMMUNICATION while
 * the page captures the mic with echo cancellation. When that mode outlives
 * the capture, Android routes media to the earpiece and the volume keys drive
 * the in-call volume. The guard returns OUR process's mode to NORMAL — and
 * only when nothing could still need the call mode. AudioService keeps the
 * mode per calling pid, so setMode(NORMAL) here never ends another app's call
 * (see the private engineering notes, plan 2026-10-16, sources S1-S4).
 */
final class AudioModeGuard {

    private AudioModeGuard() { }

    // Mirrors of the framework constants (pinned to them by AudioModeGuardTest).
    static final int MODE_NORMAL = 0;
    static final int MODE_RINGTONE = 1;
    static final int MODE_IN_CALL = 2;
    static final int MODE_IN_COMMUNICATION = 3;
    static final int MODE_CALL_SCREENING = 4;
    static final int USAGE_MEDIA = 1;
    static final int USAGE_VOICE_COMMUNICATION = 2;
    static final int USAGE_VOICE_COMMUNICATION_SIGNALLING = 3;
    static final int DEVICE_EARPIECE = 1;
    static final int DEVICE_SPEAKER = 2;
    static final int DEVICE_BT_SCO = 7;
    static final int SOURCE_DEFAULT = 0;
    static final int SOURCE_MIC = 1;
    static final int SOURCE_CAMCORDER = 5;
    static final int SOURCE_VOICE_RECOGNITION = 6;
    static final int SOURCE_VOICE_COMMUNICATION = 7;
    static final int SOURCE_UNPROCESSED = 9;
    static final int SOURCE_VOICE_PERFORMANCE = 10;

    /** A mic grant this recent means a capture may be starting: hands off. */
    static final long GRANT_QUIET_MS = 3000L;
    /** The page's debug ring caps a line at 120 characters. */
    static final int MAX_LINE = 120;
    static final int MAX_PORT_MESSAGE = 128;

    enum Action { NONE, RESET, KEEP_CAPTURE, KEEP_GLASSES, KEEP_SCO, KEEP_PENDING_PERMISSION, KEEP_RECENT_GRANT, SKIP_DISABLED }

    /** Everything the decision reads, sampled at check time (never from the trigger). */
    static final class Facts {
        /** Any active recording on the device (ours or another app's). */
        boolean recordingActive;
        /** GlassesService started Bluetooth SCO for a turn or a note stream and has not released it. */
        boolean glassesScoHeld;
        /** AudioManager.isBluetoothScoOn(). */
        boolean btScoOn;
        /** AudioManager.getCommunicationDevice() type, or -1 for none. */
        int commDeviceType = -1;
        /** A WebView mic/camera permission prompt is open. */
        boolean permissionPending;
        /** Milliseconds since the WebView was last granted audio capture (large when never). */
        long msSinceAudioGrant = Long.MAX_VALUE;
        /** The Settings kill switch ("Audio mode guard"); off = log only, never setMode. */
        boolean guardEnabled = true;
    }

    /** The priority order is fixed: the first reason to keep wins. */
    static Action decide(int mode, Facts f) {
        if (mode != MODE_IN_COMMUNICATION) return Action.NONE;
        if (f.recordingActive) return Action.KEEP_CAPTURE;
        if (f.glassesScoHeld) return Action.KEEP_GLASSES;
        if (f.btScoOn || f.commDeviceType == DEVICE_BT_SCO) return Action.KEEP_SCO;
        if (f.permissionPending) return Action.KEEP_PENDING_PERMISSION;
        if (f.msSinceAudioGrant < GRANT_QUIET_MS) return Action.KEEP_RECENT_GRANT;
        if (!f.guardEnabled) return Action.SKIP_DISABLED;
        return Action.RESET;
    }

    static String modeName(int mode) {
        switch (mode) {
            case MODE_NORMAL: return "normal";
            case MODE_RINGTONE: return "ringtone";
            case MODE_IN_CALL: return "in_call";
            case MODE_IN_COMMUNICATION: return "in_communication";
            case MODE_CALL_SCREENING: return "call_screening";
            default: return "mode_" + mode;
        }
    }

    static String deviceName(int type) {
        switch (type) {
            case -1: return "none";
            case DEVICE_EARPIECE: return "earpiece";
            case DEVICE_SPEAKER: return "speaker";
            case DEVICE_BT_SCO: return "bt_sco";
            case 3: case 4: return "wired";          // TYPE_WIRED_HEADSET / _HEADPHONES
            case 8: return "bt_a2dp";
            case 11: case 22: return "usb";          // TYPE_USB_DEVICE / _HEADSET
            case 23: return "hearing_aid";
            case 26: case 27: return "ble";          // TYPE_BLE_HEADSET / _SPEAKER
            default: return "other";
        }
    }

    /**
     * "media@speaker 1, voice@earpiece 2" from the app-visible players
     * (getActivePlaybackConfigurations: every registered player, playing or
     * not) and the device each is routed to (-1 = none, shown as "-").
     * Grouped in first-seen order. The usage tells a call-type stream
     * (voice) from a media one; the device tells where it really plays.
     */
    static String usageSummary(int[] usages, int[] devices) {
        java.util.LinkedHashMap<String, Integer> groups = new java.util.LinkedHashMap<>();
        for (int i = 0; i < usages.length; i++) {
            int u = usages[i];
            String kind = u == USAGE_MEDIA ? "media"
                    : (u == USAGE_VOICE_COMMUNICATION || u == USAGE_VOICE_COMMUNICATION_SIGNALLING) ? "voice" : "other";
            int d = devices != null && i < devices.length ? devices[i] : -1;
            String key = kind + "@" + (d == -1 ? "-" : deviceName(d));
            groups.merge(key, 1, Integer::sum);
        }
        if (groups.isEmpty()) return "none";
        StringBuilder b = new StringBuilder();
        for (java.util.Map.Entry<String, Integer> e : groups.entrySet()) {
            if (b.length() > 0) b.append(", ");
            b.append(e.getKey()).append(' ').append(e.getValue());
        }
        return b.toString();
    }

    static String sourceName(int source) {
        switch (source) {
            case SOURCE_VOICE_COMMUNICATION: return "vc";
            case SOURCE_VOICE_RECOGNITION: return "vr";
            case SOURCE_MIC: case SOURCE_DEFAULT: return "mic";
            case SOURCE_CAMCORDER: return "cam";
            case SOURCE_UNPROCESSED: return "raw";
            case SOURCE_VOICE_PERFORMANCE: return "perf";
            default: return "other";
        }
    }

    /** "none" | "1 vc" | "1 vc, 2 vr" from the client audio sources of the active recordings. */
    static String recordingSummary(int[] sources) {
        if (sources == null || sources.length == 0) return "none";
        java.util.LinkedHashMap<String, Integer> groups = new java.util.LinkedHashMap<>();
        for (int src : sources) groups.merge(sourceName(src), 1, Integer::sum);
        StringBuilder b = new StringBuilder();
        for (java.util.Map.Entry<String, Integer> e : groups.entrySet()) {
            if (b.length() > 0) b.append(", ");
            b.append(e.getValue()).append(' ').append(e.getKey());
        }
        return b.toString();
    }

    /** After a reset, a capture is running but the mode is not IN_COMMUNICATION (report only). */
    static String captureWithoutCallModeLine(int mode, String rec) {
        return cap("capture without call mode (" + modeName(mode) + ") · rec: " + rec);
    }

    private static String cap(String s) { return s.length() > MAX_LINE ? s.substring(0, MAX_LINE) : s; }

    /**
     * The debug line ("audio: " is added by the page). modeAfter is the mode
     * read after the action; resetError is the exception class when
     * setMode threw, else null.
     */
    static String line(Action a, int modeAfter, String resetError, String out, String rec, int commDeviceType) {
        String verdict;
        switch (a) {
            case RESET:
                if (resetError != null) verdict = "reset failed (" + resetError + ")";
                else if (modeAfter == MODE_IN_COMMUNICATION) verdict = "mode still in_communication (another owner)";
                else verdict = "mode " + modeName(modeAfter) + " (was in_communication)";
                break;
            case KEEP_CAPTURE: verdict = "mode in_communication kept (capture live)"; break;
            case KEEP_GLASSES: verdict = "mode in_communication kept (glasses)"; break;
            case KEEP_SCO: verdict = "mode in_communication kept (bluetooth sco)"; break;
            case KEEP_PENDING_PERMISSION: verdict = "mode in_communication kept (mic prompt)"; break;
            case KEEP_RECENT_GRANT: verdict = "mode in_communication kept (capture starting)"; break;
            case SKIP_DISABLED: verdict = "guard off (would reset in_communication)"; break;
            default: verdict = "mode " + modeName(modeAfter); break;
        }
        return cap(verdict + " · out: " + out + " · rec: " + rec + " · route: " + deviceName(commDeviceType));
    }

    enum PortOp { HELLO, CAPTURE_STARTING, CAPTURE_ENDED }

    /**
     * The port takes exactly {"op":"hello"}, {"op":"captureStarting"} or
     * {"op":"captureEnded"} (JSON
     * whitespace allowed, nothing else: no extra fields, no escapes). Anything
     * else is null and is ignored.
     */
    static PortOp parsePortMessage(String data) {
        if (data == null || data.length() > MAX_PORT_MESSAGE) return null;
        StringBuilder b = new StringBuilder(data.length());
        for (int i = 0; i < data.length(); i++) {
            char c = data.charAt(i);
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') b.append(c);
        }
        String s = b.toString();
        if (s.equals("{\"op\":\"hello\"}")) return PortOp.HELLO;
        if (s.equals("{\"op\":\"captureStarting\"}")) return PortOp.CAPTURE_STARTING;
        if (s.equals("{\"op\":\"captureEnded\"}")) return PortOp.CAPTURE_ENDED;
        return null;
    }
}
