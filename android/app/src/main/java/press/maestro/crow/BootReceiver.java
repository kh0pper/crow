package press.maestro.crow;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * Starts the ntfy listener service on device boot if a gateway URL is configured.
 * The service will use cached ntfy config (no cookie needed at boot time).
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        SharedPreferences prefs = context.getSharedPreferences("CrowPrefs", Context.MODE_PRIVATE);
        String gatewayUrl = prefs.getString("gateway_url", null);

        if (gatewayUrl != null && !gatewayUrl.isEmpty()) {
            Intent serviceIntent = new Intent(context, NtfyListenerService.class);
            ContextCompat.startForegroundService(context, serviceIntent);

            // Restart GlassesService for each paired device so the voice
            // loop + /session WebSocket come back up automatically on
            // boot (no need to open the pair screen again).
            try {
                for (String id : GlassesTokenStore.listDeviceIds(context)) {
                    Intent glassesIntent = new Intent(context, GlassesService.class);
                    glassesIntent.putExtra(GlassesService.EXTRA_DEVICE_ID, id);
                    ContextCompat.startForegroundService(context, glassesIntent);
                }
            } catch (Exception ignored) {}
        }
    }
}
