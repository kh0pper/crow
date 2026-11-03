package press.maestro.crow;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * "Your bird" home-screen widget (widgets phase 3): YOUR Ramble bird, drawn on the phone, with its
 * mood and — on a home screen only — today's steps.
 *
 * It never fetches anything itself. BirdRefreshWorker keeps the cache current (the gateway's silent
 * "crow-widgets" push, the half-hourly periodic run while a bird widget exists or "your bird" is
 * pinned as a shortcut, and onUpdate), and this provider only draws what the cache says: the
 * gateway's own SVG through BirdSvgRenderer + BirdBitmap (never a WebView, never a network call on
 * the main thread).
 *
 * The lock rule, unchanged from "What needs me": the widget is declared home_screen only, and any host
 * that puts it on the keyguard anyway gets the bird and its mood but NEVER the step count, and never
 * the walked-today badge either (the drawing is made with walked=false) — a locked phone on a table is
 * in public, and how far its owner walked today is theirs.
 *
 * The push switch belongs to the "what needs me" widget (NeedsMeWidgetProvider flips it when the first
 * of ITS widgets comes and goes); this provider only hangs off the same silent ping.
 *
 * A tap opens Ramble (BirdShortcut.rambleIntent), so the bird on the home screen leads to the bird.
 */
public class BirdWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "BirdWidget";

    /** Shared with BirdRefreshWorker: the bird API's last answer, as JSON (BirdJson). */
    static final String PREFS_NAME = "CrowPrefs";
    static final String CACHE_KEY = "bird_cache";

    /** The on-demand refresh: replacing a pending one is free (two refreshes are the same refresh). */
    static final String WORK_REFRESH = "bird-refresh";
    /** The background refresh that keeps the widget current while it exists. */
    static final String WORK_PERIODIC = "bird-periodic";
    private static final long PERIOD_MINUTES = 30;

    /** The widget's drawing is square; this is the size when the launcher tells us nothing. */
    private static final int FALLBACK_DP = 110;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        refreshAll(context);
    }

    /** The first bird widget was added: start the half-hourly refresh and draw what we have. */
    @Override
    public void onEnabled(Context context) {
        schedulePeriodicRefresh(context);
        refreshAll(context);
    }

    /**
     * The last bird widget was removed: stop the periodic refresh — unless "your bird" is still pinned
     * as a launcher shortcut, which keeps its icon and wants it kept current (BirdShortcut.requestPin
     * schedules the same run).
     */
    @Override
    public void onDisabled(Context context) {
        if (BirdShortcut.isPinned(context)) return;
        try {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_PERIODIC);
        } catch (Exception e) {
            Log.w(TAG, "cancel periodic failed: " + e.getMessage());
        }
    }

    /** Resized to another cell: the bitmap is sized to the widget, so redraw it. */
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int widgetId,
                                          android.os.Bundle newOptions) {
        drawAll(context);
    }

    /** Ask for one refresh now (the silent push, onUpdate, a resize). */
    static void refreshAll(Context context) {
        // Nothing to draw and nothing to keep current: no widget on a home screen and no pinned
        // shortcut means no reason to wake the network.
        if (!hasWidgets(context) && !BirdShortcut.isPinned(context)) return;
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BirdRefreshWorker.class)
                    .setConstraints(connected())
                    .build();
            WorkManager.getInstance(context)
                    .enqueueUniqueWork(WORK_REFRESH, ExistingWorkPolicy.REPLACE, request);
        } catch (Exception e) {
            Log.w(TAG, "refresh not enqueued: " + e.getMessage());
            drawAll(context);
        }
    }

    /**
     * The half-hourly refresh that keeps the drawing current (unique name, KEEP: an existing run is
     * left alone). Start it when a bird widget arrives, and when "your bird" is pinned as a launcher
     * shortcut — a pinned bird keeps updating with no widget on any home screen.
     */
    static void schedulePeriodicRefresh(Context context) {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    BirdRefreshWorker.class, PERIOD_MINUTES, TimeUnit.MINUTES)
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

    /** Whether a bird widget is on a home screen right now. */
    static boolean hasWidgets(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            if (manager == null) return false;
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, BirdWidgetProvider.class));
            return ids != null && ids.length > 0;
        } catch (Exception e) {
            Log.w(TAG, "no widget manager: " + e.getMessage());
            return false;
        }
    }

    // ---- drawing --------------------------------------------------------------

    /** Redraw every widget from the cache. */
    static void drawAll(Context context) {
        AppWidgetManager manager;
        int[] ids;
        try {
            manager = AppWidgetManager.getInstance(context);
            if (manager == null) return;
            ids = manager.getAppWidgetIds(new ComponentName(context, BirdWidgetProvider.class));
        } catch (Exception e) {
            Log.w(TAG, "no widget manager: " + e.getMessage());
            return;
        }
        if (ids == null || ids.length == 0) return;

        BirdJson.Bird bird = BirdJson.fromText(cachedJson(context));
        for (int id : ids) {
            try {
                // A host that draws this widget on the keyguard never gets the step count.
                boolean keyguardHost = NeedsMeWidgetProvider.drawsOnKeyguard(manager, id);
                manager.updateAppWidget(id, build(context, id, bird, keyguardHost));
            } catch (Exception e) {
                // A launcher that refuses one update must not take the others down with it.
                Log.w(TAG, "update failed for " + id + ": " + e.getMessage());
            }
        }
    }

    private static RemoteViews build(Context context, int widgetId, BirdJson.Bird bird, boolean keyguardHost) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bird);

        // A keyguard host draws the bird with walked=false: the walk badge group is dropped from the
        // drawing (never fetched), the same rule as the step count below.
        Bitmap bitmap = bird != null && bird.hasDrawing()
                ? BirdBitmap.render(bird.svg, widgetPixels(context, widgetId), !keyguardHost)
                : null;
        if (bitmap != null) views.setImageViewBitmap(R.id.widget_bird_image, bitmap);
        // The fallback is the app icon: a widget always shows SOMETHING recognisable.
        else views.setImageViewResource(R.id.widget_bird_image, R.mipmap.ic_launcher);

        CharSequence mood;
        if (bird == null) {
            mood = context.getString(R.string.widget_bird_error);
        } else if (BirdJson.SIGN_IN_STATE.equals(bird.state)) {
            mood = context.getString(R.string.widget_bird_sign_in);
        } else if (BirdJson.NO_BIRD_STATE.equals(bird.state)) {
            mood = context.getString(R.string.widget_bird_none);
        } else {
            mood = moodLabel(context, bird.mood);
        }
        if (mood == null || mood.length() == 0) {
            views.setViewVisibility(R.id.widget_bird_mood, View.GONE);
        } else {
            views.setTextViewText(R.id.widget_bird_mood, mood);
            views.setViewVisibility(R.id.widget_bird_mood, View.VISIBLE);
        }

        boolean showSteps = bird != null && bird.hasDrawing() && !keyguardHost;
        if (showSteps) {
            views.setTextViewText(R.id.widget_bird_steps, context.getString(R.string.widget_bird_steps, bird.steps));
            views.setViewVisibility(R.id.widget_bird_steps, View.VISIBLE);
        } else {
            views.setViewVisibility(R.id.widget_bird_steps, View.GONE);
        }

        views.setOnClickPendingIntent(R.id.widget_bird_image, openIntent(context, widgetId));
        views.setOnClickPendingIntent(R.id.widget_bird_mood, openIntent(context, widgetId));
        views.setOnClickPendingIntent(R.id.widget_bird_steps, openIntent(context, widgetId));
        return views;
    }

    /** The bird's mood as the operator's language words it; null when it is a mood we do not know. */
    private static CharSequence moodLabel(Context context, String mood) {
        if ("tired".equals(mood)) return context.getString(R.string.widget_bird_mood_tired);
        if ("alarmed".equals(mood)) return context.getString(R.string.widget_bird_mood_alarmed);
        if ("happy".equals(mood)) return context.getString(R.string.widget_bird_mood_happy);
        return null;
    }

    /** A tap: MainActivity on the bird's Ramble page. */
    private static PendingIntent openIntent(Context context, int widgetId) {
        Intent intent = BirdShortcut.rambleIntent(context);
        return PendingIntent.getActivity(context, widgetId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** How many pixels this widget's drawing gets: the smaller side, so the square fits. */
    private static int widgetPixels(Context context, int widgetId) {
        int dp = FALLBACK_DP;
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            android.os.Bundle options = manager == null ? null : manager.getAppWidgetOptions(widgetId);
            if (options != null) {
                int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
                int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
                if (width > 0 && height > 0) dp = Math.min(width, height);
                else if (width > 0) dp = width;
                else if (height > 0) dp = height;
            }
        } catch (Exception e) {
            Log.w(TAG, "options unreadable for " + widgetId + ": " + e.getMessage());
        }
        float density = context.getResources().getDisplayMetrics().density;
        return Math.max(48, Math.round(dp * density));
    }

    // ---- cache ---------------------------------------------------------

    static String cachedJson(Context context) {
        return prefs(context).getString(CACHE_KEY, null);
    }

    /** Keep the API's answer exactly as the gateway sent it (see BirdJson). */
    static void cacheBird(Context context, String json) {
        if (json == null || json.trim().isEmpty()) return;
        prefs(context).edit().putString(CACHE_KEY, json).apply();
    }

    /** The last refresh found no session: the widget asks for a sign-in until one is found. */
    static void cacheSignIn(Context context) {
        prefs(context).edit().putString(CACHE_KEY, BirdJson.SIGN_IN_JSON).apply();
    }

    /** There is no bird to draw here (no Ramble, or nothing hatched): say so, keep the app icon. */
    static void cacheNoBird(Context context) {
        prefs(context).edit().putString(CACHE_KEY, BirdJson.NO_BIRD_JSON).apply();
    }

    /** The cached bird drawn at {@code sizePx}, or null: the pinned shortcut's icon, and its fallback. */
    static Bitmap cachedBitmap(Context context, int sizePx) {
        BirdJson.Bird bird = BirdJson.fromText(cachedJson(context));
        if (bird == null || !bird.hasDrawing()) return null;
        return BirdBitmap.render(bird.svg, sizePx);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}