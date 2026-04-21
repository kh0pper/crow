package press.maestro.crow;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.core.app.NotificationCompat;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * Foreground service that maintains a long-lived HTTP connection to the ntfy
 * server's JSON stream endpoint for instant push notification delivery.
 *
 * Falls back gracefully: if ntfy is not configured or unreachable, the service
 * stops itself and the existing WorkManager polling continues as the delivery path.
 */
public class NtfyListenerService extends Service {

    private static final String TAG = "NtfyListener";
    private static final int FOREGROUND_NOTIFICATION_ID = 0x43524F57; // "CROW" in hex
    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String KEY_NTFY_URL = "ntfy_cached_url";
    private static final String KEY_NTFY_TOPIC = "ntfy_cached_topic";
    private static final String KEY_NTFY_CACHED_AT = "ntfy_cached_at";
    private static final String KEY_NTFY_LAST_ID = "ntfy_last_message_id";
    /**
     * Tracks the last APK versionCode that wrote ntfy config cache. When the
     * running versionCode differs (upgrade), we invalidate the cache so the
     * new build always re-fetches once. Without this, any change to the
     * config shape (e.g. single-topic → topics array) waits up to the cache
     * TTL (24h) before taking effect on a running installation.
     */
    private static final String KEY_NTFY_CACHE_BUILT_FOR = "ntfy_cache_built_for_version";
    private static final String ENCRYPTED_PREFS_NAME = "CrowSecurePrefs";
    private static final String KEY_NTFY_AUTH = "ntfy_auth_token";
    private static final long CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    private static final long MAX_BACKOFF_MS = 60_000;

    private volatile boolean running = false;
    private Thread streamThread;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Start as foreground service with a silent status notification
        try {
            Notification notification = new NotificationCompat.Builder(this, NotificationHelper.CHANNEL_SERVICE)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Crow")
                    .setContentText("Connected for push notifications")
                    .setOngoing(true)
                    .build();

            startForeground(FOREGROUND_NOTIFICATION_ID, notification);
        } catch (SecurityException e) {
            Log.w(TAG, "Cannot start foreground — notification permission denied");
            stopSelf();
            return START_NOT_STICKY;
        }

        // Launch stream thread if not already running
        if (streamThread == null || !streamThread.isAlive()) {
            running = true;
            streamThread = new Thread(this::connectLoop, "ntfy-stream");
            streamThread.start();
        }

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (streamThread != null) {
            streamThread.interrupt();
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Some OEMs skip onDestroy on swipe-away
        running = false;
        if (streamThread != null) {
            streamThread.interrupt();
        }
        super.onTaskRemoved(rootIntent);
    }

    /**
     * Main connection loop: fetch config, connect to stream, reconnect on failure.
     */
    private void connectLoop() {
        long backoffMs = 5000;

        while (running) {
            try {
                String[] config = getConfig();
                if (config == null) {
                    Log.i(TAG, "ntfy not configured — stopping service");
                    stopSelf();
                    return;
                }

                String ntfyUrl = config[0];
                String topic = config[1];
                String authToken = config[2]; // may be null

                Log.i(TAG, "Connecting to ntfy stream: " + ntfyUrl + "/" + topic);
                streamMessages(ntfyUrl, topic, authToken);

                // If streamMessages returns normally (shouldn't), reconnect
                backoffMs = 5000;

            } catch (Exception e) {
                if (!running) return;
                Log.w(TAG, "Stream error, reconnecting in " + backoffMs + "ms: " + e.getMessage());
                try {
                    Thread.sleep(backoffMs);
                } catch (InterruptedException ie) {
                    return;
                }
                backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            }
        }
    }

    /**
     * Read this app's current versionCode at runtime. Used to detect
     * upgrades and drop stale ntfy config cache (see getConfig).
     */
    private int getCurrentVersionCode() {
        try {
            android.content.pm.PackageInfo info = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
            return (int) (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode);
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Get ntfy config: try cache first, then fetch from gateway.
     * Returns [url, topic, authToken] or null if ntfy is not available.
     */
    private String[] getConfig() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        // Version-bump cache bust: if the cached config was written by an
        // older APK, drop it so we always fetch fresh once per upgrade.
        int currentVersion = getCurrentVersionCode();
        int cachedForVersion = prefs.getInt(KEY_NTFY_CACHE_BUILT_FOR, 0);
        if (cachedForVersion != currentVersion) {
            Log.i(TAG, "APK upgrade detected (cache from v" + cachedForVersion +
                    ", running v" + currentVersion + ") — invalidating ntfy config cache");
            prefs.edit()
                    .remove(KEY_NTFY_URL)
                    .remove(KEY_NTFY_TOPIC)
                    .remove(KEY_NTFY_CACHED_AT)
                    .putInt(KEY_NTFY_CACHE_BUILT_FOR, currentVersion)
                    .apply();
        }

        // Try cached config
        String cachedUrl = prefs.getString(KEY_NTFY_URL, null);
        String cachedTopic = prefs.getString(KEY_NTFY_TOPIC, null);
        long cachedAt = prefs.getLong(KEY_NTFY_CACHED_AT, 0);

        if (cachedUrl != null && cachedTopic != null
                && (System.currentTimeMillis() - cachedAt) < CONFIG_CACHE_TTL_MS) {
            String authToken = getEncryptedAuthToken();
            Log.d(TAG, "Using cached ntfy config");
            return new String[]{cachedUrl, cachedTopic, authToken};
        }

        // Fetch from gateway
        String gatewayUrl = prefs.getString(KEY_GATEWAY_URL, null);
        if (gatewayUrl == null || gatewayUrl.isEmpty()) return null;

        String cookie = null;
        try {
            cookie = CookieManager.getInstance().getCookie(gatewayUrl);
        } catch (Exception e) {
            // CookieManager not initialized (boot before app opened)
        }

        // If no cookie but we have stale cache, use it
        if (cookie == null || cookie.isEmpty()) {
            if (cachedUrl != null && cachedTopic != null) {
                Log.d(TAG, "No cookie available, using stale cached config");
                return new String[]{cachedUrl, cachedTopic, getEncryptedAuthToken()};
            }
            return null;
        }

        HttpURLConnection conn = null;
        try {
            String endpoint = gatewayUrl.replaceAll("/+$", "") + "/api/push/ntfy-config";
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);

            if (conn.getResponseCode() != 200) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
            }

            JSONObject json = new JSONObject(sb.toString());
            if (!json.optBoolean("enabled", false)) return null;

            String url = json.getString("url");
            String authToken = json.optString("authToken", null);
            if ("null".equals(authToken)) authToken = null;

            // Prefer the `topics` array (multi-topic gateways, PR 4+); fall back
            // to `topic` (single-topic gateways). The resulting string is joined
            // with commas — ntfy server natively handles multi-topic subscriptions
            // on a single HTTP connection via the `/topic1,topic2/json` URL form.
            String topicPath;
            JSONArray topicsArray = json.optJSONArray("topics");
            if (topicsArray != null && topicsArray.length() > 0) {
                StringBuilder tb = new StringBuilder();
                for (int i = 0; i < topicsArray.length(); i++) {
                    String t = topicsArray.optString(i, "").trim();
                    if (t.isEmpty()) continue;
                    if (tb.length() > 0) tb.append(",");
                    tb.append(t);
                }
                topicPath = tb.toString();
            } else {
                topicPath = json.getString("topic");
            }

            // Cache config
            prefs.edit()
                    .putString(KEY_NTFY_URL, url)
                    .putString(KEY_NTFY_TOPIC, topicPath)
                    .putLong(KEY_NTFY_CACHED_AT, System.currentTimeMillis())
                    .apply();

            // Cache auth token securely
            saveEncryptedAuthToken(authToken);

            Log.i(TAG, "Fetched ntfy config: " + url + "/" + topicPath);
            return new String[]{url, topicPath, authToken};

        } catch (Exception e) {
            Log.w(TAG, "Failed to fetch ntfy config: " + e.getMessage());
            // Fall back to stale cache if available
            if (cachedUrl != null && cachedTopic != null) {
                return new String[]{cachedUrl, cachedTopic, getEncryptedAuthToken()};
            }
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Connect to ntfy JSON stream and process messages until disconnected.
     */
    private void streamMessages(String ntfyUrl, String topic, String authToken) throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String gatewayUrl = prefs.getString(KEY_GATEWAY_URL, "");
        String lastId = prefs.getString(KEY_NTFY_LAST_ID, null);

        // Build stream URL with since= to avoid replaying history
        String since = (lastId != null) ? lastId : "all";
        String streamUrl = ntfyUrl.replaceAll("/+$", "") + "/" + topic + "/json?since=" + since;

        HttpURLConnection conn = (HttpURLConnection) new URL(streamUrl).openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Accept", "application/json");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(0); // No read timeout — stream is long-lived

        if (authToken != null && !authToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + authToken);
        }

        try {
            if (conn.getResponseCode() != 200) {
                throw new Exception("ntfy stream returned HTTP " + conn.getResponseCode());
            }

            Log.i(TAG, "Connected to ntfy stream");

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()))) {
                String line;
                while (running && (line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;

                    try {
                        JSONObject msg = new JSONObject(line);
                        String event = msg.optString("event", "");

                        if ("message".equals(event)) {
                            handleMessage(msg, gatewayUrl, prefs);
                        }
                        // Skip "open" and "keepalive" events
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to parse ntfy message: " + e.getMessage());
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    /**
     * Process a single ntfy message and show an Android notification.
     */
    private void handleMessage(JSONObject msg, String gatewayUrl, SharedPreferences prefs) {
        try {
            String id = msg.getString("id");
            String title = msg.optString("title", "Notification");
            String body = msg.optString("message", "");
            String click = msg.optString("click", null);
            JSONArray tagsArray = msg.optJSONArray("tags");

            // Build tags string for type mapping
            String tags = null;
            if (tagsArray != null) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < tagsArray.length(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append(tagsArray.getString(i));
                }
                tags = sb.toString();
            }

            String type = NotificationHelper.typeFromNtfyTags(tags);

            // Strip gateway base URL from click to get relative actionUrl
            String actionUrl = "/dashboard/nest";
            if (click != null && !click.isEmpty()) {
                if (click.startsWith(gatewayUrl)) {
                    actionUrl = click.substring(gatewayUrl.length());
                    if (!actionUrl.startsWith("/")) actionUrl = "/" + actionUrl;
                } else {
                    actionUrl = click;
                }
            }

            // Use high-bit offset to avoid collision with DB integer IDs from polling
            int notificationId = id.hashCode() | 0x40000000;

            NotificationHelper.show(this, notificationId, title,
                    body.isEmpty() ? null : body, actionUrl, type);

            // Track last message ID for since= on reconnect
            prefs.edit().putString(KEY_NTFY_LAST_ID, id).apply();

            Log.d(TAG, "Notification: " + title);

        } catch (Exception e) {
            Log.w(TAG, "Error handling ntfy message: " + e.getMessage());
        }
    }

    private String getEncryptedAuthToken() {
        try {
            SharedPreferences securePrefs = getEncryptedPrefs();
            return securePrefs.getString(KEY_NTFY_AUTH, null);
        } catch (Exception e) {
            return null;
        }
    }

    private void saveEncryptedAuthToken(String token) {
        try {
            SharedPreferences securePrefs = getEncryptedPrefs();
            securePrefs.edit().putString(KEY_NTFY_AUTH, token).apply();
        } catch (Exception e) {
            Log.w(TAG, "Failed to save encrypted auth token: " + e.getMessage());
        }
    }

    private SharedPreferences getEncryptedPrefs() throws Exception {
        MasterKey masterKey = new MasterKey.Builder(this)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                this, ENCRYPTED_PREFS_NAME, masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }
}
