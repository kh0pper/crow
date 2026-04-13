package press.maestro.crow;

import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * Quick-Settings tile that toggles a voice turn on the first connected
 * glasses session. Tap once to start listening, tap again to stop.
 *
 * <p>Works from any screen — even the lock screen if the user has QS
 * exposed there. The tile is a thin trigger; all state lives in
 * {@link GlassesService}. We mirror the turn state into an unencrypted
 * SharedPreferences entry ({@code PTT_PREFS}) so the tile can show
 * INACTIVE / ACTIVE accurately without binding to the service.</p>
 */
public class CrowPttTileService extends TileService {

    private static final String TAG = "CrowPttTile";
    public static final String PTT_PREFS = "CrowPttState";
    public static final String KEY_IN_TURN = "in_turn";

    @Override
    public void onStartListening() {
        super.onStartListening();
        refreshTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        boolean inTurn = getSharedPreferences(PTT_PREFS, MODE_PRIVATE).getBoolean(KEY_IN_TURN, false);
        String action = inTurn ? GlassesService.ACTION_END_TURN : GlassesService.ACTION_BEGIN_TURN;
        Intent svc = new Intent(this, GlassesService.class).setAction(action);
        try {
            ContextCompat.startForegroundService(this, svc);
        } catch (Throwable t) {
            Log.w(TAG, "startForegroundService err: " + t.getMessage());
        }
        // Optimistic flip; GlassesService will sync via the same prefs entry
        // on actual state change.
        getSharedPreferences(PTT_PREFS, MODE_PRIVATE).edit().putBoolean(KEY_IN_TURN, !inTurn).apply();
        refreshTile();
    }

    private void refreshTile() {
        Tile tile = getQsTile();
        if (tile == null) return;
        boolean inTurn = getSharedPreferences(PTT_PREFS, MODE_PRIVATE).getBoolean(KEY_IN_TURN, false);
        tile.setState(inTurn ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setLabel(inTurn ? "Listening…" : "Ask Crow");
        tile.setIcon(Icon.createWithResource(this, android.R.drawable.ic_btn_speak_now));
        tile.updateTile();
    }
}
