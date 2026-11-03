package press.maestro.crow;

import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The "What needs me" home-screen widget (widgets phase 1).
 *
 * It draws the last cached summary (NeedsMeRefreshWorker keeps it current, from the silent
 * "crow-widgets" push, a 30-minute periodic refresh, an unlock, or a button tap) and never fetches
 * anything itself: every network call happens in the worker or the action receiver.
 *
 * Two states change what may be drawn, and neither is negotiable:
 *  - the keyguard is up → the count-only view (NeedsMeRenderer.render's `locked`): no title, no
 *    project, no button, no "all clear" text, because a locked phone on a table is in public;
 *  - signed out → the sign-in line, and nothing else.
 *
 * The widget is declared home-screen only (no keyguard category in its widget info): the locked view
 * is a last line of defence, not the plan, so no host should be able to draw the widget at all while
 * the phone is locked.
 *
 * The push switch: the first widget added turns the gateway's silent push ON and the last one removed
 * turns it OFF, both through NeedsMeRefreshWorker (a worker, so the network call is never on the main
 * thread). Until the app that draws this widget says so, the gateway sends nothing.
 *
 * RemoteViews cannot inflate a list without a RemoteViewsService, so the layout has five fixed row
 * slots (and three button slots inside each) and everything past the model's rows is GONE.
 */
public class NeedsMeWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "NeedsMeWidget";

    private static final String PREFS_NAME = "CrowPrefs";
    /** The last summary as JSON (or the sign-in marker), shared with the worker and the receiver. */
    static final String CACHE_KEY = "needs_me_cache";

    /** The on-demand refresh: replacing a pending one is free (two refreshes are the same refresh). */
    static final String WORK_REFRESH = "needs-me-refresh";
    /** The push on/off switch's own one-time work. */
    private static final String WORK_PUSH = "needs-me-push";
    /** The background refresh that keeps the widget current while it exists. */
    static final String WORK_PERIODIC = "needs-me-periodic";
    private static final long PERIOD_MINUTES = 30;

    /** The intent the action receiver is started with (unique per row and button through its data). */
    private static final String ACTION_TAP = "press.maestro.crow.action.NEEDS_ME_TAP";
    private static final String URI_ACT = "crow-widget://act/";
    private static final String URI_OPEN = "crow-widget://open";

    private static final int[] ROW_IDS = {
            R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3, R.id.widget_row_4, R.id.widget_row_5,
    };
    private static final int[] ROW_TITLE_IDS = {
            R.id.widget_row_title_1, R.id.widget_row_title_2, R.id.widget_row_title_3,
            R.id.widget_row_title_4, R.id.widget_row_title_5,
    };
    private static final int[] ROW_PROJECT_IDS = {
            R.id.widget_row_project_1, R.id.widget_row_project_2, R.id.widget_row_project_3,
            R.id.widget_row_project_4, R.id.widget_row_project_5,
    };
    private static final int[][] ROW_BUTTON_IDS = {
            {R.id.widget_button_1_1, R.id.widget_button_1_2, R.id.widget_button_1_3},
            {R.id.widget_button_2_1, R.id.widget_button_2_2, R.id.widget_button_2_3},
            {R.id.widget_button_3_1, R.id.widget_button_3_2, R.id.widget_button_3_3},
            {R.id.widget_button_4_1, R.id.widget_button_4_2, R.id.widget_button_4_3},
            {R.id.widget_button_5_1, R.id.widget_button_5_2, R.id.widget_button_5_3},
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        refreshAll(context);
    }

    /** The first widget was added: turn the silent push on and start the half-hourly refresh. */
    @Override
    public void onEnabled(Context context) {
        enqueuePush(context, true);
        schedulePeriodic(context);
        refreshAll(context);
    }

    /** The last widget was removed: turn the silent push off and stop the periodic refresh. */
    @Override
    public void onDisabled(Context context) {
        enqueuePush(context, false);
        try {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_PERIODIC);
        } catch (Exception e) {
            Log.w(TAG, "cancel periodic failed: " + e.getMessage());
        }
    }

    /** Ask for one refresh now (the silent push, a tap, onUpdate, a resize). */
    static void refreshAll(Context context) {
        // NtfyListenerService calls this for every "crow-widgets" ping: with no widget on a home
        // screen there is nothing to draw and no reason to wake the network.
        if (!hasWidgets(context)) return;
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NeedsMeRefreshWorker.class)
                    .setConstraints(connected())
                    .build();
            WorkManager.getInstance(context)
                    .enqueueUniqueWork(WORK_REFRESH, ExistingWorkPolicy.REPLACE, request);
        } catch (Exception e) {
            Log.w(TAG, "refresh not enqueued: " + e.getMessage());
            drawAll(context);
        }
    }

    private static void enqueuePush(Context context, boolean on) {
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NeedsMeRefreshWorker.class)
                    .setConstraints(connected())
                    .setInputData(new Data.Builder()
                            .putBoolean(NeedsMeRefreshWorker.INPUT_PUSH_STATE, on)
                            .build())
                    .build();
            WorkManager.getInstance(context)
                    .enqueueUniqueWork(WORK_PUSH, ExistingWorkPolicy.REPLACE, request);
        } catch (Exception e) {
            Log.w(TAG, "push switch not enqueued: " + e.getMessage());
        }
    }

    private static void schedulePeriodic(Context context) {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    NeedsMeRefreshWorker.class, PERIOD_MINUTES, TimeUnit.MINUTES)
                    .setConstraints(connected())
                    .build();
            WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(WORK_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (Exception e) {
            Log.w(TAG, "periodic refresh not scheduled: " + e.getMessage());
        }
    }

    private static Constraints connected() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    /** Whether a "what needs me" widget is on a home screen right now. */
    private static boolean hasWidgets(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            if (manager == null) return false;
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, NeedsMeWidgetProvider.class));
            return ids != null && ids.length > 0;
        } catch (Exception e) {
            Log.w(TAG, "no widget manager: " + e.getMessage());
            return false;
        }
    }

    // ---- drawing --------------------------------------------------------------

    /** Redraw every widget from the cache, with the keyguard as it is now. */
    static void drawAll(Context context) {
        drawAll(context, isLocked(context));
    }

    /** Redraw every widget from the cache with an explicit keyguard state (screen off / unlocked). */
    static void drawAll(Context context, boolean locked) {
        AppWidgetManager manager;
        int[] ids;
        try {
            manager = AppWidgetManager.getInstance(context);
            if (manager == null) return;
            ids = manager.getAppWidgetIds(new ComponentName(context, NeedsMeWidgetProvider.class));
        } catch (Exception e) {
            Log.w(TAG, "no widget manager: " + e.getMessage());
            return;
        }
        if (ids == null || ids.length == 0) return;

        NeedsMeRenderer.Summary summary = NeedsMeJson.fromText(cachedJson(context));
        boolean signedOut = summary != null && NeedsMeJson.SIGN_IN_STATE.equals(summary.state);
        NeedsMeRenderer.RenderModel defaultModel = NeedsMeRenderer.render(summary, locked, signedOut);

        for (int id : ids) {
            try {
                // Defence in depth: a host that still draws this widget on the keyguard gets the
                // count-only view, whatever the keyguard is doing at the moment of the draw.
                NeedsMeRenderer.RenderModel model = !locked && drawsOnKeyguard(manager, id)
                        ? NeedsMeRenderer.render(summary, true, signedOut)
                        : defaultModel;
                manager.updateAppWidget(id, build(context, id, model));
            } catch (Exception e) {
                // A launcher that refuses the update must not take the others down with it.
                Log.w(TAG, "update failed for " + id + ": " + e.getMessage());
            }
        }
    }

    /**
     * Whether this widget id sits on a keyguard host. The widget info no longer asks for the keyguard
     * (android:widgetCategory="home_screen"), so this only ever answers yes for a host that ignored
     * that — and then the id is drawn as if the keyguard were up, never as a full view.
     */
    private static boolean drawsOnKeyguard(AppWidgetManager manager, int widgetId) {
        try {
            Bundle options = manager.getAppWidgetOptions(widgetId);
            return options != null
                    && options.getInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY, -1)
                            == AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD;
        } catch (Exception e) {
            // Options we cannot read are no licence to draw more: treat it as a keyguard host.
            Log.w(TAG, "options unreadable for " + widgetId + ": " + e.getMessage());
            return true;
        }
    }

    private static RemoteViews build(Context context, int widgetId, NeedsMeRenderer.RenderModel model) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_needs_me);

        CharSequence headline;
        if (model.kind == NeedsMeRenderer.Headline.SIGN_IN) {
            headline = context.getString(R.string.widget_needs_me_sign_in);
        } else if (model.kind == NeedsMeRenderer.Headline.ERROR) {
            headline = context.getString(R.string.widget_needs_me_error);
        } else {
            headline = model.headline == null ? "" : model.headline;
        }
        views.setTextViewText(R.id.widget_headline, headline);

        if (model.doing == null || model.doing.isEmpty()) {
            views.setViewVisibility(R.id.widget_doing, View.GONE);
        } else {
            views.setTextViewText(R.id.widget_doing, TextUtils.join("\n", model.doing));
            views.setViewVisibility(R.id.widget_doing, View.VISIBLE);
        }

        List<NeedsMeRenderer.Row> rows = model.rows;
        for (int i = 0; i < ROW_IDS.length; i++) {
            if (rows == null || i >= rows.size()) {
                views.setViewVisibility(ROW_IDS[i], View.GONE);
                continue;
            }
            NeedsMeRenderer.Row row = rows.get(i);
            views.setViewVisibility(ROW_IDS[i], View.VISIBLE);
            views.setTextViewText(ROW_TITLE_IDS[i], row.title == null ? "" : row.title);
            if (row.project == null || row.project.isEmpty()) {
                views.setViewVisibility(ROW_PROJECT_IDS[i], View.GONE);
            } else {
                views.setTextViewText(ROW_PROJECT_IDS[i], row.project);
                views.setViewVisibility(ROW_PROJECT_IDS[i], View.VISIBLE);
            }
            views.setOnClickPendingIntent(ROW_IDS[i], openIntent(context, widgetId, row.href));

            for (int j = 0; j < ROW_BUTTON_IDS[i].length; j++) {
                int buttonId = ROW_BUTTON_IDS[i][j];
                if (j >= row.buttons.size()) {
                    views.setViewVisibility(buttonId, View.GONE);
                    continue;
                }
                NeedsMeRenderer.Action action = row.buttons.get(j);
                views.setTextViewText(buttonId, action.label);
                views.setViewVisibility(buttonId, View.VISIBLE);
                views.setOnClickPendingIntent(buttonId, actionIntent(context, widgetId, row, action));
            }
        }

        views.setTextViewText(R.id.widget_see_all, context.getString(R.string.widget_needs_me_see_all));
        views.setOnClickPendingIntent(R.id.widget_see_all, openIntent(context, widgetId, model.moreHref));
        return views;
    }

    /** A row tap: MainActivity with the same "action_url" extra a notification tap uses. */
    private static PendingIntent openIntent(Context context, int widgetId, String href) {
        String safe = NeedsMeRenderer.safeHref(href);
        Intent intent = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("action_url", safe)
                // The data URI gives the intent its identity, so two rows never share a PendingIntent.
                .setData(Uri.parse(URI_OPEN + safe));
        return PendingIntent.getActivity(context, requestCode(widgetId, "open", safe), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** A button tap: an explicit broadcast to NeedsMeActionReceiver carrying the item's key + nonce. */
    private static PendingIntent actionIntent(Context context, int widgetId, NeedsMeRenderer.Row row,
                                              NeedsMeRenderer.Action action) {
        String key = row.key == null ? "" : row.key;
        String id = action.id == null ? "" : action.id;
        Intent intent = new Intent(context, NeedsMeActionReceiver.class)
                .setAction(ACTION_TAP)
                .setData(Uri.parse(URI_ACT + Uri.encode(key) + "/" + Uri.encode(id)))
                .putExtra(NeedsMeActionReceiver.EXTRA_KEY, key)
                .putExtra(NeedsMeActionReceiver.EXTRA_ACTION, id)
                .putExtra(NeedsMeActionReceiver.EXTRA_NONCE, row.nonce);
        return PendingIntent.getBroadcast(context, requestCode(widgetId, key, id), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** A stable request code per widget and (row, button) — the data URI keeps the identities apart. */
    private static int requestCode(int widgetId, String key, String action) {
        int hash = 17;
        hash = 31 * hash + (key == null ? 0 : key.hashCode());
        hash = 31 * hash + (action == null ? 0 : action.hashCode());
        return (widgetId * 31 + hash) & 0x7fffffff;
    }

    // ---- cache and keyguard ---------------------------------------------------

    static String cachedJson(Context context) {
        return prefs(context).getString(CACHE_KEY, null);
    }

    /** Keep the summary exactly as the gateway sent it (see NeedsMeJson). */
    static void cacheSummary(Context context, String json) {
        if (json == null || json.trim().isEmpty()) return;
        prefs(context).edit().putString(CACHE_KEY, json).apply();
    }

    /** The last refresh found no session: the widget asks for a sign-in until one is found. */
    static void cacheSignIn(Context context) {
        prefs(context).edit().putString(CACHE_KEY, NeedsMeJson.SIGN_IN_JSON).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static boolean isLocked(Context context) {
        try {
            KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
            return keyguard != null && keyguard.isKeyguardLocked();
        } catch (Exception e) {
            return false;
        }
    }
}