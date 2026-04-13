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
        Intent svc = new Intent(this, GlassesService.class).setAction(GlassesService.ACTION_BEGIN_TURN);
        try { ContextCompat.startForegroundService(this, svc); } catch (Throwable ignored) {}
        finish();
    }
}
