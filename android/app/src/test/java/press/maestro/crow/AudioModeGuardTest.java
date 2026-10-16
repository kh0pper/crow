package press.maestro.crow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaRecorder;

import org.junit.Test;

/** Queue item 21c: the audio-mode guard's decision, its debug line and the port's message parser. */
public class AudioModeGuardTest {

    private static AudioModeGuard.Facts quiet() {
        AudioModeGuard.Facts f = new AudioModeGuard.Facts();
        f.msSinceAudioGrant = 60_000L;
        return f;
    }

    @Test
    public void modeConstantsMatchTheFramework() {
        // AudioManager's constants are compile-time ints, so this runs on a plain JVM.
        assertEquals(AudioManager.MODE_NORMAL, AudioModeGuard.MODE_NORMAL);
        assertEquals(AudioManager.MODE_RINGTONE, AudioModeGuard.MODE_RINGTONE);
        assertEquals(AudioManager.MODE_IN_CALL, AudioModeGuard.MODE_IN_CALL);
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, AudioModeGuard.MODE_IN_COMMUNICATION);
        assertEquals(AudioManager.MODE_CALL_SCREENING, AudioModeGuard.MODE_CALL_SCREENING);
        assertEquals(AudioAttributes.USAGE_MEDIA, AudioModeGuard.USAGE_MEDIA);
        assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION, AudioModeGuard.USAGE_VOICE_COMMUNICATION);
        assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING, AudioModeGuard.USAGE_VOICE_COMMUNICATION_SIGNALLING);
        assertEquals(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, AudioModeGuard.DEVICE_EARPIECE);
        assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioModeGuard.DEVICE_SPEAKER);
        assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioModeGuard.DEVICE_BT_SCO);
        assertEquals(MediaRecorder.AudioSource.DEFAULT, AudioModeGuard.SOURCE_DEFAULT);
        assertEquals(MediaRecorder.AudioSource.MIC, AudioModeGuard.SOURCE_MIC);
        assertEquals(MediaRecorder.AudioSource.CAMCORDER, AudioModeGuard.SOURCE_CAMCORDER);
        assertEquals(MediaRecorder.AudioSource.VOICE_RECOGNITION, AudioModeGuard.SOURCE_VOICE_RECOGNITION);
        assertEquals(MediaRecorder.AudioSource.VOICE_COMMUNICATION, AudioModeGuard.SOURCE_VOICE_COMMUNICATION);
        assertEquals(MediaRecorder.AudioSource.UNPROCESSED, AudioModeGuard.SOURCE_UNPROCESSED);
        assertEquals(MediaRecorder.AudioSource.VOICE_PERFORMANCE, AudioModeGuard.SOURCE_VOICE_PERFORMANCE);
        assertEquals("wired", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_WIRED_HEADSET));
        assertEquals("wired", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_WIRED_HEADPHONES));
        assertEquals("bt_a2dp", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP));
        assertEquals("usb", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_USB_DEVICE));
        assertEquals("usb", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_USB_HEADSET));
        assertEquals("hearing_aid", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_HEARING_AID));
        assertEquals("ble", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_BLE_HEADSET));
        assertEquals("ble", AudioModeGuard.deviceName(AudioDeviceInfo.TYPE_BLE_SPEAKER));
    }

    @Test
    public void onlyInCommunicationIsEverTouched() {
        int[] others = { AudioModeGuard.MODE_NORMAL, AudioModeGuard.MODE_RINGTONE, AudioModeGuard.MODE_IN_CALL,
                AudioModeGuard.MODE_CALL_SCREENING, 5, 6, -1, 99 };
        for (int m : others) {
            assertEquals("mode " + m, AudioModeGuard.Action.NONE, AudioModeGuard.decide(m, quiet()));
        }
        assertEquals(AudioModeGuard.Action.RESET, AudioModeGuard.decide(AudioModeGuard.MODE_IN_COMMUNICATION, quiet()));
    }

    @Test
    public void eachKeepConditionAloneBlocksTheReset() {
        int ic = AudioModeGuard.MODE_IN_COMMUNICATION;
        AudioModeGuard.Facts f;

        f = quiet(); f.recordingActive = true;
        assertEquals(AudioModeGuard.Action.KEEP_CAPTURE, AudioModeGuard.decide(ic, f));
        f = quiet(); f.glassesScoHeld = true;
        assertEquals(AudioModeGuard.Action.KEEP_GLASSES, AudioModeGuard.decide(ic, f));
        f = quiet(); f.btScoOn = true;
        assertEquals(AudioModeGuard.Action.KEEP_SCO, AudioModeGuard.decide(ic, f));
        f = quiet(); f.commDeviceType = AudioModeGuard.DEVICE_BT_SCO;
        assertEquals(AudioModeGuard.Action.KEEP_SCO, AudioModeGuard.decide(ic, f));
        f = quiet(); f.permissionPending = true;
        assertEquals(AudioModeGuard.Action.KEEP_PENDING_PERMISSION, AudioModeGuard.decide(ic, f));
        f = quiet(); f.msSinceAudioGrant = 0;
        assertEquals(AudioModeGuard.Action.KEEP_RECENT_GRANT, AudioModeGuard.decide(ic, f));
    }

    @Test
    public void everyCombinationOfKeepsBlocksTheReset() {
        int ic = AudioModeGuard.MODE_IN_COMMUNICATION;
        for (int bits = 1; bits < 64; bits++) {
            AudioModeGuard.Facts f = quiet();
            f.recordingActive = (bits & 1) != 0;
            f.glassesScoHeld = (bits & 2) != 0;
            f.btScoOn = (bits & 4) != 0;
            f.commDeviceType = (bits & 8) != 0 ? AudioModeGuard.DEVICE_BT_SCO : AudioModeGuard.DEVICE_EARPIECE;
            f.permissionPending = (bits & 16) != 0;
            f.msSinceAudioGrant = (bits & 32) != 0 ? 100 : 60_000;
            AudioModeGuard.Action a = AudioModeGuard.decide(ic, f);
            assertTrue("bits " + bits + " gave " + a, a != AudioModeGuard.Action.RESET && a != AudioModeGuard.Action.NONE);
        }
    }

    @Test
    public void captureOutranksTheOtherKeeps() {
        AudioModeGuard.Facts f = quiet();
        f.recordingActive = true; f.glassesScoHeld = true; f.permissionPending = true;
        assertEquals(AudioModeGuard.Action.KEEP_CAPTURE, AudioModeGuard.decide(AudioModeGuard.MODE_IN_COMMUNICATION, f));
    }

    @Test
    public void recentGrantWindowEdges() {
        int ic = AudioModeGuard.MODE_IN_COMMUNICATION;
        AudioModeGuard.Facts f = quiet();
        f.msSinceAudioGrant = AudioModeGuard.GRANT_QUIET_MS - 1;
        assertEquals(AudioModeGuard.Action.KEEP_RECENT_GRANT, AudioModeGuard.decide(ic, f));
        f.msSinceAudioGrant = AudioModeGuard.GRANT_QUIET_MS;
        assertEquals(AudioModeGuard.Action.RESET, AudioModeGuard.decide(ic, f));
        f.msSinceAudioGrant = -5; // clock oddity: treated as "just now"
        assertEquals(AudioModeGuard.Action.KEEP_RECENT_GRANT, AudioModeGuard.decide(ic, f));
    }

    @Test
    public void usageSummaryGroupsByKindAndDevice() {
        int ear = AudioModeGuard.DEVICE_EARPIECE, spk = AudioModeGuard.DEVICE_SPEAKER;
        assertEquals("none", AudioModeGuard.usageSummary(new int[0], new int[0]));
        assertEquals("media@speaker 1", AudioModeGuard.usageSummary(new int[]{ AudioModeGuard.USAGE_MEDIA }, new int[]{ spk }));
        assertEquals("voice@earpiece 2, media@earpiece 1", AudioModeGuard.usageSummary(
                new int[]{ AudioModeGuard.USAGE_VOICE_COMMUNICATION, AudioModeGuard.USAGE_MEDIA, AudioModeGuard.USAGE_VOICE_COMMUNICATION_SIGNALLING },
                new int[]{ ear, ear, ear }));
        assertEquals("media@- 1, media@speaker 1", AudioModeGuard.usageSummary(
                new int[]{ AudioModeGuard.USAGE_MEDIA, AudioModeGuard.USAGE_MEDIA }, new int[]{ -1, spk }));
        assertEquals("other@- 1", AudioModeGuard.usageSummary(new int[]{ 5 }, null));
    }

    @Test
    public void lineForEachVerdict() {
        String tail = " · out: media 1 · rec: none · route: earpiece"; // out: and rec: are passed through as given
        assertEquals("mode normal (was in_communication)" + tail,
                AudioModeGuard.line(AudioModeGuard.Action.RESET, AudioModeGuard.MODE_NORMAL, null, "media 1", "none", AudioModeGuard.DEVICE_EARPIECE));
        assertEquals("mode still in_communication (another owner)" + tail,
                AudioModeGuard.line(AudioModeGuard.Action.RESET, AudioModeGuard.MODE_IN_COMMUNICATION, null, "media 1", "none", AudioModeGuard.DEVICE_EARPIECE));
        assertEquals("reset failed (SecurityException)" + tail,
                AudioModeGuard.line(AudioModeGuard.Action.RESET, AudioModeGuard.MODE_IN_COMMUNICATION, "SecurityException", "media 1", "none", AudioModeGuard.DEVICE_EARPIECE));
        assertEquals("mode normal" + tail,
                AudioModeGuard.line(AudioModeGuard.Action.NONE, AudioModeGuard.MODE_NORMAL, null, "media 1", "none", AudioModeGuard.DEVICE_EARPIECE));
        assertEquals("mode in_call · out: none · rec: none · route: speaker",
                AudioModeGuard.line(AudioModeGuard.Action.NONE, AudioModeGuard.MODE_IN_CALL, null, "none", "none", AudioModeGuard.DEVICE_SPEAKER));
        assertEquals("mode in_communication kept (capture live)" + tail,
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_CAPTURE, AudioModeGuard.MODE_IN_COMMUNICATION, null, "media 1", "none", AudioModeGuard.DEVICE_EARPIECE));
        assertEquals("mode in_communication kept (glasses) · out: none · rec: none · route: bt_sco",
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_GLASSES, AudioModeGuard.MODE_IN_COMMUNICATION, null, "none", "none", AudioModeGuard.DEVICE_BT_SCO));
        assertEquals("mode in_communication kept (bluetooth sco) · out: none · rec: none · route: none",
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_SCO, AudioModeGuard.MODE_IN_COMMUNICATION, null, "none", "none", -1));
        assertEquals("mode in_communication kept (mic prompt) · out: none · rec: none · route: none",
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_PENDING_PERMISSION, AudioModeGuard.MODE_IN_COMMUNICATION, null, "none", "none", -1));
        assertEquals("mode in_communication kept (capture starting) · out: none · rec: none · route: other",
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_RECENT_GRANT, AudioModeGuard.MODE_IN_COMMUNICATION, null, "none", "none", 99));
    }

    @Test
    public void lineFitsThePageRing() {
        String l = AudioModeGuard.line(AudioModeGuard.Action.RESET, AudioModeGuard.MODE_IN_COMMUNICATION,
                "AVeryLongExceptionClassNameThatGoesOnAndOnAndOnForeverAndEverException",
                "media@earpiece 99, voice@earpiece 99, other@bt_a2dp 99, media@speaker 9", "none", AudioModeGuard.DEVICE_EARPIECE);
        assertTrue(l.length() <= 120);
    }

    @Test
    public void theKillSwitchStopsOnlyTheReset() {
        int ic = AudioModeGuard.MODE_IN_COMMUNICATION;
        AudioModeGuard.Facts f = quiet();
        f.guardEnabled = false;
        assertEquals(AudioModeGuard.Action.SKIP_DISABLED, AudioModeGuard.decide(ic, f));
        assertEquals(AudioModeGuard.Action.NONE, AudioModeGuard.decide(AudioModeGuard.MODE_NORMAL, f));
        f.recordingActive = true;
        assertEquals("a keep still reads as a keep", AudioModeGuard.Action.KEEP_CAPTURE, AudioModeGuard.decide(ic, f));
        assertEquals("guard off (would reset in_communication) · out: none · rec: none · route: earpiece",
                AudioModeGuard.line(AudioModeGuard.Action.SKIP_DISABLED, ic, null, "none", "none", AudioModeGuard.DEVICE_EARPIECE));
    }

    @Test
    public void recordingSummaryCountsSources() {
        assertEquals("none", AudioModeGuard.recordingSummary(new int[0]));
        assertEquals("none", AudioModeGuard.recordingSummary(null));
        assertEquals("1 vc", AudioModeGuard.recordingSummary(new int[]{ AudioModeGuard.SOURCE_VOICE_COMMUNICATION }));
        assertEquals("2 vc, 1 vr, 1 mic", AudioModeGuard.recordingSummary(new int[]{
                AudioModeGuard.SOURCE_VOICE_COMMUNICATION, AudioModeGuard.SOURCE_VOICE_RECOGNITION,
                AudioModeGuard.SOURCE_VOICE_COMMUNICATION, AudioModeGuard.SOURCE_MIC }));
        assertEquals("1 other", AudioModeGuard.recordingSummary(new int[]{ 1999 }));
        assertEquals("mode in_communication kept (capture live) · out: none · rec: 1 vc · route: earpiece",
                AudioModeGuard.line(AudioModeGuard.Action.KEEP_CAPTURE, AudioModeGuard.MODE_IN_COMMUNICATION, null, "none", "1 vc", AudioModeGuard.DEVICE_EARPIECE));
    }

    @Test
    public void captureWithoutCallModeLine() {
        assertEquals("capture without call mode (normal) · rec: 1 vc",
                AudioModeGuard.captureWithoutCallModeLine(AudioModeGuard.MODE_NORMAL, "1 vc"));
    }

    @Test
    public void portAcceptsOnlyTheThreeExactOps() {
        assertEquals(AudioModeGuard.PortOp.CAPTURE_STARTING, AudioModeGuard.parsePortMessage("{\"op\":\"captureStarting\"}"));
        assertNull(AudioModeGuard.parsePortMessage("{\"op\":\"capturestarting\"}"));
    }

    @Test
    public void portAcceptsOnlyTheTwoExactOps() {
        assertEquals(AudioModeGuard.PortOp.HELLO, AudioModeGuard.parsePortMessage("{\"op\":\"hello\"}"));
        assertEquals(AudioModeGuard.PortOp.CAPTURE_ENDED, AudioModeGuard.parsePortMessage("{\"op\":\"captureEnded\"}"));
        assertEquals(AudioModeGuard.PortOp.CAPTURE_ENDED, AudioModeGuard.parsePortMessage(" { \"op\" : \"captureEnded\" } "));
    }

    @Test
    public void portRefusesEverythingElse() {
        String[] bad = {
                null, "", "hello", "null", "[]", "{}", "{\"op\":\"HELLO\"}", "{\"op\":\"setMode\"}",
                "{\"op\":1}", "{\"op\":\"hello\",\"x\":1}", "{\"op\":\"hello\"}{}", "{\"op\":\"hello\"",
                "{'op':'hello'}", "{\"op\":\"hel\\u006co\"}",
                "{\"op\":\"captureEnded\"" + " ".repeat(200) + "}",
        };
        for (String s : bad) assertNull(String.valueOf(s), AudioModeGuard.parsePortMessage(s));
    }
}
