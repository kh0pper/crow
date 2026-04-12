package press.maestro.crow;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
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
        if (intent != null) {
            deviceId = intent.getStringExtra(EXTRA_DEVICE_ID);
        }
        startForeground(NOTIFICATION_ID, buildNotification("Connecting to glasses..."));
        if (deviceId == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        connectWebSocket();
        return START_STICKY;
    }

    /** Called by the in-app PTT button or WakeWordEngine when user starts speaking. */
    public void beginTurn() {
        if (ws == null || inTurn) return;
        inTurn = true;
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
        if (!inTurn) return;
        inTurn = false;
        stopMicPump();
        audioManager.setBluetoothScoOn(false);
        audioManager.stopBluetoothSco();
        if (ws != null) ws.send("{\"type\":\"turn_end\"}");
    }

    /**
     * Read mic PCM from the BT SCO stream and forward as binary frames.
     * TODO(meta-glasses): implement the AudioRecord reader loop here.
     * Pseudocode:
     *   AudioRecord rec = new AudioRecord(VOICE_RECOGNITION, 16000, MONO, PCM_16BIT, bufSize);
     *   rec.startRecording();
     *   while (inTurn) { rec.read(buf, 0, buf.length); ws.send(ByteString.of(buf)); }
     */
    private void startMicPump() {
        // Placeholder — fills in once BT SCO PCM framing is validated on
        // real Ray-Ban Meta hardware.
    }

    private void stopMicPump() {
        // Placeholder — mirrors startMicPump.
    }

    private void connectWebSocket() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String gateway = prefs.getString(KEY_GATEWAY_URL, null);
        if (gateway == null) { stopSelf(); return; }
        String token = GlassesTokenStore.load(this, deviceId);
        if (token == null) { stopSelf(); return; }

        String wsUrl = gateway.replaceFirst("^http", "ws").replaceAll("/+$", "")
                + "/api/meta-glasses/session?device_id=" + deviceId;
        Request req = new Request.Builder()
                .url(wsUrl)
                .header("Authorization", "Bearer " + token)
                .build();

        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
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
                            openAudioTrack(msg.optInt("sample_rate", 24000));
                            break;
                        case "tts_end":
                            closeAudioTrack();
                            break;
                        case "transcript_final":
                            Log.i(TAG, "transcript: " + msg.optString("text"));
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
                // Binary frame → TTS audio chunk. Write to AudioTrack.
                if (audioTrack != null) {
                    byte[] data = bytes.toByteArray();
                    audioTrack.write(data, 0, data.length);
                }
            }

            @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                Log.i(TAG, "WebSocket closing: " + code + " " + reason);
                webSocket.close(1000, null);
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                Log.w(TAG, "WebSocket failed: " + t.getMessage());
                updateNotification("Disconnected — retrying");
                // Simple retry after 5s; OkHttp doesn't auto-reconnect.
                new android.os.Handler(getMainLooper()).postDelayed(
                        GlassesService.this::connectWebSocket, 5000);
            }
        });
    }

    private synchronized void openAudioTrack(int sampleRate) {
        closeAudioTrack();
        int minBuf = AudioTrack.getMinBufferSize(sampleRate,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        audioTrack = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build())
                .setBufferSizeInBytes(Math.max(minBuf, 4096))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        audioTrack.play();
    }

    private synchronized void closeAudioTrack() {
        if (audioTrack != null) {
            try { audioTrack.stop(); } catch (Exception ignored) {}
            try { audioTrack.release(); } catch (Exception ignored) {}
            audioTrack = null;
        }
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Paired Glasses", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Maintains connection to paired Meta Ray-Ban glasses.");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Crow Glasses")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NotificationID(), buildNotification(text));
    }

    private int NotificationID() { return NOTIFICATION_ID; }

    @Override
    public void onDestroy() {
        super.onDestroy();
        try { if (ws != null) ws.close(1000, "service_stop"); } catch (Exception ignored) {}
        closeAudioTrack();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
