package press.maestro.crow;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ComponentName;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.service.quicksettings.TileService;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.TimeUnit;

/**
 * Foreground service that owns the paired glasses' session WebSocket plus
 * the Bluetooth audio routing. One instance per paired device.
 *
 * Responsibilities (per PR 3 plan):
 *   - Open a WSS connection to /api/meta-glasses/session with the stored
 *     bearer token.
 *   - Route the glasses' microphone audio (BT SCO HFP) into the WebSocket
 *     as binary frames during a turn.
 *   - Decode TTS audio from the server and play it back via AudioTrack,
 *     routed to the BT A2DP output (the glasses' speakers).
 *   - Host the in-app push-to-talk button callback (wired from MainActivity
 *     or a notification action) and the optional WakeWordEngine.
 *
 * BT SCO / HFP mic capture + AudioTrack playback are sketched here — the
 * actual microphone reader loop is a TODO because it depends on the
 * codec framing the paired phone's Bluetooth stack presents. On most
 * Android 14+ devices the glasses mic arrives as 16 kHz mono PCM once
 * `AudioManager.startBluetoothSco()` completes.
 */
public class GlassesService extends Service {
    public static final String EXTRA_DEVICE_ID = "device_id";
    public static final String ACTION_BEGIN_TURN = "press.maestro.crow.BEGIN_TURN";
    public static final String ACTION_END_TURN = "press.maestro.crow.END_TURN";

    private static final String TAG = "GlassesService";
    private static final String CHANNEL_ID = "glasses_service";
    private static final int NOTIFICATION_ID = 8414;

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";

    private OkHttpClient http;
    private WebSocket ws;
    private AudioManager audioManager;
    private AudioTrack audioTrack;
    private String deviceId;
    private volatile boolean inTurn = false;
    // Reconnect bookkeeping. `stopping` is set in onDestroy so our own
    // close() doesn't trigger a reconnect loop. `reconnectPending` prevents
    // stacking multiple pending reconnects if both onClosed and onFailure
    // fire for the same event.
    private volatile boolean stopping = false;
    private volatile boolean reconnectPending = false;
    private volatile boolean connecting = false;
    private long ttsStartNanos = 0;
    private long ttsBytesReceived = 0;
    // PCM chunks arriving between tts_start/tts_end are accumulated here,
    // then written to a MODE_STATIC AudioTrack at tts_end. MODE_STREAM
    // behaves unreliably when the gateway blasts data faster than the
    // A2DP output can warm up — playback head stays at 0 frames even
    // though write() accepted everything.
    private ByteArrayOutputStream ttsBuffer;
    private int ttsSampleRate = 24000;
    // Mic capture — AudioRecord reads 20 ms frames of 16 kHz mono s16 PCM
    // from BT SCO (glasses mic via HFP) and posts them to the WS.
    private static final int MIC_SAMPLE_RATE = 16000;
    private AudioRecord micRecord;
    private Thread micThread;
    private volatile boolean micRunning = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        http = new OkHttpClient.Builder()
                .pingInterval(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Android requires startForeground() within ~5 s of every
        // startForegroundService(). Call it FIRST on every entry so the
        // action-short-circuit paths (ACTION_BEGIN_TURN from QS tile etc.)
        // don't trip ForegroundServiceDidNotStartInTimeException. Subsequent
        // startForeground calls for the same id are no-ops.
        // Resolve deviceId from intent first (if provided) or fall back to
        // the first paired device so the service can self-hydrate when
        // invoked by the tile/shortcut without explicit extras.
        if (intent != null && intent.hasExtra(EXTRA_DEVICE_ID)) {
            deviceId = intent.getStringExtra(EXTRA_DEVICE_ID);
        }
        if (deviceId == null) {
            java.util.Set<String> ids = GlassesTokenStore.listDeviceIds(this);
            if (!ids.isEmpty()) deviceId = ids.iterator().next();
        }
        startForeground(NOTIFICATION_ID, buildNotification("Connecting to glasses..."));
        if (deviceId == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent == null ? null : intent.getAction();
        if (ACTION_BEGIN_TURN.equals(action)) {
            if (ws == null) connectWebSocket();
            beginTurn();
            return START_STICKY;
        }
        if (ACTION_END_TURN.equals(action)) {
            endTurn();
            return START_STICKY;
        }
        if (ws == null) connectWebSocket();
        return START_STICKY;
    }

    /** Called by the in-app PTT button or WakeWordEngine when user starts speaking. */
    public void beginTurn() {
        if (ws == null) { Log.w(TAG, "beginTurn: ws is null"); return; }
        if (inTurn) { Log.w(TAG, "beginTurn: already in turn"); return; }
        Log.i(TAG, "beginTurn");
        inTurn = true;
        updateNotification("Listening...");
        syncPttState(true);
        JSONObject msg = new JSONObject();
        try {
            msg.put("type", "turn_start");
            msg.put("trigger", "button");
        } catch (Exception ignored) {}
        ws.send(msg.toString());
        // Start BT SCO so the glasses mic becomes the active audio source.
        audioManager.startBluetoothSco();
        audioManager.setBluetoothScoOn(true);
        startMicPump();
    }

    /** Called when the user releases the PTT button / wake-word confirms end. */
    public void endTurn() {
        if (!inTurn) { Log.w(TAG, "endTurn: not in turn"); return; }
        Log.i(TAG, "endTurn");
        inTurn = false;
        updateNotification("Connected");
        syncPttState(false);
        stopMicPump();
        audioManager.setBluetoothScoOn(false);
        audioManager.stopBluetoothSco();
        if (ws != null) ws.send("{\"type\":\"turn_end\"}");
    }

    /**
     * Open an AudioRecord on the BT SCO mic (glasses via HFP, handed to us
     * after {@link AudioManager#startBluetoothSco()} completes) and forward
     * 20 ms PCM frames to the WebSocket as binary frames until the turn ends.
     *
     * The DAT SDK 0.5.0 doesn't expose a mic API, so we rely on the
     * standard Android BT HFP pipeline. If SCO isn't actually wired to the
     * glasses mic (e.g. because Meta AI holds it), this captures the phone
     * mic instead — audible but not spatial-to-glasses. Something we'll
     * validate when DAT exposes a first-class mic surface.
     */
    private void startMicPump() {
        if (micRunning) return;
        int minBuf = AudioRecord.getMinBufferSize(MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuf <= 0) {
            Log.w(TAG, "AudioRecord.getMinBufferSize failed: " + minBuf);
            return;
        }
        // Use a 1 s internal buffer so SCO warmup/wakelock hiccups don't drop
        // samples; read 20 ms frames to the WS.
        int bufSize = Math.max(minBuf, MIC_SAMPLE_RATE * 2);
        try {
            micRecord = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MIC_SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize);
        } catch (SecurityException e) {
            Log.w(TAG, "AudioRecord denied (RECORD_AUDIO): " + e.getMessage());
            return;
        }
        if (micRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "AudioRecord not initialized");
            try { micRecord.release(); } catch (Exception ignored) {}
            micRecord = null;
            return;
        }
        micRecord.startRecording();
        micRunning = true;
        micThread = new Thread(() -> {
            // 20 ms frames = 320 samples = 640 bytes at 16 kHz mono s16.
            byte[] buf = new byte[640];
            long framesSent = 0;
            while (micRunning) {
                int n = micRecord.read(buf, 0, buf.length);
                if (n <= 0) {
                    if (n == AudioRecord.ERROR_INVALID_OPERATION || n == AudioRecord.ERROR_BAD_VALUE) {
                        Log.w(TAG, "AudioRecord.read err=" + n);
                        break;
                    }
                    continue;
                }
                if (ws != null) {
                    byte[] frame = (n == buf.length) ? buf : java.util.Arrays.copyOf(buf, n);
                    ws.send(ByteString.of(frame));
                    framesSent++;
                }
            }
            Log.i(TAG, "mic pump stopped, frames_sent=" + framesSent);
        }, "mic-pump");
        micThread.start();
        Log.i(TAG, "mic pump started (16 kHz mono PCM, 20 ms frames)");
    }

    /**
     * Handle a capture_photo request from the gateway: use DatBridge to grab
     * a still via StreamSession, upload it to the gateway, and reply on the
     * same WebSocket with a photo_ready message (or photo_error on failure).
     */
    private void handleCapturePhoto(final String reqId) {
        Log.i(TAG, "capture_photo request_id=" + reqId);
        press.maestro.crow.dat.DatBridge.capturePhoto(this, new press.maestro.crow.dat.DatBridge.PhotoListener() {
            @Override public void onPhoto(byte[] bytes, String mime) {
                Log.i(TAG, "capture_photo ok bytes=" + bytes.length + " mime=" + mime);
                uploadPhotoAsync(reqId, bytes, mime);
            }
            @Override public void onError(String code, String message) {
                Log.w(TAG, "capture_photo err code=" + code + " msg=" + message);
                try {
                    JSONObject e = new JSONObject();
                    e.put("type", "photo_error");
                    e.put("request_id", reqId);
                    e.put("code", code);
                    e.put("message", message);
                    if (ws != null) ws.send(e.toString());
                } catch (Exception ignored) {}
            }
        });
    }

    private void uploadPhotoAsync(String reqId, byte[] bytes, String mime) {
        new Thread(() -> {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String gateway = prefs.getString(KEY_GATEWAY_URL, null);
            if (gateway == null) return;
            String token = GlassesTokenStore.load(this, deviceId);
            if (token == null) return;
            String base = gateway.replaceAll("/+$", "");
            String ext = mime.endsWith("heic") ? "heic" : "jpg";
            String url = base + "/api/meta-glasses/photo?device_id=" + deviceId + "&request_id=" + reqId + "&ext=" + ext;
            try {
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Content-Type", mime);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream os = conn.getOutputStream()) { os.write(bytes); }
                int code = conn.getResponseCode();
                String body = new String(code >= 200 && code < 300 ? conn.getInputStream().readAllBytes() : conn.getErrorStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                Log.i(TAG, "photo upload http=" + code + " body=" + body);
                JSONObject reply = new JSONObject();
                if (code >= 200 && code < 300) {
                    JSONObject parsed = new JSONObject(body);
                    reply.put("type", "photo_ready");
                    reply.put("request_id", reqId);
                    reply.put("url", parsed.optString("url"));
                    reply.put("mime", mime);
                } else {
                    reply.put("type", "photo_error");
                    reply.put("request_id", reqId);
                    reply.put("code", "upload_failed");
                    reply.put("message", "HTTP " + code);
                }
                if (ws != null) ws.send(reply.toString());
            } catch (Exception e) {
                Log.w(TAG, "photo upload failed: " + e.getMessage());
                try {
                    JSONObject err = new JSONObject();
                    err.put("type", "photo_error");
                    err.put("request_id", reqId);
                    err.put("code", "upload_failed");
                    err.put("message", e.getMessage() == null ? "io error" : e.getMessage());
                    if (ws != null) ws.send(err.toString());
                } catch (Exception ignored) {}
            }
        }, "photo-upload").start();
    }

    private void stopMicPump() {
        micRunning = false;
        Thread t = micThread;
        micThread = null;
        if (t != null) {
            try { t.join(500); } catch (InterruptedException ignored) {}
        }
        if (micRecord != null) {
            try { micRecord.stop(); } catch (Exception ignored) {}
            try { micRecord.release(); } catch (Exception ignored) {}
            micRecord = null;
        }
    }

    private synchronized void connectWebSocket() {
        if (stopping) return;
        if (connecting) { Log.i(TAG, "connectWebSocket: already connecting"); return; }
        if (ws != null) { Log.i(TAG, "connectWebSocket: already have ws"); return; }
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String gateway = prefs.getString(KEY_GATEWAY_URL, null);
        if (gateway == null) { stopSelf(); return; }
        String token = GlassesTokenStore.load(this, deviceId);
        if (token == null) { stopSelf(); return; }
        connecting = true;

        String wsUrl = gateway.replaceFirst("^http", "ws").replaceAll("/+$", "")
                + "/api/meta-glasses/session?device_id=" + deviceId;
        Request req = new Request.Builder()
                .url(wsUrl)
                .header("Authorization", "Bearer " + token)
                .build();

        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                connecting = false;
                Log.i(TAG, "WebSocket open for " + deviceId);
                JSONObject hello = new JSONObject();
                try {
                    hello.put("type", "hello");
                    hello.put("codec", "pcm");
                    hello.put("sample_rate", 16000);
                    hello.put("device_id", deviceId);
                } catch (Exception ignored) {}
                webSocket.send(hello.toString());
                updateNotification("Connected");
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    String type = msg.optString("type", "");
                    switch (type) {
                        case "ready":
                            Log.i(TAG, "session ready: " + msg.optString("session_id"));
                            break;
                        case "tts_start":
                            ttsSampleRate = msg.optInt("sample_rate", 24000);
                            Log.i(TAG, "tts_start codec=" + msg.optString("codec") + " sr=" + ttsSampleRate);
                            ttsStartNanos = System.nanoTime();
                            ttsBytesReceived = 0;
                            ttsBuffer = new ByteArrayOutputStream(64 * 1024);
                            break;
                        case "tts_end":
                            long elapsedMs = (System.nanoTime() - ttsStartNanos) / 1_000_000L;
                            Log.i(TAG, "tts_end bytes=" + ttsBytesReceived + " elapsed=" + elapsedMs + "ms");
                            playTtsBuffer();
                            break;
                        case "transcript_final":
                            Log.i(TAG, "transcript: " + msg.optString("text"));
                            break;
                        case "remote_turn":
                            // Nest panel (or any authed caller) driving PTT.
                            String action = msg.optString("action");
                            if ("begin".equals(action)) beginTurn();
                            else if ("end".equals(action)) endTurn();
                            break;
                        case "capture_photo":
                            String reqId = msg.optString("request_id", "");
                            handleCapturePhoto(reqId);
                            break;
                        case "error":
                            Log.w(TAG, "server error: " + msg.optString("code") + " " + msg.optString("message"));
                            break;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "bad text frame: " + e.getMessage());
                }
            }

            @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                // Binary frame → TTS PCM chunk. Accumulate; we'll hand the
                // full buffer to a MODE_STATIC AudioTrack at tts_end.
                if (ttsBuffer != null) {
                    byte[] data = bytes.toByteArray();
                    try { ttsBuffer.write(data); } catch (Exception e) { Log.w(TAG, "ttsBuffer.write err=" + e.getMessage()); }
                    ttsBytesReceived += data.length;
                }
            }

            @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                Log.i(TAG, "WebSocket closing: " + code + " " + reason);
                webSocket.close(1000, null);
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                Log.i(TAG, "WebSocket closed: " + code + " " + reason);
                if (ws == webSocket) ws = null;
                // Gateway restart triggers a clean 1000 close — OkHttp
                // doesn't re-establish, so we must. Skip if we're shutting
                // down ourselves.
                scheduleReconnect(2000);
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                connecting = false;
                Log.w(TAG, "WebSocket failed: " + t.getMessage());
                updateNotification("Disconnected — retrying");
                if (ws == webSocket) ws = null;
                scheduleReconnect(5000);
            }
        });
    }

    private void scheduleReconnect(long delayMs) {
        if (stopping || reconnectPending) return;
        reconnectPending = true;
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            reconnectPending = false;
            if (stopping) return;
            Log.i(TAG, "Attempting WebSocket reconnect...");
            connectWebSocket();
        }, delayMs);
    }

    /** Play the accumulated TTS PCM buffer via a MODE_STATIC AudioTrack. */
    private synchronized void playTtsBuffer() {
        closeAudioTrack();
        if (ttsBuffer == null) return;
        byte[] pcm = ttsBuffer.toByteArray();
        ttsBuffer = null;
        if (pcm.length < 2) return;

        audioTrack = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setSampleRate(ttsSampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build())
                .setBufferSizeInBytes(pcm.length)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build();
        int written = audioTrack.write(pcm, 0, pcm.length);
        Log.i(TAG, "playTtsBuffer wrote " + written + "/" + pcm.length + " bytes");
        if (written > 0) {
            try { audioTrack.play(); } catch (Exception e) { Log.w(TAG, "play err=" + e.getMessage()); }
        }
    }

    private synchronized void closeAudioTrack() {
        if (audioTrack == null) return;
        final AudioTrack t = audioTrack;
        audioTrack = null;
        // Handoff to a short-lived thread so the WebSocket thread isn't blocked
        // while the track drains whatever's still buffered. MODE_STREAM stop()
        // plays the buffered samples to completion, but if we call release()
        // right after stop() we can truncate playback (exactly what was cutting
        // off the last ~1 s of every TTS utterance). Poll the playback head
        // until it stops advancing, then release.
        new Thread(() -> {
            try { t.stop(); } catch (Exception ignored) {}
            int last = -1, stable = 0;
            long deadline = System.currentTimeMillis() + 15000; // hard cap
            while (System.currentTimeMillis() < deadline && stable < 5) {
                try { Thread.sleep(100); } catch (InterruptedException ignored) {}
                int pos;
                try { pos = t.getPlaybackHeadPosition(); } catch (Exception e) { break; }
                if (pos == last) stable++; else { stable = 0; last = pos; }
            }
            Log.i(TAG, "audio drain done, final head=" + last);
            try { t.release(); } catch (Exception ignored) {}
        }, "audio-drain").start();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Paired Glasses", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Maintains connection to paired Meta Ray-Ban glasses.");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent beginIntent = new Intent(this, GlassesService.class).setAction(ACTION_BEGIN_TURN);
        Intent endIntent = new Intent(this, GlassesService.class).setAction(ACTION_END_TURN);
        PendingIntent beginPi = PendingIntent.getForegroundService(this, 1, beginIntent, flags);
        PendingIntent endPi = PendingIntent.getForegroundService(this, 2, endIntent, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Crow Glasses")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        if (inTurn) {
            b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", endPi);
        } else {
            b.addAction(android.R.drawable.ic_btn_speak_now, "Ask Crow", beginPi);
        }
        return b.build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NotificationID(), buildNotification(text));
    }

    private int NotificationID() { return NOTIFICATION_ID; }

    /** Mirror turn state into the prefs the QS tile reads, and poke the tile. */
    private void syncPttState(boolean turnActive) {
        getSharedPreferences(CrowPttTileService.PTT_PREFS, MODE_PRIVATE)
                .edit().putBoolean(CrowPttTileService.KEY_IN_TURN, turnActive).apply();
        try {
            TileService.requestListeningState(this, new ComponentName(this, CrowPttTileService.class));
        } catch (Throwable ignored) {}
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopping = true;
        stopMicPump();
        try { if (ws != null) ws.close(1000, "service_stop"); } catch (Exception ignored) {}
        ws = null;
        closeAudioTrack();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
