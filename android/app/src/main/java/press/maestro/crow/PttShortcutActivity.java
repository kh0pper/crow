package press.maestro.crow;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

/**
 * Invisible activity that fires {@link GlassesService#ACTION_BEGIN_TURN}
 * and finishes immediately. Used as the target of a static app shortcut
 * ("Ask Crow") so the user can long-press the Crow launcher icon and
 * start a voice turn without navigating into the app.
 *
 * <p>The user ends the turn via the notification "Stop" action or the
 * QS tile. Consistent with the notification-button UX introduced in
 * PR 6 (notification PTT).</p>
 */
public class PttShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean inTurn = getSharedPreferences(CrowPttTileService.PTT_PREFS, MODE_PRIVATE)
                .getBoolean(CrowPttTileService.KEY_IN_TURN, false);
        String action = inTurn ? GlassesService.ACTION_END_TURN : GlassesService.ACTION_BEGIN_TURN;
        Intent svc = new Intent(this, GlassesService.class).setAction(action);
        try { ContextCompat.startForegroundService(this, svc); } catch (Throwable ignored) {}
        finish();
    }
}
