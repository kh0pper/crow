package press.maestro.crow;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Refreshes the "What needs me" widget: GET the summary with the WebView's session, cache it, redraw
 * every widget. Runs off the main thread by design (WorkManager).
 *
 * Scheduled by NeedsMeWidgetProvider: every 30 min while a widget exists, and on demand (a silent
 * "crow-widgets" push, a screen off/unlock, a 409 from a button tap). The provider also hands it the
 * push switch as input data, so adding the first widget turns the silent push on and removing the last
 * turns it off — from a worker, never from the main thread. A push-switch run does exactly that one
 * POST and stops: it neither refreshes nor re-asserts the switch it just set.
 *
 * No widget on any home screen means no request at all: the periodic work and the silent push both
 * land here, and neither may send anything on behalf of a widget that is no longer there.
 *
 * Signed out (no crow_session cookie, 401/403/404, a redirect to a login page) is a STATE, not a
 * failure: it is cached as such and drawn as "Open Crow to sign in". Anything else that goes wrong
 * leaves the last cache alone and redraws from it.
 */
public class NeedsMeRefreshWorker extends Worker {

    private static final String TAG = "NeedsMeRefresh";
    /** Input data key: the provider's on/off for the silent push (absent on an ordinary refresh). */
    static final String INPUT_PUSH_STATE = "push_state";

    private static final String PREFS_NAME = "CrowPrefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    /** Whether the gateway's silent push is believed to be on (set by the switch's own answers). */
    static final String KEY_PUSH_ON = "needs_me_push_on";
    /** The gateway that answer came from: a different gateway has never heard of this flag. */
    private static final String KEY_PUSH_ON_URL = "needs_me_push_on_url";
    /** When that answer was recorded (ms), so a stale belief is re-asserted rather than trusted. */
    private static final String KEY_PUSH_ON_AT = "needs_me_push_on_at";
    /** A recorded push-on answer older than this is re-POSTed: the gateway may have been rebuilt. */
    static final long PUSH_REASSERT_MS = 24 * 60 * 60 * 1000L;
    private static final String SUMMARY_PATH = "/dashboard/widgets-api/needs-me";
    private static final String ACT_PATH = "/dashboard/widgets-api/needs-me/act";
    private static final String PUSH_PATH = "/dashboard/widgets-api/push";

    /** The app's short budget for a widget request (nothing here may hold a row open). */
    static final long TIMEOUT_SECONDS = 5;

    public NeedsMeRefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();

        // A push on/off handed over by the provider: flip the setting and stop there. The switch has
        // its answer; a refresh would only repeat work, and would re-assert what was just turned off.
        Data data = getInputData();
        if (data != null && data.getKeyValueMap().containsKey(INPUT_PUSH_STATE)) {
            switchPush(context, data.getBoolean(INPUT_PUSH_STATE, false));
            return Result.success();
        }

        // No widget on a home screen: nothing to draw, and nothing to ask the gateway for. (A
        // push-switch run is answered above and still runs: turning the last widget off must send.)
        if (!hasWidgets(context)) return Result.success();

        SharedPreferences prefs = widgetPrefs(context);
        String gatewayUrl = prefs.getString(KEY_GATEWAY_URL, null);
        if (gatewayUrl == null || gatewayUrl.isEmpty()) {
            NeedsMeWidgetProvider.cacheSignIn(context);
            NeedsMeWidgetProvider.drawAll(context);
            return Result.success();
        }

        String cookie = cookie(context, gatewayUrl);
        if (!signedIn(cookie)) {
            NeedsMeWidgetProvider.cacheSignIn(context);
            NeedsMeWidgetProvider.drawAll(context);
            return Result.success();
        }

        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                // A redirect is a fact to read, not something to follow (it may be the login page).
                .followRedirects(false)
                .followSslRedirects(false)
                .build();

        Request request = new Request.Builder()
                .url(join(gatewayUrl, SUMMARY_PATH))
                .header("Cookie", cookie)
                .header("Accept", "application/json")
                .get()
                .build();

        try (Response response = client.newCall(request).execute()) {
            int code = response.code();
            String location = response.header("Location");
            if (isSignedOut(code, location)) {
                NeedsMeWidgetProvider.cacheSignIn(context);
            } else if (code == 200) {
                ResponseBody body = response.body();
                String text = body == null ? null : body.string();
                // Only a real summary is cached: a login page or an error page must not replace it.
                if (text != null && !text.trim().isEmpty()) {
                    JSONObject summary = null;
                    try {
                        summary = new JSONObject(text);
                    } catch (JSONException e) {
                        // A 200 whose body is not JSON (a proxy's error page): keep the cache, draw
                        // from it and settle — retrying would only repeat the same answer.
                        Log.w(TAG, "summary was not JSON: " + e.getMessage());
                    }
                    if (summary != null) {
                        NeedsMeWidgetProvider.cacheSummary(context, summary.toString());
                        ensurePushOn(context, gatewayUrl, cookie);
                    }
                }
            } else {
                Log.w(TAG, "summary answered " + code);
            }
        } catch (Exception e) {
            // Offline, a timeout, a certificate the gateway has not earned: keep the last cache.
            Log.w(TAG, "summary failed: " + e.getMessage());
            NeedsMeWidgetProvider.drawAll(context);
            return Result.retry();
        }

        NeedsMeWidgetProvider.drawAll(context);
        return Result.success();
    }

    /**
     * Send the provider's on/off for the silent push and record the answer against the gateway that
     * gave it. A signed-out app has nothing to switch it with: no request is sent, and the next
     * refresh either records the sign-in state or re-asserts the switch once a session exists.
     */
    private static void switchPush(Context context, boolean requested) {
        // The state sent is the one true NOW, not the one asked for when the run was queued: an
        // add-then-remove (or remove-then-add) within a second can finish its two runs in either
        // order, and the last run must still send the real state. `requested` is only logged.
        boolean on = hasWidgets(context);
        if (on != requested) Log.i(TAG, "push switch: widgets changed since queued, sending " + on);
        try {
            String gateway = gatewayUrl(context);
            String cookie = cookie(context, gateway);
            if (gateway == null || !signedIn(cookie)) return;
            JSONObject body = new JSONObject();
            body.put("on", on);
            Reply reply = postJson(join(gateway, PUSH_PATH), cookie, body.toString());
            if (reply.status == 200) rememberPush(context, on, gateway);
            else Log.w(TAG, "push switch answered " + reply.status);
        } catch (Exception e) {
            Log.w(TAG, "push switch failed: " + e.getMessage());
        }
    }

    /** Whether a "what needs me" widget is on a home screen right now. */
    private static boolean hasWidgets(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            if (manager == null) return false;
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, NeedsMeWidgetProvider.class));
            return ids != null && ids.length > 0;
        } catch (Exception e) {
            // A manager we cannot ask is not proof of a widget: send nothing rather than guess.
            Log.w(TAG, "no widget manager: " + e.getMessage());
            return false;
        }
    }

    /**
     * Whether a summary answer means "this app has no session for the owner": 401/403 (refused), 404
     * (the owner check: a session that is not this instance's own password login), or any redirect
     * (towards the login page).
     */
    private static boolean isSignedOut(int code, String location) {
        if (code == 401 || code == 403 || code == 404) return true;
        if (code >= 300 && code < 400) {
            return location == null || location.toLowerCase(Locale.ROOT).contains("login");
        }
        return false;
    }

    /**
     * The widget was added while the app was signed out, so onEnabled could not flip the switch: the
     * first refresh that proves a session turns the silent push on instead. A recorded answer is
     * trusted only for the gateway that gave it and only for a day: a gateway rebuilt (or replaced)
     * since then sends nothing for this widget until it is told again. So this costs one POST at
     * most a day — and doWork has already proved a widget exists before it is ever reached.
     */
    private static void ensurePushOn(Context context, String gatewayUrl, String cookie) {
        SharedPreferences prefs = widgetPrefs(context);
        if (prefs.getBoolean(KEY_PUSH_ON, false)) {
            boolean sameGateway = gatewayUrl.equals(prefs.getString(KEY_PUSH_ON_URL, null));
            long recordedAt = prefs.getLong(KEY_PUSH_ON_AT, 0L);
            boolean recent = System.currentTimeMillis() - recordedAt < PUSH_REASSERT_MS;
            if (sameGateway && recent) return;
        }
        Reply reply;
        try {
            JSONObject body = new JSONObject();
            body.put("on", true);
            reply = postJson(join(gatewayUrl, PUSH_PATH), cookie, body.toString());
        } catch (Exception e) {
            return;
        }
        if (reply.status == 200) rememberPush(context, true, gatewayUrl);
    }

    /** Record what the gateway believes about the silent push, and for which gateway. */
    private static void rememberPush(Context context, boolean on, String gatewayUrl) {
        SharedPreferences.Editor edit = widgetPrefs(context).edit().putBoolean(KEY_PUSH_ON, on);
        if (on) {
            edit.putString(KEY_PUSH_ON_URL, gatewayUrl)
                    .putLong(KEY_PUSH_ON_AT, System.currentTimeMillis());
        } else {
            edit.remove(KEY_PUSH_ON_URL).remove(KEY_PUSH_ON_AT);
        }
        edit.apply();
    }

    // ---- shared with NeedsMeActionReceiver -------------------------------------

    static SharedPreferences widgetPrefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** The saved gateway URL, or null when the app was never set up. */
    static String gatewayUrl(Context context) {
        String url = widgetPrefs(context).getString(KEY_GATEWAY_URL, null);
        return url == null || url.isEmpty() ? null : url;
    }

    /** The WebView's cookie header for the gateway, or null when there is none. */
    static String cookie(Context context, String gatewayUrl) {
        if (gatewayUrl == null) return null;
        try {
            return CookieManager.getInstance().getCookie(gatewayUrl);
        } catch (Exception e) {
            // CookieManager not initialized (the app has never been opened).
            return null;
        }
    }

    /** A session is present only when the cookie header carries crow_session. */
    static boolean signedIn(String cookie) {
        return cookie != null && cookie.contains("crow_session=");
    }

    /**
     * The raw crow_csrf double-submit token from the cookie header — sent exactly as the cookie holds
     * it, because the gateway compares its header against the cookie raw (without decoding) — or null.
     */
    static String csrfFrom(String cookie) {
        if (cookie == null) return null;
        for (String part : cookie.split(";")) {
            String pair = part.trim();
            if (pair.startsWith("crow_csrf=")) {
                String value = pair.substring("crow_csrf=".length());
                return value.isEmpty() ? null : value;
            }
        }
        return null;
    }

    /** One JSON answer: the status (0 when the request never reached the gateway) and the body. */
    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /**
     * POST a JSON body with the session cookie and the crow_csrf header, on a background thread with
     * the same 5 s budget. Never throws: a failure is status 0.
     */
    static Reply postJson(String endpoint, String cookie, String json) {
        HttpURLConnection conn = null;
        try {
            byte[] bytes = json.getBytes("UTF-8");
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setRequestMethod("POST");
            // A redirect (to the login page) is an answer to read, not a page to parse as JSON.
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Cookie", cookie == null ? "" : cookie);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            String token = csrfFrom(cookie);
            if (token != null) conn.setRequestProperty("x-crow-csrf", token);
            conn.setConnectTimeout((int) TimeUnit.SECONDS.toMillis(TIMEOUT_SECONDS));
            conn.setReadTimeout((int) TimeUnit.SECONDS.toMillis(TIMEOUT_SECONDS));
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new Reply(status, readAll(in));
        } catch (Exception e) {
            Log.w(TAG, "POST failed: " + e.getMessage());
            return new Reply(0, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static String join(String gatewayUrl, String path) {
        return gatewayUrl.replaceAll("/+$", "") + path;
    }

    /** The action endpoint NeedsMeActionReceiver POSTs to. */
    static String actUrl(String gatewayUrl) {
        return join(gatewayUrl, ACT_PATH);
    }

    private static String readAll(InputStream in) {
        if (in == null) return null;
        try (InputStream stream = in) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
            return buffer.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }
}