package press.maestro.crow;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

/**
 * A button tap on the "What needs me" widget: answer the item in place (widgets phase 1).
 *
 * The tap carries the key, the action and the nonce the widget drew — the worker hands them to
 * POST /dashboard/widgets-api/needs-me/act with the WebView's session cookie and the crow_csrf
 * double-submit header. The gateway re-reads the item and refuses a stale nonce with 409, so a widget
 * drawn before a change on another device can never decide twice.
 *
 * A receiver runs on the main thread, so the POST goes to a background thread via goAsync(), and the
 * broadcast's life is stretched over it:
 *  - 200: the response carries the fresh summary — cache it and redraw;
 *  - 409: this drawing is stale — ask for a full refresh instead of retrying the tap;
 *  - anything else (offline, 500, a signed-out 404): redraw from the cache, changing nothing.
 */
public class NeedsMeActionReceiver extends BroadcastReceiver {

    private static final String TAG = "NeedsMeAction";

    static final String EXTRA_KEY = "key";
    static final String EXTRA_ACTION = "action";
    static final String EXTRA_NONCE = "nonce";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String key = intent.getStringExtra(EXTRA_KEY);
        String action = intent.getStringExtra(EXTRA_ACTION);
        String nonce = intent.getStringExtra(EXTRA_NONCE);
        if (key == null || key.isEmpty() || action == null || action.isEmpty()) return;

        final Context app = context.getApplicationContext();
        final String tapKey = key;
        final String tapAction = action;
        final String tapNonce = nonce == null ? "" : nonce;

        final PendingResult pending = goAsync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    post(app, tapKey, tapAction, tapNonce);
                } catch (Exception e) {
                    Log.w(TAG, "tap failed: " + e.getMessage());
                    NeedsMeWidgetProvider.drawAll(app);
                } finally {
                    try {
                        pending.finish();
                    } catch (Exception ignored) {
                        // The broadcast was already finished by the system.
                    }
                }
            }
        }, "needs-me-act").start();
    }

    private static void post(Context context, String key, String action, String nonce) throws Exception {
        String gatewayUrl = NeedsMeRefreshWorker.gatewayUrl(context);
        if (gatewayUrl == null) {
            NeedsMeWidgetProvider.cacheSignIn(context);
            NeedsMeWidgetProvider.drawAll(context);
            return;
        }
        String cookie = NeedsMeRefreshWorker.cookie(context, gatewayUrl);
        if (!NeedsMeRefreshWorker.signedIn(cookie)) {
            NeedsMeWidgetProvider.cacheSignIn(context);
            NeedsMeWidgetProvider.drawAll(context);
            return;
        }

        JSONObject body = new JSONObject();
        body.put("key", key);
        body.put("action", action);
        body.put("nonce", nonce);

        NeedsMeRefreshWorker.Reply reply = NeedsMeRefreshWorker.postJson(
                NeedsMeRefreshWorker.actUrl(gatewayUrl), cookie, body.toString());

        if (reply.status == 200 && reply.body != null) {
            JSONObject answer = new JSONObject(reply.body);
            JSONObject summary = answer.optJSONObject("summary");
            if (summary != null) NeedsMeWidgetProvider.cacheSummary(context, summary.toString());
            NeedsMeWidgetProvider.drawAll(context);
        } else if (reply.status == 409) {
            // Stale: the item changed since this widget drew it. Never retry the tap.
            NeedsMeWidgetProvider.refreshAll(context);
        } else {
            Log.w(TAG, "act answered " + reply.status);
            NeedsMeWidgetProvider.drawAll(context);
        }
    }
}