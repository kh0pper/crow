package press.maestro.crow;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * Background worker that polls the Crow gateway for new notifications.
 * Uses the WebView's session cookie for authentication.
 */
public class NotificationWorker extends Worker {

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String KEY_LAST_CHECKED = "notif_last_checked";

    public NotificationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        String gatewayUrl = prefs.getString(KEY_GATEWAY_URL, null);
        if (gatewayUrl == null || gatewayUrl.isEmpty()) {
            return Result.success(); // Not configured yet
        }

        String lastChecked = prefs.getString(KEY_LAST_CHECKED, "1970-01-01T00:00:00Z");

        // Get session cookie from WebView's CookieManager
        String cookie = null;
        try {
            cookie = CookieManager.getInstance().getCookie(gatewayUrl);
        } catch (Exception e) {
            // CookieManager not initialized yet (app never opened)
            return Result.success();
        }

        if (cookie == null || cookie.isEmpty()) {
            return Result.success(); // Not logged in
        }

        HttpURLConnection conn = null;
        try {
            String endpoint = gatewayUrl.replaceAll("/+$", "")
                    + "/api/push/notifications?since=" + java.net.URLEncoder.encode(lastChecked, "UTF-8");

            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);

            // Accept self-signed certs for home lab setups
            if (conn instanceof HttpsURLConnection) {
                // Use default SSL — Tailscale certs are valid
            }

            int code = conn.getResponseCode();
            if (code != 200) {
                return Result.retry(); // Auth expired or server down
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }

            JSONObject response = new JSONObject(sb.toString());
            JSONArray notifications = response.getJSONArray("notifications");

            String newestTimestamp = lastChecked;

            for (int i = 0; i < notifications.length(); i++) {
                JSONObject n = notifications.getJSONObject(i);
                int id = n.getInt("id");
                String title = n.getString("title");
                String body = n.optString("body", null);
                String type = n.optString("type", "system");
                String actionUrl = n.optString("action_url", "/dashboard/nest");
                String createdAt = n.getString("created_at");

                NotificationHelper.show(getApplicationContext(), id, title, body, actionUrl, type);

                // Track newest timestamp
                if (createdAt.compareTo(newestTimestamp) > 0) {
                    newestTimestamp = createdAt;
                }
            }

            // Update last checked to the newest notification time
            if (notifications.length() > 0) {
                prefs.edit().putString(KEY_LAST_CHECKED, newestTimestamp).apply();
            }

            return Result.success();

        } catch (Exception e) {
            return Result.retry();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
