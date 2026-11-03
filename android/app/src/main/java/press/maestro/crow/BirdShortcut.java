package press.maestro.crow;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.util.Log;

import java.util.Collections;
import java.util.List;

/**
 * "Your bird" as a pinned launcher shortcut (widgets phase 3): the same drawing the widget shows, and
 * a tap that opens the bird's own page in Ramble.
 *
 * The icon is the bird BITMAP the widget already renders; when there is no bird (signed out, Ramble
 * not installed, no egg hatched, a drawing that could not be parsed) it is the app icon, so pinning
 * always works. BirdRefreshWorker calls {@link #update} whenever the bird's drawing changes, which is
 * how a pinned icon keeps up with a new hat, a new outfit or a new mood — and pinning also starts the
 * half-hourly refresh, so the icon keeps up with no bird widget anywhere.
 *
 * Pinning itself needs the launcher's support (ShortcutManager.isRequestPinShortcutSupported); where
 * there is none, {@link #requestPin} says so and the settings screen tells the operator, rather than
 * failing silently.
 */
final class BirdShortcut {

    private static final String TAG = "BirdShortcut";

    /** The shortcut's id: stable, because updateShortcuts addresses it by name. */
    static final String ID = "your-bird";

    /** Where a tap goes: Ramble's own page — the bird lives there (bundles/ramble's panel). */
    static final String RAMBLE_PATH = "/dashboard/ramble";

    /** A launcher icon this size is plenty (adaptive icons are 108dp at the largest density). */
    static final int ICON_PX = 192;

    private BirdShortcut() {
    }

    /** The tap: MainActivity, opened on the bird's Ramble page (the same action_url a notification uses). */
    static Intent rambleIntent(Context context) {
        return new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("action_url", RAMBLE_PATH)
                // The data URI gives the intent its identity, so it never merges with another shortcut.
                .setData(Uri.parse("crow-shortcut://" + ID));
    }

    /** The shortcut, drawn with {@code bitmap} when there is one and the app icon when there is not. */
    static ShortcutInfo info(Context context, Bitmap bitmap) {
        Icon icon = bitmap == null
                ? Icon.createWithResource(context, R.mipmap.ic_launcher)
                : Icon.createWithBitmap(bitmap);
        return new ShortcutInfo.Builder(context, ID)
                .setShortLabel(context.getString(R.string.widget_bird_shortcut_short))
                .setLongLabel(context.getString(R.string.widget_bird_shortcut_long))
                .setIcon(icon)
                .setIntent(rambleIntent(context))
                .build();
    }

    /** The bird's pixels for a shortcut icon, or null when there is no bird cached. */
    static Bitmap iconBitmap(Context context) {
        return BirdWidgetProvider.cachedBitmap(context, ICON_PX);
    }

    /**
     * Ask the launcher to pin "your bird" (it shows its own confirmation). False when the launcher
     * does not support pinning — or when the request itself failed, which must not crash the screen.
     *
     * A pin also starts the same half-hourly bird refresh the widget schedules (unique name,
     * KEEP, so a widget's own run is never disturbed): a pinned bird keeps updating with no widget on
     * any home screen.
     */
    static boolean requestPin(Activity activity, Bitmap bitmap) {
        try {
            ShortcutManager manager = activity.getSystemService(ShortcutManager.class);
            if (manager == null || !manager.isRequestPinShortcutSupported()) return false;
            manager.requestPinShortcut(info(activity, bitmap), null);
            BirdWidgetProvider.schedulePeriodicRefresh(activity);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "pin not requested: " + e.getMessage());
            return false;
        }
    }

    /** Repaint the pinned shortcut's icon after the bird changed. Silent when it was never pinned. */
    static void update(Context context, Bitmap bitmap) {
        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) return;
            manager.updateShortcuts(Collections.singletonList(info(context, bitmap)));
        } catch (Exception e) {
            // A launcher that refuses the update costs the icon, never the refresh.
            Log.w(TAG, "shortcut not updated: " + e.getMessage());
        }
    }

    /** Whether "your bird" is pinned on a home screen right now (so a refresh has something to do). */
    static boolean isPinned(Context context) {
        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) return false;
            List<ShortcutInfo> pinned = manager.getPinnedShortcuts();
            if (pinned == null) return false;
            for (ShortcutInfo shortcut : pinned) {
                if (shortcut != null && ID.equals(shortcut.getId())) return true;
            }
            return false;
        } catch (Exception e) {
            Log.w(TAG, "pinned shortcuts unreadable: " + e.getMessage());
            return false;
        }
    }
}