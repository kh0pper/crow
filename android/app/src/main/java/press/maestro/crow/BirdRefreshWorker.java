package press.maestro.crow;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Keeps "your bird" current: GET the bird API with the WebView's session, cache the answer, redraw the
 * widget and repaint the pinned shortcut's icon when the drawing changed.
 *
 * Runs off the main thread by design (WorkManager), scheduled by BirdWidgetProvider: every 30 minutes
 * while a bird widget exists or "your bird" is pinned as a launcher shortcut, on onUpdate, and on the
 * gateway's silent "crow-widgets" push. With no widget on a home screen and no pinned shortcut there
 * is nothing to draw, so no request is sent.
 *
 * Signed out (no crow_session cookie, 401/403, a login redirect, or the owner-check 404) is a STATE:
 * it is cached as such and drawn as "Open Crow to sign in". The API's own 404 codes — no_ramble (Ramble
 * is not installed) and no_bird (nothing hatched yet) — are a STATE too, drawn as "No bird yet". Any
 * other failure — including an answer body bigger than MAX_BODY_BYTES, which is never read — leaves the
 * last cache alone and redraws from it.
 */
public class BirdRefreshWorker extends Worker {

    private static final String TAG = "BirdRefresh";

    private static final String BIRD_PATH = "/dashboard/widgets-api/bird";

    /** The app's short budget for a widget request (nothing here may hold a row open). */
    private static final long TIMEOUT_SECONDS = 5;

    /**
     * A bird drawing is a few KB. An answer whose body is bigger than this is not one: it is treated as
     * a failure — the last cache is kept and drawn from — rather than read into memory.
     */
    private static final int MAX_BODY_BYTES = 256 * 1024;

    public BirdRefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();

        // No widget and no pinned shortcut: nothing to draw, and nothing to ask the gateway for.
        if (!BirdWidgetProvider.hasWidgets(context) && !BirdShortcut.isPinned(context)) return Result.success();

        String gatewayUrl = NeedsMeRefreshWorker.gatewayUrl(context);
        if (gatewayUrl == null || gatewayUrl.isEmpty()) {
            BirdWidgetProvider.cacheSignIn(context);
            BirdWidgetProvider.drawAll(context);
            return Result.success();
        }

        String cookie = NeedsMeRefreshWorker.cookie(context, gatewayUrl);
        if (!NeedsMeRefreshWorker.signedIn(cookie)) {
            BirdWidgetProvider.cacheSignIn(context);
            BirdWidgetProvider.drawAll(context);
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
                .url(NeedsMeRefreshWorker.join(gatewayUrl, BIRD_PATH))
                .header("Cookie", cookie)
                .header("Accept", "application/json")
                .get()
                .build();

        try (Response response = client.newCall(request).execute()) {
            int code = response.code();
            String location = response.header("Location");
            ResponseBody body = response.body();
            String text = body == null ? null : readBody(body);
            if (body != null && text == null) {
                // Bigger than a bird drawing (or a body the capped read could not contain): a failure,
                // not a state. Keep the cache and draw from it — asking again would fetch the same
                // oversized answer.
                Log.w(TAG, "bird answer longer than " + MAX_BODY_BYTES + " bytes; kept the cache");
                BirdWidgetProvider.drawAll(context);
                return Result.success();
            }

            if (code == 200) {
                accept(context, text);
            } else if (code == 401 || code == 403 || code == 404) {
                String failure = failureCode(text);
                if ("no_ramble".equals(failure) || "no_bird".equals(failure)) {
                    BirdWidgetProvider.cacheNoBird(context);
                } else {
                    // The owner check's 404, a refused session: ask for a sign-in.
                    BirdWidgetProvider.cacheSignIn(context);
                }
            } else if (code >= 300 && code < 400
                    && (location == null || location.toLowerCase(Locale.ROOT).contains("login"))) {
                // A redirect towards the login page: this app has no session for the owner.
                BirdWidgetProvider.cacheSignIn(context);
            } else {
                Log.w(TAG, "bird answered " + code);
            }
        } catch (Exception e) {
            // Offline, a timeout, a certificate the gateway has not earned: keep the last cache.
            Log.w(TAG, "bird failed: " + e.getMessage());
            BirdWidgetProvider.drawAll(context);
            return Result.retry();
        }

        BirdWidgetProvider.drawAll(context);
        return Result.success();
    }

    /** Take a 200's answer: cache it, and repaint the pinned shortcut when the drawing changed. */
    private static void accept(Context context, String text) {
        if (text == null || text.trim().isEmpty()) return;
        BirdJson.Bird next = BirdJson.fromText(text);
        if (next == null) {
            // A 200 that is not the JSON we expected (a proxy's page): keep the cache and settle.
            Log.w(TAG, "bird answer was not JSON");
            return;
        }
        String previousSvg = svgOf(BirdWidgetProvider.cachedJson(context));
        if (next.svg != null && !next.svg.equals(previousSvg)) {
            // The bird changed (a hatch, an outfit, a new mood, the walk badge appearing): move the
            // pinned shortcut's icon with it. A bitmap that cannot be drawn leaves the app icon.
            Bitmap icon = BirdBitmap.render(next.svg, BirdShortcut.ICON_PX);
            BirdShortcut.update(context, icon);
        }
        BirdWidgetProvider.cacheBird(context, text);
    }

    /**
     * The answer's text, read through a cap of MAX_BODY_BYTES; null when the body is bigger than that.
     *
     * A peek that filled the cap means the body may have been cut there — and a bird drawing never
     * comes close, so that is the same answer as "too big": null, and the caller keeps the cache.
     */
    private static String readBody(ResponseBody body) throws IOException {
        // A declared length over the cap is refused before a byte of it is buffered.
        if (body.contentLength() > MAX_BODY_BYTES) return null;
        // Buffer at most one byte past the cap: request() returns false when the stream ends first.
        okio.BufferedSource source = body.source();
        if (source.request(MAX_BODY_BYTES + 1L)) return null; // more than the cap: refuse
        return source.getBuffer().readUtf8();
    }

    /** The `code` field of an error answer (the API's no_ramble / no_bird), or null. */
    private static String failureCode(String text) {
        if (text == null || text.trim().isEmpty()) return null;
        try {
            Object code = new JSONObject(text).opt("code");
            return code instanceof String ? (String) code : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** The drawing in a cached answer, or null. */
    private static String svgOf(String cached) {
        BirdJson.Bird bird = BirdJson.fromText(cached);
        return bird == null ? null : bird.svg;
    }
}