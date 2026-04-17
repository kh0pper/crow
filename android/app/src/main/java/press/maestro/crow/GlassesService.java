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
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.service.quicksettings.TileService;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;
import androidx.media.app.NotificationCompat.MediaStyle;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
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
    public static final String ACTION_MEDIA_TOGGLE = "press.maestro.crow.MEDIA_TOGGLE";
    public static final String ACTION_MEDIA_STOP = "press.maestro.crow.MEDIA_STOP";
    public static final String ACTION_MEDIA_NEXT = "press.maestro.crow.MEDIA_NEXT";

    private static final String TAG = "GlassesService";
    private static final String CHANNEL_ID = "glasses_service";
    private static final int NOTIFICATION_ID = 8414;
    private static final int MEDIA_NOTIFICATION_ID = 8415;

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

    // Phase 4 audio_stream (music / podcast / etc. compressed audio).
    // Binary frames between audio_stream_start/audio_stream_end are routed
    // to a temp file; after _end we MediaExtractor + MediaCodec decode to
    // PCM and play via a separate AudioTrack (musicTrack), so TTS (ttsTrack
    // via audioTrack field above, USAGE_MEDIA / CONTENT_TYPE_SPEECH) and
    // music don't collide. When TTS arrives during music playback we duck
    // musicTrack to 25 % for the TTS utterance.
    private static final int INBOUND_TTS = 0;
    private static final int INBOUND_STREAM = 1;
    private volatile int currentInboundMode = INBOUND_TTS;
    private AudioTrack musicTrack;
    private File streamFile;
    private FileOutputStream streamFileOut;
    private String streamCodec;
    private int streamSampleRateHint;
    private int streamChannelsHint;
    private Thread streamDecoderThread;
    private volatile boolean streamDecoding = false;
    private volatile boolean musicPaused = false;
    private MediaSessionCompat mediaSession;
    private volatile String currentTrackTitle;
    private volatile String currentTrackArtist;
    private volatile String currentArtworkUrl;
    private volatile Bitmap currentArtworkBitmap;
    private volatile boolean mediaActive = false;
    // Outstanding TTS utterances whose drain hasn't completed yet. Tracked
    // so back-to-back TTS doesn't un-duck music in the middle of utterance N+1
    // because utterance N's drain finished. duckMusic(true) increments,
    // drain completion decrements; hitting 0 restores the music volume.
    private final java.util.concurrent.atomic.AtomicInteger pendingTtsDucks =
        new java.util.concurrent.atomic.AtomicInteger(0);

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        NotificationHelper.createChannels(this); // ensure CHANNEL_MEDIA exists
        http = new OkHttpClient.Builder()
                .pingInterval(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        // MediaSession for standard Android media controls (shade, lockscreen,
        // QS player card on 13+, BT AVRCP)
        mediaSession = new MediaSessionCompat(this, "CrowGlasses");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            // BT AVRCP sends discrete play/pause KeyEvents, not a toggle. Guard
            // each callback so a redundant "play" while already playing doesn't pause.
            @Override public void onPlay() {
                if (musicPaused) {
                    resumeMusicTrack();
                    sendMediaControlToGateway("resume");
                }
            }
            @Override public void onPause() {
                if (!musicPaused && mediaActive) {
                    pauseMusicTrack();
                    sendMediaControlToGateway("pause");
                }
            }
            @Override public void onStop()       { handleMediaStop(); }
            @Override public void onSkipToNext() { handleMediaNext(); }
        });
        mediaSession.setMediaButtonReceiver(
            MediaButtonReceiver.buildMediaButtonPendingIntent(this,
                PlaybackStateCompat.ACTION_PLAY_PAUSE));
        publishPlaybackState(PlaybackStateCompat.STATE_NONE);
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
        if (ACTION_MEDIA_TOGGLE.equals(action)) { handleMediaToggle(); return START_STICKY; }
        if (ACTION_MEDIA_STOP.equals(action))   { handleMediaStop();   return START_STICKY; }
        if (ACTION_MEDIA_NEXT.equals(action))   { handleMediaNext();   return START_STICKY; }
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
                            currentInboundMode = INBOUND_TTS;
                            duckMusic(true);
                            break;
                        case "tts_end":
                            long elapsedMs = (System.nanoTime() - ttsStartNanos) / 1_000_000L;
                            Log.i(TAG, "tts_end bytes=" + ttsBytesReceived + " elapsed=" + elapsedMs + "ms");
                            playTtsBuffer();
                            // Ducking is released at the end of TTS playback in playTtsBuffer's
                            // drain thread; for now schedule a fallback restore if playback fails.
                            break;
                        case "audio_stream_start": {
                            // org.json optString(key,null) returns "null" string for
                            // explicit-null JSON values; guard with isNull/has.
                            String title   = (msg.has("title")       && !msg.isNull("title"))       ? msg.optString("title",       null) : null;
                            String artist  = (msg.has("artist")      && !msg.isNull("artist"))      ? msg.optString("artist",      null) : null;
                            String artwork = (msg.has("artwork_url") && !msg.isNull("artwork_url")) ? msg.optString("artwork_url", null) : null;
                            beginStream(
                                msg.optString("codec", "mp3"),
                                msg.optInt("sample_rate", 0),
                                msg.optInt("channels", 0),
                                title, artist, artwork
                            );
                            break;
                        }
                        case "audio_stream_end":
                            endStream(msg.optBoolean("ok", true), msg.optString("error", null));
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
                        case "media_control": {
                            String ctlAction = msg.optString("action", "");
                            Log.i(TAG, "media_control action=" + ctlAction);
                            if ("stop".equals(ctlAction)) {
                                closeMusicTrack();
                            } else if ("pause".equals(ctlAction)) {
                                pauseMusicTrack();
                            } else if ("resume".equals(ctlAction)) {
                                resumeMusicTrack();
                            }
                            break;
                        }
                        case "error":
                            Log.w(TAG, "server error: " + msg.optString("code") + " " + msg.optString("message"));
                            break;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "bad text frame: " + e.getMessage());
                }
            }

            @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] data = bytes.toByteArray();
                if (currentInboundMode == INBOUND_STREAM && streamFileOut != null) {
                    try {
                        streamFileOut.write(data);
                    } catch (Exception e) {
                        Log.w(TAG, "streamFileOut.write err=" + e.getMessage());
                    }
                    return;
                }
                // Default: TTS PCM chunk — accumulate; we'll hand the full
                // buffer to a MODE_STATIC AudioTrack at tts_end.
                if (ttsBuffer != null) {
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
        if (pcm.length < 2) { duckMusic(false); return; }

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

    /**
     * Handle audio_stream_start: open a temp file for incoming binary frames
     * and switch the inbound-mode router to STREAM. Any prior music playback
     * is stopped and any prior stream temp file is released so overlapping
     * starts don't leak.
     */
    private synchronized void beginStream(String codec, int sampleRateHint, int channelsHint,
                                           String title, String artist, String artworkUrl) {
        closeMusicTrack();
        releaseStreamFile();
        streamCodec = (codec == null || codec.isEmpty()) ? "mp3" : codec.toLowerCase();
        streamSampleRateHint = sampleRateHint;
        streamChannelsHint = channelsHint;
        try {
            streamFile = File.createTempFile("crow-stream-", "." + streamCodec, getCacheDir());
            streamFileOut = new FileOutputStream(streamFile);
            currentInboundMode = INBOUND_STREAM;
            Log.i(TAG, "audio_stream_start codec=" + streamCodec + " sr=" + sampleRateHint + " ch=" + channelsHint + " file=" + streamFile.getName());
            // Media metadata + notification
            currentTrackTitle = title;
            currentTrackArtist = artist;
            if (artworkUrl != null && !artworkUrl.equals(currentArtworkUrl)) {
                currentArtworkUrl = artworkUrl;
                currentArtworkBitmap = null;
                fetchArtworkAsync(artworkUrl);
            } else if (artworkUrl == null) {
                currentArtworkUrl = null;
                currentArtworkBitmap = null;
            }
            publishMetadata(title, artist, currentArtworkBitmap);
            publishPlaybackState(PlaybackStateCompat.STATE_BUFFERING);
            postMediaNotification();
        } catch (Exception e) {
            Log.w(TAG, "beginStream failed: " + e.getMessage());
            releaseStreamFile();
            currentInboundMode = INBOUND_TTS;
        }
    }

    /**
     * Handle audio_stream_end: close the temp file and (on ok=true) fire a
     * background decoder thread that does MediaExtractor + MediaCodec →
     * musicTrack. Inbound-mode router is reset to TTS.
     */
    private synchronized void endStream(boolean ok, String error) {
        final File file = streamFile;
        final FileOutputStream out = streamFileOut;
        streamFile = null;
        streamFileOut = null;
        currentInboundMode = INBOUND_TTS;
        if (out != null) { try { out.close(); } catch (Exception ignored) {} }
        if (!ok || file == null) {
            Log.w(TAG, "audio_stream_end ok=" + ok + " error=" + error);
            if (file != null) { try { file.delete(); } catch (Exception ignored) {} }
            return;
        }
        Log.i(TAG, "audio_stream_end bytes=" + file.length() + " — decoding");
        streamDecoderThread = new Thread(() -> decodeAndPlayStream(file), "stream-decoder");
        streamDecoding = true;
        streamDecoderThread.start();
    }

    /**
     * Decode the temp file via MediaExtractor + MediaCodec and pump PCM into
     * a streaming AudioTrack (musicTrack). Uses the first audio track found.
     * Supports any codec the device's MediaCodec decodes from a container
     * MediaExtractor recognises (mp3, aac/m4a, ogg/vorbis, opus, flac).
     */
    private void decodeAndPlayStream(File file) {
        MediaExtractor extractor = null;
        MediaCodec codec = null;
        AudioTrack track = null;
        long framesDecoded = 0;
        try {
            extractor = new MediaExtractor();
            extractor.setDataSource(file.getAbsolutePath());
            int audioTrackIdx = -1;
            MediaFormat inputFormat = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat fmt = extractor.getTrackFormat(i);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    audioTrackIdx = i;
                    inputFormat = fmt;
                    break;
                }
            }
            if (audioTrackIdx < 0 || inputFormat == null) {
                Log.w(TAG, "decodeAndPlayStream: no audio track found");
                return;
            }
            extractor.selectTrack(audioTrackIdx);
            String mime = inputFormat.getString(MediaFormat.KEY_MIME);
            int sampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            Log.i(TAG, "stream decode: mime=" + mime + " sr=" + sampleRate + " ch=" + channels);

            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(inputFormat, null, null, 0);
            codec.start();

            int channelMask = (channels == 1) ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
            int minBuf = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT);
            int trackBuf = Math.max(minBuf, sampleRate * 2 * channels); // ~1 s safety
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(sampleRate)
                            .setChannelMask(channelMask)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .build())
                    .setBufferSizeInBytes(trackBuf)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            synchronized (this) { musicTrack = track; }
            if (pendingTtsDucks.get() > 0) {
                try { track.setVolume(0.25f); } catch (Exception ignored) {}
            }
            track.play();
            publishPlaybackState(PlaybackStateCompat.STATE_PLAYING);
            new Handler(getMainLooper()).post(this::updateMediaNotification);

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean sawInputEOS = false;
            boolean sawOutputEOS = false;
            while (!sawOutputEOS && streamDecoding) {
                if (musicPaused) {
                    try { Thread.sleep(100); } catch (InterruptedException ignored) {}
                    continue;
                }
                if (!sawInputEOS) {
                    int inIdx = codec.dequeueInputBuffer(10_000);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIdx);
                        if (inBuf == null) continue;
                        int size = extractor.readSampleData(inBuf, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            sawInputEOS = true;
                        } else {
                            long pts = extractor.getSampleTime();
                            codec.queueInputBuffer(inIdx, 0, size, pts, 0);
                            extractor.advance();
                        }
                    }
                }
                int outIdx = codec.dequeueOutputBuffer(info, 10_000);
                if (outIdx >= 0) {
                    ByteBuffer outBuf = codec.getOutputBuffer(outIdx);
                    if (outBuf != null && info.size > 0) {
                        byte[] pcm = new byte[info.size];
                        outBuf.position(info.offset);
                        outBuf.get(pcm, 0, info.size);
                        // Track may have been released by a concurrent stop.
                        AudioTrack t = musicTrack;
                        if (t != null) {
                            try { t.write(pcm, 0, pcm.length); } catch (IllegalStateException ignored) {}
                            framesDecoded += pcm.length / (2 * channels);
                        }
                    }
                    codec.releaseOutputBuffer(outIdx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) sawOutputEOS = true;
                }
                // outIdx == INFO_TRY_AGAIN_LATER etc. are fine — retry loop.
            }
            Log.i(TAG, "stream decode done, frames=" + framesDecoded);
        } catch (Exception e) {
            Log.w(TAG, "decodeAndPlayStream err: " + e.getMessage());
        } finally {
            streamDecoding = false;
            if (codec != null) { try { codec.stop(); } catch (Exception ignored) {} try { codec.release(); } catch (Exception ignored) {} }
            if (extractor != null) { try { extractor.release(); } catch (Exception ignored) {} }
            // Drain + release the track in-place (background thread is fine).
            if (track != null) {
                try { track.stop(); } catch (Exception ignored) {}
                try { track.release(); } catch (Exception ignored) {}
                synchronized (this) { if (musicTrack == track) musicTrack = null; }
            }
            try { file.delete(); } catch (Exception ignored) {}
            // Tell the gateway this track has finished playing so it can
            // pull the next one off the queue (album playback).
            try {
                WebSocket socket = ws;
                if (socket != null) {
                    JSONObject done = new JSONObject();
                    done.put("type", "audio_stream_done");
                    socket.send(done.toString());
                }
            } catch (Exception ignored) {}
        }
    }

    private synchronized void closeMusicTrack() {
        streamDecoding = false;
        musicPaused = false;
        Thread t = streamDecoderThread;
        streamDecoderThread = null;
        // The decoder thread will stop + release its own AudioTrack when
        // streamDecoding flips to false. Give it a brief moment to exit so
        // overlapping begin/end calls don't race; don't block the WS thread.
        AudioTrack mt = musicTrack;
        musicTrack = null;
        if (mt != null) {
            try { mt.stop(); } catch (Exception ignored) {}
            try { mt.release(); } catch (Exception ignored) {}
        }
        if (t != null) {
            new Thread(() -> { try { t.join(500); } catch (InterruptedException ignored) {} }, "stream-decoder-join").start();
        }
        currentTrackTitle = null;
        currentTrackArtist = null;
        currentArtworkUrl = null;
        currentArtworkBitmap = null;
        // Only publish STOPPED + clear notification if the media UI was actually
        // active — avoids flicker when beginStream calls closeMusicTrack() to
        // replace the current track with a new one.
        if (mediaActive) {
            publishPlaybackState(PlaybackStateCompat.STATE_STOPPED);
            clearMediaNotification();
        }
    }

    private synchronized void pauseMusicTrack() {
        AudioTrack t = musicTrack;
        if (t != null && streamDecoding) {
            musicPaused = true;
            try { t.pause(); } catch (Exception ignored) {}
            Log.i(TAG, "music paused");
            publishPlaybackState(PlaybackStateCompat.STATE_PAUSED);
            updateMediaNotification();
        }
    }

    private synchronized void resumeMusicTrack() {
        AudioTrack t = musicTrack;
        if (t != null && streamDecoding) {
            musicPaused = false;
            try { t.play(); } catch (Exception ignored) {}
            Log.i(TAG, "music resumed");
            publishPlaybackState(PlaybackStateCompat.STATE_PLAYING);
            updateMediaNotification();
        }
    }

    private synchronized void releaseStreamFile() {
        if (streamFileOut != null) { try { streamFileOut.close(); } catch (Exception ignored) {} streamFileOut = null; }
        if (streamFile != null) { try { streamFile.delete(); } catch (Exception ignored) {} streamFile = null; }
    }

    // --- MediaSession + MediaStyle notification ---

    private void handleMediaToggle() {
        if (musicPaused) {
            resumeMusicTrack();
            sendMediaControlToGateway("resume");
        } else {
            pauseMusicTrack();
            sendMediaControlToGateway("pause");
        }
    }

    private void handleMediaStop() {
        sendMediaControlToGateway("stop");
        closeMusicTrack();
    }

    private void handleMediaNext() {
        publishPlaybackState(PlaybackStateCompat.STATE_SKIPPING_TO_NEXT);
        sendMediaControlToGateway("next");
    }

    private void sendMediaControlToGateway(String action) {
        WebSocket socket = ws;
        if (socket == null) return;
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "media_control");
            msg.put("action", action);
            socket.send(msg.toString());
        } catch (Exception ignored) {}
    }

    private void publishPlaybackState(int state) {
        if (mediaSession == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
                     | PlaybackStateCompat.ACTION_PAUSE
                     | PlaybackStateCompat.ACTION_PLAY_PAUSE
                     | PlaybackStateCompat.ACTION_STOP
                     | PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        PlaybackStateCompat ps = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
            .build();
        mediaSession.setPlaybackState(ps);
        mediaSession.setActive(state == PlaybackStateCompat.STATE_PLAYING
                            || state == PlaybackStateCompat.STATE_PAUSED
                            || state == PlaybackStateCompat.STATE_BUFFERING
                            || state == PlaybackStateCompat.STATE_SKIPPING_TO_NEXT);
    }

    private void publishMetadata(String title, String artist, Bitmap art) {
        if (mediaSession == null) return;
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE,  title  == null ? "" : title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist == null ? "" : artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ARTIST, artist == null ? "" : artist);
        if (art != null) {
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, art);
        }
        mediaSession.setMetadata(b.build());
    }

    private Notification buildMediaNotification() {
        if (mediaSession == null) return null;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent togglePi = PendingIntent.getForegroundService(this, 10,
            new Intent(this, GlassesService.class).setAction(ACTION_MEDIA_TOGGLE), flags);
        PendingIntent stopPi = PendingIntent.getForegroundService(this, 11,
            new Intent(this, GlassesService.class).setAction(ACTION_MEDIA_STOP), flags);
        PendingIntent nextPi = PendingIntent.getForegroundService(this, 12,
            new Intent(this, GlassesService.class).setAction(ACTION_MEDIA_NEXT), flags);
        PendingIntent contentPi = PendingIntent.getActivity(this, 13,
            new Intent(this, MainActivity.class).setFlags(
                Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            flags);

        int toggleIcon = musicPaused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause;
        String toggleLabel = musicPaused ? "Play" : "Pause";

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, NotificationHelper.CHANNEL_MEDIA)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTrackTitle  == null || currentTrackTitle.isEmpty()  ? "Crow" : currentTrackTitle)
            .setContentText (currentTrackArtist == null || currentTrackArtist.isEmpty() ? null  : currentTrackArtist)
            .setContentIntent(contentPi)
            .setDeleteIntent(stopPi)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(!musicPaused)
            .setOnlyAlertOnce(true)
            .addAction(toggleIcon, toggleLabel, togglePi)
            .addAction(android.R.drawable.ic_media_next, "Next", nextPi)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi)
            .setStyle(new MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2)
                .setShowCancelButton(true)
                .setCancelButtonIntent(stopPi));
        if (currentArtworkBitmap != null) {
            b.setLargeIcon(currentArtworkBitmap);
        }
        return b.build();
    }

    private void postMediaNotification() {
        mediaActive = true;
        Notification n = buildMediaNotification();
        if (n == null) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(MEDIA_NOTIFICATION_ID, n);
    }

    private void updateMediaNotification() {
        if (!mediaActive) return;
        Notification n = buildMediaNotification();
        if (n == null) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(MEDIA_NOTIFICATION_ID, n);
    }

    private void clearMediaNotification() {
        mediaActive = false;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(MEDIA_NOTIFICATION_ID);
    }

    /**
     * Fetch album artwork via the gateway proxy. Phone never connects to
     * arbitrary URLs — only to the gateway, which validates the src host.
     * Downsamples to ~512px max to keep bitmap memory bounded.
     */
    private void fetchArtworkAsync(String artworkUrl) {
        if (artworkUrl == null || artworkUrl.isEmpty()) return;
        final String requestedUrl = artworkUrl;
        new Thread(() -> {
            try {
                SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String gateway = p.getString(KEY_GATEWAY_URL, null);
                if (gateway == null) return;
                String token = GlassesTokenStore.load(this, deviceId);
                if (token == null) return;
                String base = gateway.replaceAll("/+$", "");
                String proxied = base + "/api/meta-glasses/artwork?src="
                               + java.net.URLEncoder.encode(requestedUrl, "UTF-8")
                               + "&device_id=" + java.net.URLEncoder.encode(deviceId, "UTF-8");
                Request req = new Request.Builder()
                    .url(proxied)
                    .header("Authorization", "Bearer " + token)
                    .build();
                try (Response resp = http.newCall(req).execute()) {
                    if (!resp.isSuccessful() || resp.body() == null) return;
                    byte[] bytes = resp.body().bytes();
                    BitmapFactory.Options o1 = new BitmapFactory.Options();
                    o1.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o1);
                    int sample = 1;
                    int maxDim = Math.max(o1.outWidth, o1.outHeight);
                    while (maxDim > 0 && maxDim / sample > 512) sample *= 2;
                    BitmapFactory.Options o2 = new BitmapFactory.Options();
                    o2.inSampleSize = sample;
                    Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o2);
                    if (bmp == null) return;
                    if (!requestedUrl.equals(currentArtworkUrl)) return;
                    currentArtworkBitmap = bmp;
                    new Handler(getMainLooper()).post(() -> {
                        publishMetadata(currentTrackTitle, currentTrackArtist, currentArtworkBitmap);
                        updateMediaNotification();
                    });
                }
            } catch (Exception ignored) {}
        }, "artwork-fetch").start();
    }

    /**
     * TTS ducking: when TTS arrives during music playback, lower the music
     * AudioTrack volume so the speech is intelligible; restore when the
     * utterance count returns to 0. No-op if music isn't playing.
     */
    private void duckMusic(boolean duck) {
        int count = duck ? pendingTtsDucks.incrementAndGet() : Math.max(0, pendingTtsDucks.decrementAndGet());
        AudioTrack t;
        synchronized (this) { t = musicTrack; }
        if (t == null) return;
        try { t.setVolume(count > 0 ? 0.25f : 1.0f); } catch (Exception ignored) {}
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
            // Restore music volume after TTS playback completes.
            duckMusic(false);
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
        closeMusicTrack();
        releaseStreamFile();
        // Clear media notification BEFORE releasing the session
        clearMediaNotification();
        if (mediaSession != null) {
            try { mediaSession.setActive(false); } catch (Exception ignored) {}
            try { mediaSession.release(); } catch (Exception ignored) {}
            mediaSession = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
